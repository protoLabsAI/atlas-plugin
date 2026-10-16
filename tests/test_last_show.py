"""#11: atlas_show / atlas_clear keep the latest request for a view that mounts just after it."""

from __future__ import annotations

import asyncio

from atlas import nav as N
from atlas.tools import build_tools


def test_last_show_records_with_a_monotonic_seq(monkeypatch):
    last = N.LastShow()
    assert last.get() is None
    a = last.record("show", {"view": "index"})
    b = last.record("clear")
    got = last.get()
    assert b == a + 1 and got["seq"] == b and got["kind"] == "clear" and got["data"] == {}
    assert 0 <= got["age_ms"] < 1000 and got["fresh_ms"] == N.SHOW_REPLAY_S * 1000
    t = N.time.monotonic()
    monkeypatch.setattr(N.time, "monotonic", lambda: t + 20)
    assert last.get()["age_ms"] >= 19_000  # the viewer judges freshness from age_ms


def test_the_last_show_route():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from atlas.api import build_data_router

    last = N.LastShow()
    app = FastAPI()
    app.include_router(build_data_router(object(), last), prefix="/api/plugins/atlas")
    c = TestClient(app)
    r = c.get("/api/plugins/atlas/last-show")
    assert r.status_code == 200 and r.json() == {"last": None} and r.headers["cache-control"] == "no-store"
    last.record("show", {"view": "index", "focus": ["a"]})
    body = c.get("/api/plugins/atlas/last-show").json()["last"]
    assert body["kind"] == "show" and body["data"]["focus"] == ["a"] and body["seq"] == 1


class _Registry:
    def __init__(self):
        self.events = []
        self.navs = []

    def emit(self, topic, data):
        self.events.append((topic, data))

    def navigate(self, view):
        self.navs.append(view)


def test_show_and_clear_are_recorded_and_carry_their_seq(tmp_path):
    from test_record import MODEL, TOURS, _StubService

    reg = _Registry()
    last = N.LastShow()
    tools = {t.name: t for t in build_tools(_StubService(MODEL, TOURS, tmp_path), reg, N.ViewerState(), last)}
    asyncio.run(tools["atlas_show"].ainvoke({"view": "index"}))
    topic, event = reg.events[-1]
    assert topic == "atlas.show" and event["show_seq"] == 1 and event["view"] == "index"
    assert last.get()["kind"] == "show" and last.get()["data"]["view"] == "index"
    assert reg.navs == ["atlas"]  # the navigate stays (the replay covers the remount it can cause)
    asyncio.run(tools["atlas_clear"].ainvoke({}))
    assert reg.events[-1] == ("atlas.clear", {"show_seq": 2})
    assert last.get()["kind"] == "clear"
