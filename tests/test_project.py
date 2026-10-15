"""Project + model-dir resolution, and the plugin store lookup — with stand-in host seams."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from atlas import project as P


class _FsRegistry:
    def __init__(self, projects):
        self._p = {n: types.SimpleNamespace(name=n, root=Path(r)) for n, r in projects}

    def names(self):
        return list(self._p)

    def get(self, name):
        return self._p.get(name)


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    monkeypatch.delenv("PROTOAGENT_PROJECT_DIR", raising=False)
    monkeypatch.setattr(P, "_host_config", lambda: None)
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    (b / "sub").mkdir(parents=True)
    return a.resolve(), b.resolve()


def test_no_host_uses_the_console_root_then_cwd(dirs, monkeypatch):
    a, _ = dirs
    monkeypatch.setattr(P, "_fs_registry", lambda: None)
    monkeypatch.chdir(a)
    assert P.resolve_project({}) == P.ProjectRef("", a)
    monkeypatch.setenv("PROTOAGENT_PROJECT_DIR", str(dirs[1]))
    assert P.resolve_project({}).root == dirs[1]


def test_configured_project_wins(dirs, monkeypatch):
    a, b = dirs
    monkeypatch.setattr(P, "_fs_registry", lambda: _FsRegistry([("a", a), ("b", b)]))
    assert P.resolve_project({"project": "b"}) == P.ProjectRef("b", b)


def test_project_holding_the_console_root(dirs, monkeypatch):
    a, b = dirs
    monkeypatch.setattr(P, "_fs_registry", lambda: _FsRegistry([("a", a), ("b", b)]))
    monkeypatch.setenv("PROTOAGENT_PROJECT_DIR", str(b / "sub"))
    assert P.resolve_project({}).name == "b"


def test_operator_project_dir_from_host_config(dirs, monkeypatch):
    a, b = dirs
    monkeypatch.setattr(P, "_fs_registry", lambda: _FsRegistry([("a", a), ("b", b)]))
    monkeypatch.setattr(P, "_host_config", lambda: types.SimpleNamespace(operator_project_dir=str(b)))
    assert P.resolve_project({}).name == "b"


def test_first_project_otherwise_and_unknown_config_falls_back(dirs, monkeypatch):
    a, b = dirs
    monkeypatch.setattr(P, "_fs_registry", lambda: _FsRegistry([("a", a), ("b", b)]))
    assert P.resolve_project({}).name == "a"
    assert P.resolve_project({"project": "zzz"}).name == "a"


def test_model_dir(dirs):
    a, b = dirs
    ref = P.ProjectRef("a", a)
    assert P.model_dir_for(ref, {}) == a / "architecture"
    assert P.model_dir_for(ref, {"model_dir": "docs/c4"}) == a / "docs" / "c4"
    assert P.model_dir_for(ref, {"model_dir": str(b)}) == b


def test_host_seams_are_absent_here():
    """The suite is host-free — the guarded lookups degrade instead of raising."""
    with pytest.raises(ImportError):
        import graph.plugins.host  # noqa: F401
    assert P._fs_registry() is None


def test_store_dir_prefers_sdk_plugin_store(monkeypatch, tmp_path, registry):
    import atlas

    assert atlas._store_dir(registry) is None  # no host: memory only
    calls = []
    sdk = types.ModuleType("graph.sdk")

    def plugin_store(subdir="", *, plugin_id):
        calls.append(plugin_id)
        return tmp_path / plugin_id

    sdk.plugin_store = plugin_store
    graph = types.ModuleType("graph")
    graph.sdk = sdk
    monkeypatch.setitem(sys.modules, "graph", graph)
    monkeypatch.setitem(sys.modules, "graph.sdk", sdk)
    assert atlas._store_dir(registry) == tmp_path / "atlas" and calls == ["atlas"]
