"""Every Atlas lint rule, on small synthetic models shaped like the engine's export."""

from __future__ import annotations

import json

import pytest

from atlas import lint as L


def _el(fqn, **kw):
    return {"id": fqn, "title": fqn.split(".")[-1].title(), "kind": "system", **kw}


def _model(elements, views):
    return {"elements": {e["id"]: e for e in elements}, "views": {v["id"]: v for v in views}}


def _view(vid, nodes=("a",), **kw):
    return {
        "_type": "element",
        "id": vid,
        "title": vid,
        "nodes": [{"id": n, "modelRef": n} for n in nodes],
        "edges": [],
        **kw,
    }


def _dyn(vid, steps, variant="diagram"):
    edges = [{"id": f"step-{i:02d}", "source": s, "target": t, "label": "x"} for i, (s, t) in enumerate(steps, 1)]
    nodes = sorted({x for st in steps for x in st})
    return {
        "_type": "dynamic",
        "id": vid,
        "title": vid,
        "variant": variant,
        "nodes": [{"id": n, "modelRef": n} for n in nodes],
        "edges": edges,
    }


@pytest.fixture
def base():
    return _model(
        [_el("a"), _el("a.b"), _el("a.b.c"), _el("d")],
        [
            _view("index", nodes=("a", "d")),
            _view("a_detail", nodes=("a.b",), viewOf="a"),
            _dyn("flow", [("a", "d"), ("d", "a")]),
        ],
    )


def rules(findings):
    return sorted({f["rule"] for f in findings})


def test_clean_model_has_no_findings(base, tmp_path):
    base["elements"]["a.b"]["children"] = []
    # give a.b its drill-down so the tree is fully covered
    base["views"]["ab_detail"] = _view("ab_detail", nodes=("a.b.c",), viewOf="a.b")
    assert L.lint(base, None, tmp_path) == []


def test_no_drilldown(base, tmp_path):
    f = L.lint(base, None, tmp_path)
    assert rules(f) == ["no-drilldown"]
    assert f[0]["element"] == "a.b" and "view a_b_detail of a.b" in f[0]["message"]


def test_code_link_missing_and_outside(base, tmp_path):
    base["views"]["ab_detail"] = _view("ab_detail", nodes=("a.b.c",), viewOf="a.b")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "here.py").write_text("x")
    base["elements"]["d"]["links"] = [
        {"url": "/src/here.py", "kind": "code", "path": "src/here.py"},
        {"url": "/src/gone.py#L3", "kind": "code", "path": "src/gone.py", "line": 3},
        {"url": "/../etc/passwd", "kind": "invalid", "error": "outside the project"},
        {"url": "https://x.dev", "kind": "web"},
    ]
    f = L.lint(base, None, tmp_path)
    assert rules(f) == ["code-link-missing", "code-link-outside"]
    assert any("src/gone.py" in x["message"] for x in f)


def test_sequence_nesting(base, tmp_path):
    base["views"]["ab_detail"] = _view("ab_detail", nodes=("a.b.c",), viewOf="a.b")
    base["views"]["seq"] = _dyn("seq", [("a", "d"), ("a.b", "d")], variant="sequence")
    base["views"]["ok_diagram"] = _dyn("ok_diagram", [("a", "d"), ("a.b", "d")], variant="diagram")
    f = L.lint(base, None, tmp_path)
    assert rules(f) == ["sequence-nesting"]
    assert f[0]["view"] == "seq" and "a.b" in f[0]["message"]


def test_empty_view(base, tmp_path):
    base["views"]["ab_detail"] = _view("ab_detail", nodes=("a.b.c",), viewOf="a.b")
    base["views"]["nothing"] = _view("nothing", nodes=())
    f = L.lint(base, None, tmp_path)
    assert rules(f) == ["empty-view"] and f[0]["view"] == "nothing"


def test_tour_rules(base, tmp_path):
    base["views"]["ab_detail"] = _view("ab_detail", nodes=("a.b.c",), viewOf="a.b")
    tours = {
        "tours": [
            {
                "id": "t",
                "slides": [
                    {"view": "index", "focus": "a"},
                    {"view": "nope"},
                    {"view": "index", "focus": "zzz"},
                    {"view": "a_detail", "via": "ghost"},
                    {"view": "flow", "step": 3},
                    {"view": "index", "step": 1},
                    {"note": "no view"},
                    "junk",
                ],
            },
            {"id": "t", "slides": []},
        ]
    }
    msgs = [f["message"] for f in L.lint(base, tours, tmp_path)]
    assert any("slide 2: unknown view 'nope'" in m for m in msgs)
    assert any("slide 3: focus 'zzz'" in m for m in msgs)
    assert any("slide 4: via 'ghost'" in m for m in msgs)
    assert any("slide 5: step 3 is out of range for flow (1–2)" in m for m in msgs)
    assert any("slide 6: step 1 on index, which is not a dynamic view" in m for m in msgs)
    assert any("slide 7: slide has no `view`" in m for m in msgs)
    assert any("slide 8 is not an object" in m for m in msgs)
    assert any("used twice" in m for m in msgs) and any("has no slides" in m for m in msgs)
    assert not any("slide 1:" in m for m in msgs)


def test_steps_number_like_the_badges_each_parallel_branch_is_a_step():
    # LikeC4 badges every step edge in walk order (a parallel pair is 2 and 3), and the viewer's
    # counter, the presenter and atlas_show(step=) all count the same way
    v = {
        "_type": "dynamic",
        "edges": [
            {"id": "step-03", "target": "d"},
            {"id": "step-02:par.02", "target": "c"},
            {"id": "step-01", "target": "a"},
            {"id": "step-02:par.01", "target": "b"},
            {"id": "plain", "target": "x"},
        ],
    }
    assert L.steps_of(v) == [1, 2, 3, 4]
    assert [L.step_edge(v, n).get("target") for n in (1, 2, 3, 4)] == ["a", "b", "c", "d"]
    assert L.step_edge(v, 5) == {} and L.step_edge(v, 0) == {}
    # older LikeC4 sub-step ids sort the same way
    assert L.steps_of({"edges": [{"id": "step-01"}, {"id": "step-02.01"}, {"id": "step-02.02"}]}) == [1, 2, 3]


def test_auto_tour_order(base):
    base["views"]["ab_detail"] = _view("ab_detail", nodes=("a.b.c",), viewOf="a.b")
    base["views"]["d_detail"] = _view("d_detail", nodes=("d",), viewOf="d")
    assert [s["view"] for s in L.auto_tour(base)["slides"]] == ["index", "a_detail", "ab_detail", "d_detail", "flow"]


def test_read_tours(tmp_path):
    assert L.read_tours(tmp_path) == (None, [])
    (tmp_path / L.TOURS_FILE).write_text('{"tours": [')
    doc, errs = L.read_tours(tmp_path)
    assert doc is None and errs[0]["line"] == 1 and "atlas.tours.json" in errs[0]["message"]
    (tmp_path / L.TOURS_FILE).write_text('{"slides": []}')
    assert L.read_tours(tmp_path)[1][0]["message"].endswith('expected {"tours": [...]}')
    (tmp_path / L.TOURS_FILE).write_text(json.dumps({"tours": [{"id": "x", "slides": [{"view": "index"}]}]}))
    assert L.read_tours(tmp_path)[0]["tours"][0]["id"] == "x"


def test_busy_view(base, tmp_path):
    base["views"]["ab_detail"] = _view("ab_detail", nodes=("a.b.c",), viewOf="a.b")
    base["views"]["crowded"] = _view("crowded", nodes=tuple(f"n{i}" for i in range(L.MAX_VIEW_NODES + 1)))
    base["views"]["full"] = _view("full", nodes=tuple(f"n{i}" for i in range(L.MAX_VIEW_NODES)))
    f = L.lint(base, None, tmp_path)
    assert rules(f) == ["busy-view"] and f[0]["view"] == "crowded"
