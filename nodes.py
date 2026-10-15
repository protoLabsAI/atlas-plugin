"""Finding a Node.js to run the layout engine with — and telling the operator when there's none.

The engine (``vendor/atlas-engine.mjs``) is plain ESM that needs Node >= 20. The node on the
server's PATH is often missing or too old: a macOS GUI app inherits a bare PATH, and the
Docker runtime ships no node at all. Resolution order:

1. config ``node_path`` (when set and usable);
2. ``node`` on PATH, when ``--version`` is >= 20;
3. protoAgent's managed Node runtime (ADR 0085, ``infra.node_runtime.managed_node_bin_dir``
   — lazy + guarded, so the suite runs host-free).

No usable node raises a setup gap (``registry.report_setup_gap("node", …)``) whose banner
carries an **Install Node runtime** button — a ``plugin_setup`` step that runs core's managed
installer (``runtime.node_install.install_managed_node``) on a thread — plus a shortcut to the
``node_path`` setting. The gap clears itself the next time a node is found.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
from dataclasses import asdict, dataclass
from pathlib import Path

log = logging.getLogger("protoagent.plugins.atlas")

MIN_MAJOR = 20
VERSION_TIMEOUT = 5.0
GAP_KEY = "node"
STEP_INSTALL_NODE = "install-node"

_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")
# (path, mtime_ns, size) -> version string ("" when it wouldn't run). Re-probing on every 2 s
# viewer poll would fork node each time; a changed binary changes its stat, so this stays right.
_version_cache: dict[tuple[str, int, int], str] = {}
_cache_lock = threading.Lock()


@dataclass
class NodeInfo:
    path: str = ""
    version: str = ""
    ok: bool = False
    source: str = ""  # "config" | "path" | "managed" | "" (none found)
    error: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def parse_major(version: str) -> int | None:
    m = _VERSION_RE.match((version or "").strip())
    return int(m.group(1)) if m else None


def node_version(path: str) -> str:
    """``node --version`` of an executable ("v22.3.0"), or "" when it won't run. Cached by stat."""
    try:
        st = os.stat(path)
    except OSError:
        return ""
    key = (path, st.st_mtime_ns, st.st_size)
    with _cache_lock:
        if key in _version_cache:
            return _version_cache[key]
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=VERSION_TIMEOUT, check=False)
        version = out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        version = ""
    with _cache_lock:
        _version_cache[key] = version
    return version


def _managed_bin_dir() -> Path | None:
    """Core's managed Node bin dir (ADR 0085), or None — no host, an older host, or not installed."""
    try:
        from infra.node_runtime import managed_node_bin_dir
    except Exception:  # noqa: BLE001 — host-free (tests) or a host without the managed runtime
        return None
    try:
        return managed_node_bin_dir()
    except Exception:  # noqa: BLE001 — a broken instance root must not take resolution down
        log.debug("[atlas] managed node lookup failed", exc_info=True)
        return None


def _exe_name() -> str:
    return "node.exe" if os.name == "nt" else "node"


def _check(path: str, source: str) -> NodeInfo:
    version = node_version(path)
    major = parse_major(version)
    if major is None:
        return NodeInfo(path=path, source=source, error=f"{path} did not run (`--version` failed)")
    if major < MIN_MAJOR:
        return NodeInfo(
            path=path, version=version, source=source, error=f"{path} is {version}; Atlas needs Node {MIN_MAJOR}+"
        )
    return NodeInfo(path=path, version=version, ok=True, source=source)


def resolve_node(node_path: str = "") -> NodeInfo:
    """The node to run the engine with, by the documented order. ``ok`` False when none works;
    ``error`` then explains every candidate that was tried."""
    tried: list[str] = []
    managed = _managed_bin_dir()

    configured = (node_path or "").strip()
    if configured:
        exe = os.path.expanduser(os.path.expandvars(configured))
        found = shutil.which(exe) if not os.path.isabs(exe) else (exe if os.path.isfile(exe) else None)
        if found:
            info = _check(os.path.abspath(found), "config")
            if info.ok:
                return info
            tried.append(f"node_path: {info.error}")
        else:
            tried.append(f"node_path: {configured} not found")

    on_path = shutil.which("node")
    if on_path:
        on_path = os.path.abspath(on_path)
        # Core appends the managed bin dir to PATH once it's installed — name it honestly.
        source = "managed" if managed is not None and Path(on_path).parent == managed else "path"
        info = _check(on_path, source)
        if info.ok:
            return info
        tried.append(f"PATH: {info.error}")
    else:
        tried.append("PATH: no node")

    if managed is not None:
        exe = managed / _exe_name()
        if exe.is_file():
            info = _check(str(exe), "managed")
            if info.ok:
                return info
            tried.append(f"managed runtime: {info.error}")
    else:
        tried.append("managed runtime: not installed")

    return NodeInfo(error="; ".join(tried))


# ── setup gap + the "Install Node runtime" step ─────────────────────────────────────────────


def _gap_actions() -> list[dict]:
    return [
        {"kind": "plugin_setup", "step": STEP_INSTALL_NODE, "label": "Install Node runtime"},
        {"kind": "plugin_config", "label": "Set Node.js path", "fields": ["node_path"]},
    ]


def gap_message(info: NodeInfo) -> str:
    return (
        f"Atlas needs Node.js {MIN_MAJOR} or newer to lay out diagrams, and none was found "
        f"({info.error or 'no node'}). Install protoAgent's managed Node runtime, or point "
        "Atlas at a node in its settings."
    )


class NodeGap:
    """Reports / clears the ``node`` setup gap — only on a change, so a 2 s poll doesn't spam."""

    def __init__(self, registry=None):
        self._registry = registry
        self._last: str | None = None  # last reported message ("" = cleared)
        self._lock = threading.Lock()
        self.install: dict = {"state": "idle", "pct": 0, "error": ""}

    def _report(self, message: str | None, action=None) -> None:
        fn = getattr(self._registry, "report_setup_gap", None)
        if not callable(fn):
            return
        try:
            if action is None:
                fn(GAP_KEY, message, label="Atlas")
            else:
                fn(GAP_KEY, message, label="Atlas", action=action)
        except Exception:  # noqa: BLE001 — a banner must never break the engine path
            log.exception("[atlas] reporting the node setup gap failed")

    def update(self, info: NodeInfo) -> None:
        """Raise the gap for a missing node, clear it once one is found."""
        with self._lock:
            if self.install.get("state") == "running":
                return  # the install thread owns the banner until it finishes
            want = "" if info.ok else gap_message(info)
            if want == self._last:
                return
            self._last = want
        if info.ok:
            self._report(None)
        else:
            self._report(want, action=_gap_actions())

    def start_install(self, recheck) -> dict:
        """The ``install-node`` setup step: run core's managed Node installer on a daemon thread.
        Returns at once with ``pending``; the thread re-checks (clearing the gap) when it's done.
        Idempotent — a second click while one runs joins it."""
        try:
            from runtime.node_install import NodeRuntimeError, install_managed_node, is_supported
        except Exception:  # noqa: BLE001 — a host without the managed runtime
            return {
                "ok": False,
                "message": "This protoAgent can't install a managed Node — install Node 20+ yourself or set Atlas's Node.js path.",
            }
        if not is_supported():
            return {
                "ok": False,
                "message": "There is no managed Node build for this platform — install Node 20+ yourself.",
            }
        with self._lock:
            if self.install.get("state") == "running":
                return {"ok": True, "pending": True, "message": "Already installing the Node runtime."}
            self.install = {"state": "running", "pct": 0, "error": ""}
            self._last = None

        def _progress(done: int, total: int) -> None:
            pct = int(done * 100 / total) if total else 0
            if pct >= self.install.get("pct", 0) + 10 or pct == 100:
                self.install["pct"] = pct
                self._report(f"Installing the Node runtime for Atlas… {pct}%")

        def _run() -> None:
            try:
                install_managed_node(on_progress=_progress)
                with self._lock:
                    self.install = {"state": "done", "pct": 100, "error": ""}
            except NodeRuntimeError as exc:
                with self._lock:
                    self.install = {"state": "error", "pct": 0, "error": str(exc)}
            except Exception as exc:  # noqa: BLE001 — a thread crash must land as state
                log.exception("[atlas] managed node install failed")
                with self._lock:
                    self.install = {"state": "error", "pct": 0, "error": str(exc)}
            info = recheck()
            if not info.ok and self.install.get("error"):
                self._report(f"Installing the Node runtime failed: {self.install['error']}", action=_gap_actions())
                with self._lock:
                    self._last = None

        self._report("Installing the Node runtime for Atlas…")
        threading.Thread(target=_run, name="atlas-node-install", daemon=True).start()
        return {
            "ok": True,
            "pending": True,
            "message": "Installing the Node runtime — the banner clears when it's ready.",
        }
