"""HTTP — mounted exactly as register() mounts it. The model route runs the REAL vendored engine
with the system node against the example model (skipped without Node >= 20)."""

from __future__ import annotations

import shutil

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import needs_node


def _app(registry):
    app = FastAPI()
    for prefix, router in registry.routers:
        app.include_router(router, prefix=prefix)
    return app


@pytest.fixture
def client(registry, project, tmp_path, monkeypatch):
    import atlas

    registry.config = {"model_dir": "architecture"}
    store = tmp_path / "store"
    monkeypatch.setattr(atlas, "_store_dir", lambda reg: store)  # no host store in tests
    atlas.register(registry)
    c = TestClient(_app(registry))
    c.registry = registry
    c.project = project
    c.store = store
    return c


@pytest.fixture
def static_dir(tmp_path, monkeypatch):
    from atlas import api

    d = tmp_path / "static"
    monkeypatch.setattr(api, "STATIC", d)
    return d


# ── the public view ─────────────────────────────────────────────────────────────────────


def test_declared_view_path_serves_a_placeholder_before_the_build(client, static_dir):
    r = client.get("/plugins/atlas/view")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "hasn't been built" in r.text
    assert 'location.pathname.split("/plugins/")' in r.text and "/_ds/plugin-kit.css" in r.text
    # the page is NOT on the gated prefix
    assert client.get("/api/plugins/atlas/view").status_code == 404


def test_view_serves_the_built_index(client, static_dir):
    (static_dir / "assets").mkdir(parents=True)
    (static_dir / "index.html").write_text("<!doctype html><title>Atlas viewer</title>")
    (static_dir / "assets" / "app-1234.js").write_text("export const x = 1;")
    r = client.get("/plugins/atlas/view")
    assert r.status_code == 200 and "Atlas viewer" in r.text
    a = client.get("/plugins/atlas/static/assets/app-1234.js")
    assert a.status_code == 200 and a.headers["content-type"].startswith("text/javascript")
    assert "immutable" in a.headers["cache-control"]


@pytest.mark.parametrize("bad", ["../__init__.py", "..%2F__init__.py", "assets/../../api.py", "nope.js", ""])
def test_static_never_escapes(client, static_dir, bad):
    (static_dir / "assets").mkdir(parents=True)
    assert client.get(f"/plugins/atlas/static/{bad}").status_code == 404


def test_the_real_static_dir_is_what_ships():
    from atlas import api
    from conftest import ROOT

    assert api.STATIC == ROOT / "static"


# ── the gated model ─────────────────────────────────────────────────────────────────────


@needs_node
def test_model_route_returns_the_export(client):
    r = client.get("/api/plugins/atlas/model")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True and d["errors"] == [] and d["stale"] is False
    for key in ("model", "tours", "hash", "model_dir", "project_root", "ms"):
        assert key in d
    assert d["project_root"] == str(client.project)
    assert d["model_dir"] == str(client.project / "architecture")
    views = d["model"]["views"]
    assert {"index", "proto_agent_detail", "chat_turn_flow"} <= set(views)
    assert d["tours"]["tours"][0]["id"] == "overview"
    # links are normalised: root-relative code links + original url kept
    link = d["model"]["elements"]["proto_agent.core.graph"]["links"][0]
    assert link["kind"] == "code" and link["path"] == "src/graph/agent.py" and link["url"] == "/src/graph/agent.py"
    node_links = [n for n in views["proto_agent_core_detail"]["nodes"] if n["id"] == "proto_agent.core.graph"][0][
        "links"
    ]
    assert node_links[0]["kind"] == "code"
    assert r.headers["etag"] == f'"{d["hash"]}"'


@needs_node
def test_etag_304(client):
    r = client.get("/api/plugins/atlas/model")
    etag = r.headers["etag"]
    r2 = client.get("/api/plugins/atlas/model", headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.headers["etag"] == etag
    assert client.get("/api/plugins/atlas/model", headers={"If-None-Match": f"W/{etag}"}).status_code == 304
    # an edit changes the hash → a full response
    views = client.project / "architecture" / "views.c4"
    views.write_text(views.read_text().replace("'System context'", "'Context'"))
    r3 = client.get("/api/plugins/atlas/model", headers={"If-None-Match": etag})
    assert r3.status_code == 200 and r3.headers["etag"] != etag
    assert r3.json()["model"]["views"]["index"]["title"] == "Context"


@needs_node
def test_broken_model_serves_the_last_good_one_stale(client):
    good = client.get("/api/plugins/atlas/model").json()
    model_c4 = client.project / "architecture" / "model.c4"
    model_c4.write_text(model_c4.read_text() + "\nmodel { broken = \n")
    d = client.get("/api/plugins/atlas/model").json()
    assert d["ok"] is False and d["stale"] is True
    assert d["errors"] and d["errors"][0]["file"] == "architecture/model.c4" and d["errors"][0]["line"] > 1
    assert d["model"]["views"].keys() == good["model"]["views"].keys()
    assert d["hash"] != good["hash"]
    # the last good model survives a restart (persisted in the plugin store)
    assert list((client.store / "last_good").glob("*.json"))


@needs_node
def test_last_good_is_reloaded_from_the_store(client, registry):
    from atlas.engine import AtlasService

    client.get("/api/plugins/atlas/model")
    model_c4 = client.project / "architecture" / "model.c4"
    model_c4.write_text("model { broken = \n")
    fresh = AtlasService(lambda: {"model_dir": "architecture"}, store_dir=client.store)
    d = fresh.get()
    assert d["ok"] is False and d["stale"] is True and "proto_agent" in d["model"]["elements"]


@needs_node
def test_broken_model_without_a_last_good_has_no_model(project):
    from atlas.engine import AtlasService

    (project / "architecture" / "model.c4").write_text("model { broken = \n")
    d = AtlasService(lambda: {"model_dir": "architecture"}).get()
    assert d["ok"] is False and d["stale"] is False and d["model"] is None and d["errors"]


@needs_node
def test_bad_tours_file_is_an_error_but_the_model_is_fresh(client):
    (client.project / "architecture" / "atlas.tours.json").write_text("{ nope")
    d = client.get("/api/plugins/atlas/model").json()
    assert d["ok"] is False and d["stale"] is False and d["model"] is not None
    assert d["errors"][0]["file"] == "architecture/atlas.tours.json"


def test_missing_model_dir(client):
    shutil.rmtree(client.project / "architecture")
    d = client.get("/api/plugins/atlas/model").json()
    assert d["ok"] is False and d["exists"] is False and d["model"] is None
    assert "No architecture model" in d["errors"][0]["message"]


def test_no_node_reports_the_gap_and_keeps_serving(client, monkeypatch):
    from atlas import engine, nodes

    monkeypatch.setattr(engine, "resolve_node", lambda p="": nodes.NodeInfo(error="PATH: no node"))
    d = client.get("/api/plugins/atlas/model").json()
    assert d["ok"] is False and d["hash"].endswith("-nonode")
    assert "Node.js 20+" in d["errors"][0]["message"]
    gap = client.registry.gaps[-1]
    assert gap["key"] == "node" and gap["message"] and gap["action"][0]["kind"] == "plugin_setup"


def test_engine_crash_is_reported_not_raised(client, monkeypatch):
    from atlas import engine, nodes

    monkeypatch.setattr(
        engine, "resolve_node", lambda p="": nodes.NodeInfo(path="/n", version="v22.0.0", ok=True, source="path")
    )

    def boom(*a, **k):
        raise engine.EngineError("the layout engine crashed (exit 1): boom")

    monkeypatch.setattr(engine, "run_engine", boom)
    d = client.get("/api/plugins/atlas/model").json()
    assert d["ok"] is False and "crashed" in d["errors"][0]["message"] and d["hash"].endswith("-engine")


def test_status(client, monkeypatch):
    from atlas import engine, nodes

    monkeypatch.setattr(
        engine, "resolve_node", lambda p="": nodes.NodeInfo(path="/n/node", version="v22.0.0", ok=True, source="path")
    )
    d = client.get("/api/plugins/atlas/status").json()
    assert d["node"] == {"path": "/n/node", "version": "v22.0.0", "ok": True, "source": "path"}
    assert d["model_dir"] == str(client.project / "architecture") and d["exists"] is True
    assert d["engine"] == "vendor/atlas-engine.mjs" and d["engine_present"] is True
    assert d["transition_speed"] == "normal"


@pytest.mark.parametrize(
    ("value", "want"), [("slow", "slow"), ("FAST", "fast"), ("normal", "normal"), ("warp", "normal"), ("", "normal")]
)
def test_status_transition_speed(client, value, want):
    client.registry.config = {"model_dir": "architecture", "transition_speed": value}
    assert client.get("/api/plugins/atlas/status").json()["transition_speed"] == want


@needs_node
def test_run_engine_validate_directly(project):
    from atlas.engine import run_engine

    out = run_engine(shutil.which("node"), "validate", project / "architecture")
    assert out["ok"] is True and out["errors"] == [] and "model" not in out


def test_run_engine_rejects_unknown_commands(project):
    from atlas.engine import run_engine

    with pytest.raises(ValueError):
        run_engine("node", "rm", project)


def test_run_engine_timeout_and_crash(tmp_path):
    import sys

    from atlas.engine import EngineError, run_engine

    hang = tmp_path / "hang.py"
    hang.write_text("import time; time.sleep(10)")
    with pytest.raises(EngineError, match="timed out"):
        run_engine(sys.executable, "validate", tmp_path, engine=hang, timeout=0.5)
    crash = tmp_path / "crash.py"
    crash.write_text("import sys; print('kaboom', file=sys.stderr); sys.exit(3)")
    with pytest.raises(EngineError, match="exit 3.*kaboom"):
        run_engine(sys.executable, "validate", tmp_path, engine=crash)
    junk = tmp_path / "junk.py"
    junk.write_text("print('not json')")
    with pytest.raises(EngineError, match="invalid JSON"):
        run_engine(sys.executable, "validate", tmp_path, engine=junk)


def test_concurrent_requests_run_the_engine_once(project, monkeypatch):
    import threading

    from atlas import engine, nodes

    monkeypatch.setattr(
        engine, "resolve_node", lambda p="": nodes.NodeInfo(path="/n", version="v22.0.0", ok=True, source="path")
    )
    calls = []
    gate = threading.Event()

    def fake(node, cmd, model_dir, **k):
        calls.append(cmd)
        gate.wait(2)
        return {
            "ok": True,
            "errors": [],
            "ms": 1,
            "model": {"elements": {}, "views": {"index": {"id": "index", "nodes": []}}},
        }

    monkeypatch.setattr(engine, "run_engine", fake)
    svc = engine.AtlasService(lambda: {"model_dir": "architecture"})
    results = []
    threads = [threading.Thread(target=lambda: results.append(svc.get())) for _ in range(4)]
    for t in threads:
        t.start()
    gate.set()
    for t in threads:
        t.join(5)
    assert calls == ["export"] and len(results) == 4 and len({r["hash"] for r in results}) == 1
