"""Node resolution order (config → PATH ≥ 20 → managed) and the setup gap."""

from __future__ import annotations

import os
import stat
import threading
import types

import pytest

from atlas import nodes


def _fake_node(path, version):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\necho {version}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Stubbed world: versions by path, PATH lookup, and the managed bin dir."""
    versions: dict[str, str] = {}
    state = types.SimpleNamespace(which=None, managed=None, versions=versions)
    monkeypatch.setattr(nodes, "node_version", lambda p: versions.get(p, ""))
    monkeypatch.setattr(
        nodes.shutil,
        "which",
        lambda name, *a, **k: (
            state.which if name == "node" else name if os.path.isabs(name) and os.path.exists(name) else None
        ),
    )
    monkeypatch.setattr(nodes, "_managed_bin_dir", lambda: state.managed)

    def mk(rel, version):
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("")
        versions[str(p)] = version
        return str(p)

    state.mk = mk
    state.tmp = tmp_path
    return state


def test_parse_major():
    assert nodes.parse_major("v22.3.0") == 22
    assert nodes.parse_major("18.1.0") == 18
    assert nodes.parse_major("") is None
    assert nodes.parse_major("garbage") is None


def test_config_wins(env):
    cfg = env.mk("cfg/node", "v21.0.0")
    env.which = env.mk("path/node", "v22.0.0")
    info = nodes.resolve_node(cfg)
    assert (info.ok, info.source, info.path) == (True, "config", cfg)


def test_broken_config_falls_through_to_path(env):
    env.which = env.mk("path/node", "v22.0.0")
    info = nodes.resolve_node(str(env.tmp / "nope" / "node"))
    assert (info.ok, info.source) == (True, "path")


def test_too_old_config_falls_through(env):
    cfg = env.mk("cfg/node", "v18.0.0")
    env.which = env.mk("path/node", "v20.1.0")
    assert nodes.resolve_node(cfg).source == "path"


def test_path_node_too_old_uses_managed(env):
    env.which = env.mk("path/node", "v18.19.0")
    managed = env.mk("managed/bin/node", "v24.18.0")
    env.managed = env.tmp / "managed" / "bin"
    info = nodes.resolve_node("")
    assert (info.ok, info.source, info.path) == (True, "managed", managed)


def test_no_node_on_path_uses_managed(env):
    env.mk("managed/bin/node", "v24.18.0")
    env.managed = env.tmp / "managed" / "bin"
    assert nodes.resolve_node("").source == "managed"


def test_path_node_inside_the_managed_dir_is_named_managed(env):
    env.which = env.mk("managed/bin/node", "v24.18.0")
    env.managed = env.tmp / "managed" / "bin"
    assert nodes.resolve_node("").source == "managed"


def test_nothing_usable(env):
    env.which = env.mk("path/node", "v16.0.0")
    info = nodes.resolve_node("")
    assert not info.ok and info.source == ""
    assert "v16.0.0" in info.error and "managed runtime: not installed" in info.error


def test_node_version_runs_the_binary_and_caches(tmp_path, monkeypatch):
    if os.name == "nt":
        pytest.skip("shell-script stand-in")
    exe = _fake_node(tmp_path / "node", "v22.1.0")
    nodes._version_cache.clear()
    assert nodes.node_version(exe) == "v22.1.0"
    calls = []
    monkeypatch.setattr(nodes.subprocess, "run", lambda *a, **k: calls.append(a) or None)
    assert nodes.node_version(exe) == "v22.1.0"  # cached by stat — no second run
    assert calls == []
    assert nodes.node_version(str(tmp_path / "missing")) == ""


# ── the setup gap ───────────────────────────────────────────────────────────────────────


def test_gap_reported_once_then_cleared(registry):
    gap = nodes.NodeGap(registry)
    bad = nodes.NodeInfo(error="PATH: no node; managed runtime: not installed")
    gap.update(bad)
    gap.update(bad)  # unchanged → no second report
    assert len(registry.gaps) == 1
    g = registry.gaps[0]
    assert g["key"] == "node" and "Node.js 20" in g["message"]
    kinds = [a["kind"] for a in g["action"]]
    assert kinds == ["plugin_setup", "plugin_config"]
    assert g["action"][0]["step"] == nodes.STEP_INSTALL_NODE
    assert g["action"][1]["fields"] == ["node_path"]
    gap.update(nodes.NodeInfo(path="/n", version="v22.0.0", ok=True, source="path"))
    assert registry.gaps[-1]["message"] is None
    gap.update(nodes.NodeInfo(path="/n", version="v22.0.0", ok=True, source="path"))
    assert len(registry.gaps) == 2


def test_gap_without_a_host_registry_is_a_noop():
    nodes.NodeGap(None).update(nodes.NodeInfo(error="x"))
    nodes.NodeGap(object()).update(nodes.NodeInfo(error="x"))


def test_install_step_without_host_installer(registry):
    out = nodes.NodeGap(registry).start_install(lambda: nodes.NodeInfo())
    assert out["ok"] is False and "Node" in out["message"]


def test_install_step_runs_the_managed_installer(registry, monkeypatch):
    import sys

    done = threading.Event()

    class NodeRuntimeError(RuntimeError):
        pass

    def install_managed_node(on_progress=None, **_):
        on_progress(50, 100)
        on_progress(100, 100)

    fake = types.ModuleType("runtime.node_install")
    fake.NodeRuntimeError = NodeRuntimeError
    fake.install_managed_node = install_managed_node
    fake.is_supported = lambda: True
    monkeypatch.setitem(sys.modules, "runtime", types.ModuleType("runtime"))
    monkeypatch.setitem(sys.modules, "runtime.node_install", fake)

    gap = nodes.NodeGap(registry)
    good = nodes.NodeInfo(path="/m/node", version="v24.18.0", ok=True, source="managed")

    def recheck():
        gap.update(good)
        done.set()
        return good

    out = gap.start_install(recheck)
    assert out["ok"] and out["pending"]
    assert done.wait(5)
    msgs = [g["message"] for g in registry.gaps]
    assert msgs[0].startswith("Installing the Node runtime")
    assert any(m and "50%" in m for m in msgs)
    assert msgs[-1] is None  # cleared once node is found
    assert gap.install["state"] == "done"


def test_install_failure_reraises_the_gap_with_retry(registry, monkeypatch):
    import sys

    class NodeRuntimeError(RuntimeError):
        pass

    def install_managed_node(**_):
        raise NodeRuntimeError("checksum mismatch")

    fake = types.ModuleType("runtime.node_install")
    fake.NodeRuntimeError = NodeRuntimeError
    fake.install_managed_node = install_managed_node
    fake.is_supported = lambda: True
    monkeypatch.setitem(sys.modules, "runtime", types.ModuleType("runtime"))
    monkeypatch.setitem(sys.modules, "runtime.node_install", fake)

    gap = nodes.NodeGap(registry)
    done = threading.Event()
    bad = nodes.NodeInfo(error="PATH: no node")

    def recheck():
        gap.update(bad)
        return bad

    orig = gap._report

    def spy(message, action=None):
        orig(message, action)
        if message and "failed" in message:
            done.set()

    gap._report = spy
    gap.start_install(recheck)
    assert done.wait(5)
    last = registry.gaps[-1]
    assert "checksum mismatch" in last["message"] and last["action"][0]["kind"] == "plugin_setup"
