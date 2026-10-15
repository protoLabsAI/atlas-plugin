"""Test bootstrap — make the plugin importable with NO protoAgent host.

The host loads a plugin under a synthetic package; the suite does the same so the
modules' relative imports (``from .store import ...``) resolve standalone. Executing
``__init__.py`` is safe because the host-only imports live inside ``register()`` /
functions, not at module top — so no protoAgent host is needed to import.

Pick the variant matching your plugin's shape (delete the other).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PKG = "my_plugin"

# ── MULTI-MODULE plugin (modules use `from .store import ...`) ───────────────────
# Register a synthetic package whose __path__ is the repo root, then import through
# it in tests: `from my_plugin.store import ...`.
if PKG not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        PKG, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    assert _spec and _spec.loader
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules[PKG] = _mod
    _spec.loader.exec_module(_mod)

# ── SINGLE-FILE plugin (only __init__.py) — use this instead of the block above ──
# def load_plugin(monkeypatch, tmp_path):
#     monkeypatch.setenv("MY_PLUGIN_DIR", str(tmp_path))  # isolate any on-disk state
#     spec = importlib.util.spec_from_file_location("plugin_under_test", ROOT / "__init__.py")
#     mod = importlib.util.module_from_spec(spec)
#     spec.loader.exec_module(mod)
#     return mod


# Example fixture: a fake registry to smoke-test register() with no host.
class _Registry:
    def __init__(self):
        self.config = {}
        self.tools, self.routers, self.surfaces = [], [], []

    def register_tool(self, t):
        self.tools.append(t)

    def register_router(self, router, prefix):
        self.routers.append(prefix)

    def register_surface(self, start, stop=None, name=None):
        self.surfaces.append(name)

    def register_skill_dir(self, path):
        pass


@pytest.fixture
def registry():
    return _Registry()
