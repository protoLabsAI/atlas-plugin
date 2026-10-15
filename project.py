"""Which project the model describes, and where its model directory is.

protoAgent has no single "active project": the agent's files are fenced into the registered
filesystem projects (ADR 0007, ``tools.fs_tools.live_project_registry``) and the console has its
own project root (``/api/runtime/status`` → ``project.path``: ``PROTOAGENT_PROJECT_DIR``, else
``operator.project_dir``). Atlas picks, in order:

1. config ``project`` — a registered filesystem project, by name;
2. the registered project whose root holds the console's project root;
3. the first registered project;
4. no filesystem toolset: the console's project root (env / config), else the process cwd.

The project NAME matters to the viewer: a code link opens in the console's code pane as
``{project, path, line}`` (``protoagent:code:open``), which the pane resolves through the same
fence. Host lookups are lazy + guarded and module-level so tests substitute them.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("protoagent.plugins.atlas")

DEFAULT_MODEL_DIR = "architecture"


@dataclass(frozen=True)
class ProjectRef:
    name: str  # the filesystem project's name ("" when the host has no fs registry)
    root: Path


def _host_config():
    """The live host config object, or None (no host / not started)."""
    try:
        from graph.plugins.host import HOST

        if HOST.config is not None:
            return HOST.config()
    except Exception:  # noqa: BLE001
        pass
    try:
        from runtime.state import STATE

        return getattr(STATE, "graph_config", None)
    except Exception:  # noqa: BLE001
        return None


def _fs_registry():
    """The fs fence as the fs tools see it right now, or None (no host / no fs toolset)."""
    try:
        from tools.fs_tools import live_project_registry
    except Exception:  # noqa: BLE001
        return None
    try:
        return live_project_registry(_host_config())
    except Exception:  # noqa: BLE001
        log.debug("[atlas] reading the project registry failed", exc_info=True)
        return None


def _console_root() -> Path | None:
    env = os.environ.get("PROTOAGENT_PROJECT_DIR", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    cfg = _host_config()
    configured = str(getattr(cfg, "operator_project_dir", "") or "").strip() if cfg is not None else ""
    if configured and Path(configured).expanduser().is_dir():
        return Path(configured).expanduser().resolve()
    return None


def _within(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def resolve_project(cfg: dict | None) -> ProjectRef:
    want = str((cfg or {}).get("project") or "").strip()
    registry = _fs_registry()
    names = list(registry.names()) if registry is not None else []
    projects = []
    for n in names:
        p = registry.get(n)
        if p is not None:
            projects.append(ProjectRef(name=n, root=Path(p.root).resolve()))
    if want:
        for p in projects:
            if p.name == want:
                return p
        log.warning("[atlas] configured project %r is not a registered filesystem project", want)
    console = _console_root()
    if console is not None:
        for p in projects:
            if _within(console, p.root):
                return p
    if projects:
        return projects[0]
    return ProjectRef(name="", root=console or Path.cwd().resolve())


def model_dir_for(project: ProjectRef, cfg: dict | None) -> Path:
    raw = str((cfg or {}).get("model_dir") or DEFAULT_MODEL_DIR).strip()
    path = Path(os.path.expandvars(raw)).expanduser()
    if not path.is_absolute():
        path = project.root / path
    return path.resolve()
