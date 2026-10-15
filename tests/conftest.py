"""Test bootstrap — register the repo as the ``atlas`` package so the modules' relative imports
(``from .engine import …``) resolve with no protoAgent host. Executing ``__init__.py`` is safe:
its host-only imports live inside functions, guarded.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PKG = "atlas"
EXAMPLE = ROOT / "examples" / "protoagent"

if PKG not in sys.modules:
    _spec = importlib.util.spec_from_file_location(PKG, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    assert _spec and _spec.loader
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules[PKG] = _mod
    _spec.loader.exec_module(_mod)


def _system_node_ok() -> bool:
    node = shutil.which("node")
    if not node:
        return False
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout
        return int(out.strip().lstrip("v").split(".")[0]) >= 20
    except Exception:  # noqa: BLE001
        return False


NODE_OK = _system_node_ok()
needs_node = pytest.mark.skipif(not NODE_OK, reason="needs Node >= 20 on PATH to run the real engine")


class _Registry:
    """A fake registry — records what register() contributes, with no host."""

    plugin_id = "atlas"

    def __init__(self, config=None):
        self.config = dict(config or {})
        self.tools, self.routers, self.skill_dirs = [], [], []
        self.emitted, self.navigations, self.gaps, self.steps = [], [], [], {}
        self.handlers: dict[str, list] = {}

    def live_config(self):
        return self.config

    def register_tool(self, t):
        self.tools.append(t)

    def register_tools(self, ts):
        self.tools.extend(ts)

    def register_router(self, router, prefix=""):
        self.routers.append((prefix, router))

    def register_skill_dir(self, path):
        self.skill_dirs.append(path)

    def register_setup_step(self, step, fn):
        self.steps[step] = fn

    def report_setup_gap(self, key, message, *, label=None, action=None):
        self.gaps.append({"key": key, "message": message, "label": label, "action": action})

    def emit(self, topic, data=None):
        self.emitted.append((topic, data or {}))

    def navigate(self, view=""):
        self.navigations.append(view)

    def on(self, topic, handler):
        self.handlers.setdefault(topic, []).append(handler)


@pytest.fixture
def registry():
    return _Registry()


@pytest.fixture
def project(tmp_path, monkeypatch):
    """A throwaway project: the protoAgent example model under ``architecture/`` plus the source
    files a few of its code links point at. The console project root points at it (no host fs
    registry), so ``model_dir: architecture`` resolves into it."""
    root = tmp_path / "proj"
    shutil.copytree(EXAMPLE, root / "architecture")
    for rel in ("README.md", "src/graph/agent.py", "src/server/__init__.py"):
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x = 1\n" * 50)
    monkeypatch.setenv("PROTOAGENT_PROJECT_DIR", str(root))
    return root.resolve()
