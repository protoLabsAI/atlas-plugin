"""Agent tools — validate / describe / show. Real engine against the example where it matters;
a stub service for the show-target checks (no node needed)."""

from __future__ import annotations

import pytest

from atlas import lint as L
from atlas.engine import AtlasService
from atlas.project import ProjectRef
from atlas.tools import build_tools, describe_text, show_target, validate_report
from conftest import needs_node


class _StubService:
    def __init__(self, model, tours=None, root=None, ok=True):
        self.model, self.tours, self.root, self.ok = model, tours, root, ok

    def current(self):
        return {
            "ok": self.ok,
            "errors": [],
            "model_dir": "/p/architecture",
            "project": "p",
            "project_root": "/p",
            "stale": False,
        }, self.model

    def current_tours(self):
        return self.tours

    def locate(self):
        return ProjectRef("p", self.root), None


MODEL = {
    "elements": {
        "a": {"id": "a", "title": "A", "kind": "system"},
        "a.b": {"id": "a.b", "title": "B", "kind": "container", "technology": "Python"},
        "d": {"id": "d", "title": "D", "kind": "system"},
    },
    "views": {
        "index": {
            "_type": "element",
            "id": "index",
            "title": "Context",
            "nodes": [
                {"id": "a", "modelRef": "a", "title": "A", "kind": "system"},
                {"id": "d", "modelRef": "d", "title": "D", "kind": "system"},
            ],
            "edges": [{"id": "e1", "source": "a", "target": "d", "label": "calls"}],
        },
        "a_detail": {
            "_type": "element",
            "id": "a_detail",
            "title": "A inside",
            "viewOf": "a",
            "nodes": [{"id": "a.b", "modelRef": "a.b", "title": "B", "kind": "container"}],
            "edges": [],
        },
        "flow": {
            "_type": "dynamic",
            "id": "flow",
            "title": "Flow",
            "variant": "diagram",
            "nodes": [{"id": "a", "modelRef": "a"}, {"id": "d", "modelRef": "d"}],
            "edges": [
                {"id": "step-01", "source": "a", "target": "d", "label": "ask"},
                {"id": "step-02", "source": "d", "target": "a", "label": "answer"},
            ],
        },
    },
}
TOURS = {"tours": [{"id": "intro", "title": "Intro", "slides": [{"view": "index"}, {"view": "flow", "step": 2}]}]}


@pytest.fixture
def stub(tmp_path):
    return _StubService(MODEL, TOURS, tmp_path)


def test_describe_tree(stub):
    out = describe_text(stub)
    assert "- index — Context [index]" in out
    assert "  - a_detail — A inside [scoped of a]" in out  # nested under index
    assert "flow — Flow [dynamic, 2 steps]" in out
    assert "intro — Intro (2 slides)" in out


def test_describe_view(stub):
    out = describe_text(stub, "index")
    assert "a — A (system, drill-down: a_detail)" in out
    assert "a → d: calls" in out
    flow = describe_text(stub, "flow")
    assert "1. A → D: ask [a → d]" in flow and "2. D → A: answer [d → a]" in flow
    assert "Unknown view 'zz'" in describe_text(stub, "zz")


def test_describe_without_tours_mentions_the_auto_tour(tmp_path):
    out = describe_text(_StubService(MODEL, None, tmp_path))
    assert "auto-tour has 3 slides" in out


@pytest.mark.parametrize(
    "kw,why",
    [
        ({"view": "nope"}, "unknown view 'nope'"),
        ({"view": "index", "focus": "ghost"}, "unknown element 'ghost'"),
        (
            {"view": "flow", "step": 9},
            "step 9 is out of range (1–2). flow has 2 step(s):\n  1. A → D: ask\n  2. D → A: answer",
        ),
        ({"view": "index", "step": 1}, "not a dynamic (walkthrough) view"),
        ({"tour": "nope"}, "Unknown tour 'nope'"),
        ({"tour": "intro", "slide": 3}, "slide 3 is out of range for tour intro (1–2)"),
        ({}, "Give a `view`, an `element`"),
    ],
)
def test_show_rejects_bad_targets(stub, kw, why):
    event, msg = show_target(stub, **kw)
    assert event is None and why in msg


def test_show_targets(stub):
    assert show_target(stub, view="flow", step=2, present=True)[0] == {"view": "flow", "step": 2, "present": True}
    assert show_target(stub, view="index", focus="a")[0] == {"view": "index", "focus": ["a"], "present": False}
    assert show_target(stub, tour="intro", slide=2)[0] == {"tour": "intro", "slide": 2, "present": False}
    assert show_target(stub, tour="auto", slide=3)[0]["slide"] == 3


async def test_atlas_show_emits_and_navigates(stub, registry):
    tools = {t.name: t for t in build_tools(stub, registry)}
    out = await tools["atlas_show"].ainvoke({"view": "flow", "step": 1, "present": True})
    assert out == "Showing view flow (Flow), step 1 of 2 — A → D: ask in Atlas (presenter mode)."
    assert registry.emitted == [("atlas.show", {"view": "flow", "step": 1, "present": True, "show_seq": 1})]
    assert registry.navigations == ["atlas"]
    bad = await tools["atlas_show"].ainvoke({"view": "nope"})
    assert "unknown view" in bad and len(registry.emitted) == 1


def test_validate_report_with_lint(tmp_path):
    model = {**MODEL, "elements": {**MODEL["elements"], "a.b.c": {"id": "a.b.c"}}}
    out = validate_report(_StubService(model, TOURS, tmp_path))
    assert "Engine: OK" in out and "[no-drilldown] a.b" in out


@needs_node
async def test_tools_against_the_real_example(project, registry):
    svc = AtlasService(lambda: {"model_dir": "architecture"})
    tools = {t.name: t for t in build_tools(svc, registry)}
    report = await tools["atlas_validate"].ainvoke({})
    assert "Engine: OK" in report and "8 views" in report
    # the example links into files the tmp project doesn't have → lint says so
    assert "[code-link-missing]" in report
    tree = await tools["atlas_describe"].ainvoke({})
    assert "proto_agent_detail" in tree and "overview — protoAgent in 85 seconds (8 slides)" in tree
    flow = await tools["atlas_describe"].ainvoke({"view": "chat_turn_flow"})
    assert (
        "10. Turn streaming → Console: SSE [proto_agent.interfaces.server.turn_stream → proto_agent.interfaces.console]"
        in flow
    )
    shown = await tools["atlas_show"].ainvoke({"tour": "overview", "slide": 8, "present": True})
    assert shown.startswith("Showing tour overview slide 8")


@needs_node
async def test_validate_reports_engine_errors_with_file_line(project, registry):
    (project / "architecture" / "views.c4").write_text("views { view index { include nothing_here } }")
    svc = AtlasService(lambda: {"model_dir": "architecture"})
    out = validate_report(svc)
    assert "Engine:" in out and "architecture/views.c4:1" in out and "nothing_here" in out


@needs_node
def test_example_is_lint_clean(project):
    """The shipped example passes every Atlas rule — drill-downs, tours, no view over the node cap
    — and, with the files its code links name present, has no dangling links either."""
    import re

    for c4 in (project / "architecture").glob("*.c4"):
        for rel in re.findall(r"link /(\S+?)(?:#\S*)? ", c4.read_text()):
            p = project / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()
    svc = AtlasService(lambda: {"model_dir": "architecture"})
    payload, model = svc.current()
    assert payload["ok"] is True
    assert L.lint(model, svc.current_tours(), project) == []
    assert max(len(v["nodes"]) for v in model["views"].values()) <= L.MAX_VIEW_NODES
