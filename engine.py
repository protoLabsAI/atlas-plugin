"""Running the layout engine, and the per-model-dir cache behind ``GET /model``.

``node vendor/atlas-engine.mjs validate|export <dir>`` prints one JSON object
(``{ok, errors:[{message,file,line}], ms, model?}``) and exits 0 even when the model has
errors; non-zero means the engine itself crashed. It always runs as ``<absolute node>
<engine> …`` (never via a shebang), in a subprocess with a timeout, off the event loop.

The cache is keyed by a hash of exactly the files the engine reads (path + mtime + size), so the
viewer's 2 s ETag poll costs one directory walk. A model dir whose config ``include`` or a symlink
reaches outside it is refused before the engine runs. Exports for one (project, model dir) are
serialised by a lock, so a burst of requests runs the engine once; a crashing or timing-out
engine is retried with backoff, not on every poll. The last GOOD export is kept in memory and in the plugin's
store (``sdk.plugin_store``): while the sources have errors, ``/model`` keeps serving it with
``ok:false, stale:true`` and the errors, so the diagram never blanks mid-edit.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path

from . import lint as L
from .links import normalize_model
from .nodes import NodeInfo, resolve_node
from .project import ProjectRef, model_dir_for, resolve_project

log = logging.getLogger("protoagent.plugins.atlas")

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "vendor" / "atlas-engine.mjs"
ENGINE_REL = "vendor/atlas-engine.mjs"
TIMEOUT = 20.0


class EngineError(RuntimeError):
    """The engine crashed, timed out, or printed something that isn't its JSON."""


def run_engine(node: str, command: str, model_dir: Path, *, timeout: float = TIMEOUT, engine: Path = ENGINE) -> dict:
    """Run one engine command and return its parsed JSON. Blocking — call off the loop."""
    if command not in ("validate", "export"):
        raise ValueError(f"unknown engine command {command!r}")
    try:
        proc = subprocess.run(
            [node, str(engine), command, str(model_dir)],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(engine.parent),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise EngineError(f"the layout engine timed out after {timeout:.0f}s") from exc
    except OSError as exc:
        raise EngineError(f"could not start the layout engine: {exc}") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        raise EngineError(f"the layout engine crashed (exit {proc.returncode}): " + " / ".join(tail))
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise EngineError(f"the layout engine printed invalid JSON: {exc.msg}") from exc
    if not isinstance(out, dict):
        raise EngineError("the layout engine printed something other than a JSON object")
    return out


# What the engine reads (LikeC4 1.60 language-server): every file with a LikeC4 extension under
# the workspace, recursively, following symlinks, skipping only these directory names — plus the
# project config. Hashing exactly that set means an edit the engine would see always changes the
# hash, and nothing the engine ignores (a build dir, an editor swap file) busts the cache.
_ENGINE_SKIP_DIRS = {"node_modules", ".git", ".svn", ".yarn", ".pnpm"}
_LIKEC4_EXTS = (".c4", ".likec4", ".like-c4")
_JSON_CONFIGS = {"likec4.config.json", ".likec4rc", ".likec4.config.json"}
_MAX_FILES = 5000
MAX_ERROR_CHARS = 300
NODE_RETRY = 5.0  # s before re-probing for node after "none found"
ENGINE_RETRY = 5.0  # s before re-running a crashed / timed-out engine (doubles per failure)
BACKOFF_MAX = 60.0


def _clip(msg: str, limit: int = MAX_ERROR_CHARS) -> str:
    msg = str(msg or "")
    return msg if len(msg) <= limit else msg[: limit - 1].rstrip() + "…"


def _is_engine_input(name: str) -> bool:
    if name == L.TOURS_FILE or name in _JSON_CONFIGS or name.startswith("likec4.config."):
        return True
    return any(name.endswith(ext) and name != ext for ext in _LIKEC4_EXTS)


def _inside(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def _check_include(config: Path, model_root: Path) -> str | None:
    """A config's ``include.paths`` must stay inside the model dir — otherwise the engine would
    read (and render) arbitrary ``.c4`` files from elsewhere on disk. Returns the problem, if any."""
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        doc = json.loads(text)
    except json.JSONDecodeError:
        # The engine reads JSON5; if plain JSON can't parse it we can't vet an include — refuse it.
        return f"{config.name}: can't verify its `include` (not strict JSON)" if "include" in text else None
    inc = doc.get("include") if isinstance(doc, dict) else None
    if inc is None:
        return None
    paths = inc.get("paths") if isinstance(inc, dict) else inc
    if not isinstance(paths, list):
        return f'{config.name}: `include` must be {{"paths": [...]}}'
    for raw in paths:
        if not isinstance(raw, str):
            return f"{config.name}: include path {raw!r} is not a string"
        target = (config.parent / raw).resolve()
        if not _inside(target, model_root):
            return f"{config.name}: include path {raw!r} leaves the model directory — Atlas only reads the model's own folder"
    return None


def scan_model_dir(model_dir: Path) -> tuple[list[str], list[str]]:
    """``(entries, problems)`` — one ``path\\0mtime\\0size`` entry per file the engine reads, and
    reasons the model must not be handed to the engine (an ``include`` or a symlink leaving the
    model dir, too many files)."""
    root = model_dir.resolve()
    entries: list[str] = []
    problems: list[str] = []
    seen_dirs: set[Path] = set()
    for dirpath, dirnames, filenames in os.walk(model_dir, followlinks=True):
        here = Path(dirpath)
        real = here.resolve()
        if not _inside(real, root):
            problems.append(f"{here.relative_to(model_dir).as_posix()} is a symlink leaving the model directory")
            dirnames[:] = []
            continue
        if real in seen_dirs:  # a symlink loop
            dirnames[:] = []
            continue
        seen_dirs.add(real)
        dirnames[:] = sorted(d for d in dirnames if d not in _ENGINE_SKIP_DIRS)
        for name in sorted(filenames):
            if not _is_engine_input(name):
                continue
            p = here / name
            try:
                rp = p.resolve()
                st = p.stat()
            except OSError:
                continue
            rel = p.relative_to(model_dir).as_posix()
            if not _inside(rp, root):
                problems.append(f"{rel} is a symlink leaving the model directory")
                continue
            if name in _JSON_CONFIGS:
                bad = _check_include(p, root)
                if bad:
                    problems.append(f"{rel.rsplit('/', 1)[0] + '/' if '/' in rel else ''}{bad}")
            entries.append(f"{rel}\0{st.st_mtime_ns}\0{st.st_size}")
            if len(entries) > _MAX_FILES:
                problems.append(f"the model directory holds more than {_MAX_FILES} model files")
                return entries, problems
    return entries, problems


def dir_hash(model_dir: Path, *salt: str, entries: list[str] | None = None) -> str:
    """A short hash of the engine's inputs under the model dir (relative path + mtime_ns + size),
    plus ``salt`` (project root, engine stamp). Changes whenever an input is added/removed/edited."""
    if entries is None:
        entries = scan_model_dir(model_dir)[0]
    h = hashlib.sha256()
    for s in salt:
        h.update(s.encode())
        h.update(b"\0")
    for e in sorted(entries):
        h.update(e.encode())
        h.update(b"\n")
    return h.hexdigest()[:20]


def _engine_stamp(engine: Path) -> str:
    try:
        st = engine.stat()
        return f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return "missing"


def _rel_errors(errors, project_root: Path, model_dir: Path) -> list[dict]:
    """Engine errors with ``file`` relative to the project root (or the model dir) when inside it."""
    out = []
    for e in errors or []:
        if not isinstance(e, dict):
            continue
        e = dict(e)
        e["message"] = _clip(e.get("message"))  # a parser error can list every expected token (~170 KB)
        f = e.get("file")
        if isinstance(f, str) and f:
            p = Path(f)
            for base in (project_root, model_dir):
                try:
                    e["file"] = p.resolve().relative_to(base.resolve()).as_posix()
                    break
                except (ValueError, OSError):
                    continue
        out.append(e)
    return out


class AtlasService:
    """Resolves the project + node, runs the engine, caches exports and the last good model."""

    def __init__(
        self, conf=None, *, store_dir: Path | None = None, gap=None, engine: Path = ENGINE, timeout: float = TIMEOUT
    ):
        self._conf = conf if callable(conf) else (lambda: conf or {})
        self.store_dir = store_dir
        self.gap = gap
        self.engine = engine
        self.timeout = timeout
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._entries: dict[str, dict] = {}  # key → {"hash", "payload", "current", "retry_at"?}
        self._last_good: dict[str, dict] = {}  # key → {"model", "tours", "hash", "ms"}

    # ── config / resolution ────────────────────────────────────────────────────────────────

    def conf(self) -> dict:
        try:
            return dict(self._conf() or {})
        except Exception:  # noqa: BLE001 — a broken config read must not take the view down
            log.warning("[atlas] reading config failed; using defaults", exc_info=True)
            return {}

    def locate(self) -> tuple[ProjectRef, Path]:
        cfg = self.conf()
        project = resolve_project(cfg)
        return project, model_dir_for(project, cfg)

    def node(self) -> NodeInfo:
        info = resolve_node(str(self.conf().get("node_path") or ""))
        if self.gap is not None:
            self.gap.update(info)
        return info

    def status(self) -> dict:
        project, model_dir = self.locate()
        return {
            "node": {k: v for k, v in self.node().to_dict().items() if k != "error" or v},
            "model_dir": str(model_dir),
            "exists": model_dir.is_dir(),
            "engine": ENGINE_REL,
            "engine_present": self.engine.is_file(),
            "project": project.name,
            "project_root": str(project.root),
        }

    # ── last good (memory + store), keyed by (project root, model dir) ─────────────────────

    @staticmethod
    def _key(project: ProjectRef, model_dir: Path) -> str:
        return f"{project.root}\0{model_dir}"

    def _store_path(self, key: str) -> Path | None:
        if self.store_dir is None:
            return None
        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        return Path(self.store_dir) / "last_good" / f"{digest}.json"

    def last_good(self, key: str) -> dict | None:
        if key in self._last_good:
            return self._last_good[key]
        path = self._store_path(key)
        if path is not None and path.is_file():
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(doc, dict) and isinstance(doc.get("model"), dict):
                    self._last_good[key] = doc
                    return doc
            except (OSError, json.JSONDecodeError):
                log.warning("[atlas] unreadable last-good cache %s", path)
        return None

    def _save_good(self, key: str, good: dict) -> None:
        self._last_good[key] = good
        path = self._store_path(key)
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(good), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            log.warning("[atlas] could not persist the last good model to %s", path, exc_info=True)

    # ── the model ─────────────────────────────────────────────────────────────────────────

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    def _payload(self, *, ok, errors, model, tours, h, model_dir, project, ms, stale, exists=True) -> dict:
        return {
            "ok": ok,
            "errors": errors,
            "model": model,
            "tours": tours,
            "hash": h,
            "model_dir": str(model_dir),
            "project_root": str(project.root),
            "project": project.name,
            "exists": exists,
            "ms": ms,
            "stale": stale,
        }

    def _failure(
        self, messages: list[str], *, kind: str, h: str, key: str, model_dir: Path, project: ProjectRef
    ) -> dict:
        """A payload for a failure that isn't a model error (no node, an engine crash, a model dir
        Atlas refuses) — serving the last good model when there is one. Its hash carries ``kind``
        so a client holding the ETag refetches once the failure clears."""
        good = self.last_good(key)
        return self._payload(
            ok=False,
            errors=[{"message": _clip(m)} for m in messages],
            model=good["model"] if good else None,
            tours=good.get("tours") if good else None,
            h=f"{h}-{kind}",
            model_dir=model_dir,
            project=project,
            ms=0,
            stale=good is not None,
        )

    def get(self) -> dict:
        """The ``/model`` payload. Blocking (may run the engine) — call off the event loop."""
        return self._get()[0]

    def current(self) -> tuple[dict, dict | None]:
        """``(payload, current_model)`` — the current model is the fresh export even when it has
        errors (for lint/describe), else the last good one."""
        return self._get()

    def _cached(self, key: str, h: str):
        entry = self._entries.get(key)
        if not entry or entry["hash"] != h:
            return None
        if entry.get("retry_at") is not None and time.monotonic() >= entry["retry_at"]:
            return None  # a transient failure whose backoff has elapsed — try again
        return entry["payload"], entry["current"]

    def _remember(self, key: str, h: str, payload: dict, current, *, retry_in: float | None = None) -> None:
        prev = self._entries.get(key)
        failures = (prev.get("failures", 0) + 1) if (retry_in is not None and prev and prev["hash"] == h) else 1
        entry = {"hash": h, "payload": payload, "current": current}
        if retry_in is not None:
            # Back off a failing engine: 5 s, 10 s, 20 s … up to a minute, per unchanged sources —
            # so a 2 s poll can't re-run a crashing (or 20 s-timeout) engine back to back.
            entry["failures"] = failures
            entry["retry_at"] = time.monotonic() + min(retry_in * (2 ** (failures - 1)), BACKOFF_MAX)
        self._entries[key] = entry

    def _get(self) -> tuple[dict, dict | None]:
        project, model_dir = self.locate()
        key = self._key(project, model_dir)
        if not model_dir.is_dir():
            payload = self._payload(
                ok=False,
                errors=[
                    {
                        "message": f"No architecture model at {model_dir} — create it (see the atlas skill) or set Atlas's model directory."
                    }
                ],
                model=None,
                tours=None,
                h="missing-" + hashlib.sha256(key.encode()).hexdigest()[:12],
                model_dir=model_dir,
                project=project,
                ms=0,
                stale=False,
                exists=False,
            )
            return payload, None
        entries, problems = scan_model_dir(model_dir)
        h = dir_hash(model_dir, str(project.root), project.name, _engine_stamp(self.engine), entries=entries)
        hit = self._cached(key, h)
        if hit:
            return hit
        with self._lock_for(key):
            hit = self._cached(key, h)
            if hit:  # another request exported it while we waited
                return hit
            if problems:
                payload = self._failure(problems, kind="refused", h=h, key=key, model_dir=model_dir, project=project)
                self._remember(key, h, payload, None)
                return payload, None
            node = self.node()
            if not node.ok:
                payload = self._failure(
                    [
                        f"Node.js 20+ not found ({node.error}) — install the managed Node runtime from the setup banner, or set Atlas's Node.js path."
                    ],
                    kind="nonode",
                    h=h,
                    key=key,
                    model_dir=model_dir,
                    project=project,
                )
                self._remember(key, h, payload, None, retry_in=NODE_RETRY)
                return payload, None
            started = time.monotonic()
            try:
                raw = run_engine(node.path, "export", model_dir, timeout=self.timeout, engine=self.engine)
            except EngineError as exc:
                log.warning("[atlas] engine failed on %s: %s", model_dir, exc)
                payload = self._failure([str(exc)], kind="engine", h=h, key=key, model_dir=model_dir, project=project)
                self._remember(key, h, payload, None, retry_in=ENGINE_RETRY)
                return payload, None
            ms = int(raw.get("ms") or (time.monotonic() - started) * 1000)
            model = raw.get("model") if isinstance(raw.get("model"), dict) else None
            if model is not None:
                normalize_model(model, project_root=project.root, model_dir=model_dir)
            errors = _rel_errors(raw.get("errors"), project.root, model_dir)
            tours, tour_errors = L.read_tours(model_dir)
            tour_errors = _rel_errors(tour_errors, project.root, model_dir)
            engine_ok = bool(raw.get("ok")) and model is not None
            if engine_ok:
                self._save_good(key, {"model": model, "tours": tours, "hash": h, "ms": ms})
                payload = self._payload(
                    ok=not tour_errors,
                    errors=tour_errors,
                    model=model,
                    tours=tours,
                    h=h,
                    model_dir=model_dir,
                    project=project,
                    ms=ms,
                    stale=False,
                )
            else:
                good = self.last_good(key)
                payload = self._payload(
                    ok=False,
                    errors=errors + tour_errors,
                    model=good["model"] if good else None,
                    tours=(good.get("tours") if good else None),
                    h=h,
                    model_dir=model_dir,
                    project=project,
                    ms=ms,
                    stale=good is not None,
                )
            current = model if model is not None else (self.last_good(key) or {}).get("model")
            self._remember(key, h, payload, current)
            return payload, current

    def current_tours(self) -> dict | None:
        _project, model_dir = self.locate()
        return L.read_tours(model_dir)[0] if model_dir.is_dir() else None
