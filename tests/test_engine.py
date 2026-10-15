"""The engine runner's inputs + cache: what gets hashed, what Atlas refuses to hand the engine,
failure backoff, error truncation, and last-good keying."""

from __future__ import annotations

import json
import shutil

import pytest

from atlas import engine, nodes
from conftest import needs_node

GOOD = {"ok": True, "errors": [], "ms": 1, "model": {"elements": {}, "views": {"index": {"id": "index", "nodes": []}}}}


@pytest.fixture
def node_ok(monkeypatch):
    monkeypatch.setattr(
        engine, "resolve_node", lambda p="": nodes.NodeInfo(path="/n", version="v22.0.0", ok=True, source="path")
    )


@pytest.fixture
def calls(monkeypatch, node_ok):
    """Stub the engine: records each run; returns ``calls.result`` (or raises it)."""

    class _Calls(list):
        result: list

    seen = _Calls()

    def fake(node, cmd, model_dir, **k):
        seen.append(cmd)
        if isinstance(calls_result[0], Exception):
            raise calls_result[0]
        return calls_result[0]

    calls_result = [GOOD]
    monkeypatch.setattr(engine, "run_engine", fake)
    seen.result = calls_result
    return seen


def _svc(**kw):
    return engine.AtlasService(lambda: {"model_dir": "architecture", **kw})


def _hash(md):
    return engine.dir_hash(md)


# ── what is hashed ──────────────────────────────────────────────────────────────────────


def test_hash_tracks_what_the_engine_reads(project):
    md = project / "architecture"
    h0 = _hash(md)
    (md / "notes.txt").write_text("not a model file")
    assert _hash(md) == h0  # the engine ignores it → no cache bust
    for rel in ("dist/extra.c4", ".hidden/more.likec4", "deep/a/b/c.like-c4"):
        p = md / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("model {}")
        h1 = _hash(md)
        assert h1 != h0, rel  # the engine DOES read dist/ and dot-dirs
        h0 = h1
    (md / "node_modules").mkdir()
    (md / "node_modules" / "x.c4").write_text("model {}")
    assert _hash(md) == h0  # …but never node_modules / .git
    (md / "atlas.tours.json").write_text('{"tours": []}')
    assert _hash(md) != h0


def test_max_files_stops_the_whole_walk(project, monkeypatch):
    md = project / "architecture"
    monkeypatch.setattr(engine, "_MAX_FILES", 3)
    for i in range(4):
        d = md / f"d{i}"
        d.mkdir()
        (d / "x.c4").write_text("model {}")
    entries, problems = engine.scan_model_dir(md)
    assert len(entries) == 4 and problems == ["the model directory holds more than 3 model files"]


# ── what Atlas refuses ──────────────────────────────────────────────────────────────────


def _config(md, doc):
    (md / "likec4.config.json").write_text(json.dumps(doc) if isinstance(doc, dict) else doc)


@pytest.mark.parametrize("paths", [["../../elsewhere"], ["../src"], ["ok", "/etc"]])
def test_include_outside_the_model_dir_is_refused(project, calls, paths):
    md = project / "architecture"
    _config(md, {"name": "p", "include": {"paths": paths}})
    d = _svc().get()
    assert d["ok"] is False and calls == []  # the engine never ran
    assert "leaves the model directory" in d["errors"][0]["message"]
    assert d["hash"].endswith("-refused")


def test_include_inside_the_model_dir_is_fine(project, calls):
    md = project / "architecture"
    (md / "shared").mkdir()
    _config(md, {"name": "p", "include": {"paths": ["./shared"]}})
    assert _svc().get()["ok"] is True and calls == ["export"]


def test_unverifiable_json5_include_is_refused(project, calls):
    _config(project / "architecture", "{name: 'p', include: {paths: ['../x']}}")
    d = _svc().get()
    assert d["ok"] is False and "can't verify" in d["errors"][0]["message"] and calls == []


def test_symlink_leaving_the_model_dir_is_refused(project, calls, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.c4").write_text("model {}")
    (project / "architecture" / "linked.c4").symlink_to(outside / "secret.c4")
    d = _svc().get()
    assert d["ok"] is False and "symlink leaving the model directory" in d["errors"][0]["message"] and calls == []


def test_symlinked_dir_leaving_the_model_dir_is_refused(project, calls, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (project / "architecture" / "ext").symlink_to(outside)
    d = _svc().get()
    assert d["ok"] is False and "ext is a symlink" in d["errors"][0]["message"]


# ── failure caching + backoff ───────────────────────────────────────────────────────────


def test_engine_failures_back_off(project, calls, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(engine.time, "monotonic", lambda: now[0])
    calls.result[0] = engine.EngineError("the layout engine timed out after 20s")
    svc = _svc()
    for _ in range(5):  # a 2 s poll burst
        assert svc.get()["hash"].endswith("-engine")
    assert calls == ["export"]
    now[0] += engine.ENGINE_RETRY + 0.1
    svc.get()
    assert calls == ["export"] * 2
    now[0] += engine.ENGINE_RETRY + 0.1  # second failure → the wait doubled
    svc.get()
    assert len(calls) == 2
    now[0] += engine.ENGINE_RETRY
    calls.result[0] = GOOD
    assert svc.get()["ok"] is True and len(calls) == 3
    # a good export is cached for good (until the sources change)
    now[0] += 3600
    svc.get()
    assert len(calls) == 3


def test_editing_the_sources_retries_at_once(project, calls):
    calls.result[0] = engine.EngineError("boom")
    svc = _svc()
    svc.get()
    (project / "architecture" / "more.c4").write_text("model {}")
    calls.result[0] = GOOD
    assert svc.get()["ok"] is True and len(calls) == 2


def test_no_node_is_reprobed_after_a_pause(project, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(engine.time, "monotonic", lambda: now[0])
    probes = []
    monkeypatch.setattr(engine, "resolve_node", lambda p="": probes.append(1) or nodes.NodeInfo(error="none"))
    svc = _svc()
    svc.get()
    svc.get()
    assert len(probes) == 1
    now[0] += engine.NODE_RETRY + 0.1
    svc.get()
    assert len(probes) == 2


# ── error truncation ────────────────────────────────────────────────────────────────────


def test_huge_engine_errors_are_truncated(project, calls):
    calls.result[0] = {"ok": False, "errors": [{"message": "Expecting: " + "x" * 170_000, "file": "a.c4", "line": 2}]}
    msg = _svc().get()["errors"][0]["message"]
    assert len(msg) <= engine.MAX_ERROR_CHARS and msg.endswith("…")


def test_huge_crash_messages_are_truncated(project, calls):
    calls.result[0] = engine.EngineError("crashed: " + "y" * 10_000)
    assert len(_svc().get()["errors"][0]["message"]) <= engine.MAX_ERROR_CHARS


# ── last good keyed by (project root, model dir) ────────────────────────────────────────


def test_last_good_is_per_project(project, calls, tmp_path, monkeypatch):
    shared = project / "architecture"
    store = tmp_path / "store"
    a = engine.AtlasService(lambda: {"model_dir": str(shared)}, store_dir=store)
    a.get()
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.setenv("PROTOAGENT_PROJECT_DIR", str(other))
    calls.result[0] = {"ok": False, "errors": [{"message": "bad"}]}
    b = engine.AtlasService(lambda: {"model_dir": str(shared)}, store_dir=store)
    d = b.get()
    assert d["stale"] is False and d["model"] is None  # project A's good model isn't B's
    assert len(list((store / "last_good").glob("*.json"))) == 1


@needs_node
def test_real_engine_on_a_missing_dir_is_not_ok(tmp_path):
    out = engine.run_engine(shutil.which("node"), "validate", tmp_path / "nope")
    assert out["ok"] is False and "not found" in out["errors"][0]["message"]
