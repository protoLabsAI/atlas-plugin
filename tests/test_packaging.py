"""Packaging + contract tests — manifest shape, version coherence, the view/public paths, and
that register() wires everything host-free."""

from __future__ import annotations

import tomllib

import yaml

from conftest import ROOT


def _manifest():
    return yaml.safe_load((ROOT / "protoagent.plugin.yaml").read_text())


def test_manifest_shape():
    m = _manifest()
    assert m["id"] == "atlas"
    assert m["enabled"] is False  # ships disabled — enabling is the operator's trust decision
    assert m["config_section"] == "atlas"
    assert m["config"]["model_dir"] == "architecture"
    assert "atlas.show" in m["emits"]
    assert m["min_protoagent_version"]


def test_manifest_and_pyproject_versions_agree():
    pp = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert _manifest()["version"] == pp["project"]["version"]


def test_view_path_is_public_and_static_is_exempt():
    m = _manifest()
    view = m["views"][0]
    assert view["path"] == "/plugins/atlas/view"
    assert not view["path"].startswith("/api/")
    assert "/plugins/atlas/static/" in m["public_paths"]


def test_every_setting_is_a_config_key():
    m = _manifest()
    assert {s["key"] for s in m["settings"]} == set(m["config"])
    for s in m["settings"]:
        assert s["type"] in ("string", "number", "bool", "select") and s["label"] and s["description"]


def test_code_default_matches_the_manifest():
    from atlas.project import DEFAULT_MODEL_DIR

    assert _manifest()["config"]["model_dir"] == DEFAULT_MODEL_DIR


def test_skill_and_engine_ship():
    assert (ROOT / "skills" / "atlas" / "SKILL.md").is_file()
    assert (ROOT / "vendor" / "atlas-engine.mjs").is_file()


def test_register_wires_everything(registry, monkeypatch):
    import atlas
    from atlas import nodes

    monkeypatch.setattr(
        nodes, "resolve_node", lambda p="": nodes.NodeInfo(path="/x/node", version="v22.0.0", ok=True, source="path")
    )
    monkeypatch.setattr("atlas.engine.resolve_node", nodes.resolve_node)
    atlas.register(registry)
    prefixes = [p for p, _ in registry.routers]
    assert prefixes == ["/plugins/atlas", "/api/plugins/atlas"]
    assert {t.name for t in registry.tools} == {"atlas_validate", "atlas_describe", "atlas_show", "atlas_clear"}
    assert "atlas.viewing" in registry.handlers  # the viewer's "what the operator sees" feed
    assert nodes.STEP_INSTALL_NODE in registry.steps
    assert "skills" in registry.skill_dirs
    # a node was found → the gap is cleared (never raised)
    assert registry.gaps == [{"key": "node", "message": None, "label": "Atlas", "action": None}]


def test_tool_docstrings_are_plain_literals(registry):
    from atlas.tools import build_tools

    for t in build_tools(object(), registry):
        assert t.description and len(t.description) > 40, t.name
