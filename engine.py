"""Running the layout engine, and the per-model-dir cache behind ``GET /model``.

``node vendor/atlas-engine.mjs validate|export <dir>`` prints one JSON object
(``{ok, errors:[{message,file,line}], ms, model?}``) and exits 0 even when the model has
errors; non-zero means the engine itself crashed. It always runs as ``<absolute node>
<engine> …`` (never via a shebang), in a subprocess with a timeout, off the event loop.

The cache is keyed by a hash of the model dir's files (path + mtime + size), so the viewer's
2 s ETag poll costs one directory walk. Exports for one dir are serialised by a lock, so a burst
of requests runs the engine once. The last GOOD export is kept in memory and in the plugin's
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
_SKIP_DIRS = {"node_modules", ".git", ".likec4", "dist", "__pycache__", ".venv"}
_MAX_FILES = 5000


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


def dir_hash(model_dir: Path, *salt: str) -> str:
    """A short hash of every file under the model dir (relative path + mtime_ns + size), plus
    ``salt`` (project root, engine stamp). Changes whenever a file is added/removed/edited."""
    h = hashlib.sha256()
    for s in salt:
        h.update(s.encode())
        h.update(b"\0")
    entries = []
    for dirpath, dirnames, filenames in os.walk(model_dir):
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_DIRS and not d.startswith("."))
        for name in filenames:
            p = Path(dirpath) / name
            try:
                st = p.stat()
            except OSError:
                continue
            entries.append(f"{p.relative_to(model_dir).as_posix()}\0{st.st_mtime_ns}\0{st.st_size}")
            if len(entries) >= _MAX_FILES:
                break
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
        self._entries: dict[str, dict] = {}  # model_dir → {"hash", "payload", "current"}
        self._last_good: dict[str, dict] = {}  # model_dir → {"model", "tours", "hash", "ms"}

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

    # ── last good (memory + store) ─────────────────────────────────────────────────────────

    def _store_path(self, model_dir: Path) -> Path | None:
        if self.store_dir is None:
            return None
        key = hashlib.sha256(str(model_dir).encode()).hexdigest()[:16]
        return Path(self.store_dir) / "last_good" / f"{key}.json"

    def last_good(self, model_dir: Path) -> dict | None:
        key = str(model_dir)
        if key in self._last_good:
            return self._last_good[key]
        path = self._store_path(model_dir)
        if path is not None and path.is_file():
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(doc, dict) and isinstance(doc.get("model"), dict):
                    self._last_good[key] = doc
                    return doc
            except (OSError, json.JSONDecodeError):
                log.warning("[atlas] unreadable last-good cache %s", path)
        return None

    def _save_good(self, model_dir: Path, good: dict) -> None:
        self._last_good[str(model_dir)] = good
        path = self._store_path(model_dir)
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

    def _lock_for(self, model_dir: Path) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(str(model_dir), threading.Lock())

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

    def _failure(self, message: str, *, kind: str, h: str, model_dir: Path, project: ProjectRef) -> dict:
        """A payload for a failure that isn't the model's fault (no node, an engine crash) —
        serving the last good model when there is one. Never cached; its hash carries ``kind``
        so a client holding the ETag refetches once the failure clears."""
        good = self.last_good(model_dir)
        return self._payload(
            ok=False,
            errors=[{"message": message}],
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

    def _get(self) -> tuple[dict, dict | None]:
        project, model_dir = self.locate()
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
                h="missing-" + hashlib.sha256(str(model_dir).encode()).hexdigest()[:12],
                model_dir=model_dir,
                project=project,
                ms=0,
                stale=False,
                exists=False,
            )
            return payload, None
        h = dir_hash(model_dir, str(project.root), project.name, _engine_stamp(self.engine))
        key = str(model_dir)
        entry = self._entries.get(key)
        if entry and entry["hash"] == h:
            return entry["payload"], entry["current"]
        with self._lock_for(model_dir):
            entry = self._entries.get(key)
            if entry and entry["hash"] == h:  # another request exported it while we waited
                return entry["payload"], entry["current"]
            node = self.node()
            if not node.ok:
                return self._failure(
                    f"Node.js 20+ not found ({node.error}) — install the managed Node runtime from the setup banner, or set Atlas's Node.js path.",
                    kind="nonode",
                    h=h,
                    model_dir=model_dir,
                    project=project,
                ), None
            started = time.monotonic()
            try:
                raw = run_engine(node.path, "export", model_dir, timeout=self.timeout, engine=self.engine)
            except EngineError as exc:
                log.warning("[atlas] engine failed on %s: %s", model_dir, exc)
                return self._failure(str(exc), kind="engine", h=h, model_dir=model_dir, project=project), None
            ms = int(raw.get("ms") or (time.monotonic() - started) * 1000)
            model = raw.get("model") if isinstance(raw.get("model"), dict) else None
            if model is not None:
                normalize_model(model, project_root=project.root, model_dir=model_dir)
            errors = _rel_errors(raw.get("errors"), project.root, model_dir)
            tours, tour_errors = L.read_tours(model_dir)
            tour_errors = _rel_errors(tour_errors, project.root, model_dir)
            engine_ok = bool(raw.get("ok")) and model is not None
            if engine_ok:
                self._save_good(model_dir, {"model": model, "tours": tours, "hash": h, "ms": ms})
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
                good = self.last_good(model_dir)
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
            current = model if model is not None else (self.last_good(model_dir) or {}).get("model")
            self._entries[key] = {"hash": h, "payload": payload, "current": current, "tours": tours}
            return payload, current

    def current_tours(self) -> dict | None:
        _project, model_dir = self.locate()
        return L.read_tours(model_dir)[0] if model_dir.is_dir() else None
