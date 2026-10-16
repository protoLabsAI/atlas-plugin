"""Recording a walkthrough — the autoplay timing model (pinned to the viewer's numbers), the
shot-script tool, and the YAML against Campaign Studio's own validator when it's importable."""

from __future__ import annotations

import importlib.util
import re
import os
import sys
from pathlib import Path

import pytest

from atlas import lint as L
from atlas import record as R
from atlas.tools import build_tools
from test_nav import MODEL
from test_tools import _StubService

TOURS = {
    "tours": [
        {
            "id": "walk",
            "title": "A walk",
            "slides": [
                {"view": "index", "note": "one two three four five six seven eight nine ten"},
                {"view": "index", "focus": "app", "hold_ms": 4000},
                {"view": "turn", "note": ""},
            ],
        }
    ]
}


URL = "http://127.0.0.1:7953"  # never a default port (#7)


def test_dwell_numbers_match_the_viewer():
    # the same cases as web/test/record.test.mjs — change both or neither
    assert R.words("The **graph** owns `the` loop.") == 5
    assert R.slide_dwell_ms({"note": ""}) == 2500
    assert R.slide_dwell_ms({"note": "one two three four five six seven eight nine ten"}) == 3800
    assert R.slide_dwell_ms({"note": "x", "hold_ms": 7000}) == 7000
    assert R.slide_dwell_ms({"note": "w " * 200}) == 15000
    assert R.step_dwell_ms("POST chat") == 2500  # a walked step reads like a slide: ≥ 2.5 s
    assert R.step_dwell_ms("one two three four five six") == 2760
    assert (R.END_HOLD_MS, R.FINAL_CAPTION_MIN_MS, R.CAPTION_FADE_MS, R.BEAT_MS) == (1500, 5000, 400, 1000)
    assert R.outro_ms() == 2900 and R.outro_ms(0) == 1400 and R.outro_ms(0, 0) == 400


def test_timeline():
    slides = TOURS["tours"][0]["slides"]
    # slide 1: view change 1200 + 3800; slide 2: same view 900 + 4000; slide 3: view change 1200 +
    # 2500, then 3 walked steps × (900 camera + 2500 for the "From → To: label" caption — the steps
    # have no notes), then end hold 2500 (the last caption, a step's, is up 2.5 s: topped up to 5 s)
    # + caption fade 400 + beat 1000
    assert R.timeline(MODEL, slides) == [5000, 9900, 9900 + 1200 + 2500 + 3 * (900 + 2500) + 3900]
    # a short last caption is topped up to 5 s in all: 2500 dwell + 2500 hold
    assert R.timeline(MODEL, [{"view": "index"}])[-1] == 1200 + 2500 + 2500 + 400 + 1000
    # an explicit end_hold_ms / end_beat_ms is taken as is
    assert R.timeline(MODEL, [{"view": "index"}], end_hold=0, beat=0)[-1] == 1200 + 2500 + 400
    assert R.timeline(MODEL, slides, "slow")[0] == 1920 + 3800


def test_end_hold(tmp_path):
    tours = {"tours": [{**TOURS["tours"][0], "end_hold_ms": 6000}]}
    assert R.end_hold_ms(tours, "walk") == 6000 and R.end_hold_ms(TOURS, "walk") == 1500
    assert R.end_hold_ms(TOURS, "walk", last_dwell=2500) == 2500  # topped up to a 5 s last caption
    assert R.end_hold_ms({"tours": [{"id": "walk", "end_hold_ms": 99999}]}, "walk") == 1500
    _, ms, _ = R.shot_script(MODEL, tours, "walk", base_url=URL)
    assert ms == 27700 + 3500
    beat = {"tours": [{**TOURS["tours"][0], "end_beat_ms": 3000}]}
    assert R.end_beat_ms(beat, "walk") == 3000 and R.end_beat_ms(TOURS, "walk") == 1000
    assert R.shot_script(MODEL, beat, "walk", base_url=URL)[1] == 27700 + 2000
    bad = [
        f
        for f in L.lint(MODEL, {"tours": [{"id": "t", "end_hold_ms": -1, "slides": [{"view": "index"}]}]}, tmp_path)
        if f["rule"] == "tour-end-hold"
    ]
    assert bad and "between 0 and 30000" in bad[0]["message"]
    for v in (-1, 5001, 1.5, True, "1000"):
        found = L.lint(MODEL, {"tours": [{"id": "t", "end_beat_ms": v, "slides": [{"view": "index"}]}]}, tmp_path)
        assert any(f["rule"] == "tour-end-beat" and "between 0 and 5000" in f["message"] for f in found), v
    ok = L.lint(MODEL, {"tours": [{"id": "t", "end_beat_ms": 0, "slides": [{"view": "index"}]}]}, tmp_path)
    assert not any(f["rule"] == "tour-end-beat" for f in ok)


def test_hold_ms_lint():
    assert L.check_slide(MODEL, {"view": "index", "hold_ms": 5}) == [
        "hold_ms 5 must be an integer between 500 and 60000 (milliseconds)"
    ]
    assert L.check_slide(MODEL, {"view": "index", "hold_ms": 2000}) == []


GOLDEN = """name: "atlas-walk"
description: "Atlas walkthrough \\u2014 A walk (3 slides, ~28 s), recorded continuously in record mode."
base_url: "http://127.0.0.1:7953"
viewport: {width: 1280, height: 800}
color_scheme: dark
cursor: false
step_timeout_ms: 20000
total_timeout_s: 120
redact: {presets: [home_paths, emails, secrets]}
steps:
  - goto: /app/
  - wait_for: {role: button, name: Atlas, timeout_ms: 60000}
  - click: {role: button, name: Atlas}
  - wait_for: {selector: '[data-atlas-state=ready]', frame: "/plugins/atlas/view", timeout_ms: 60000}
  - click: {selector: "body, button[aria-label=\\"Toggle side panel\\"][aria-pressed=\\"true\\"]:not([disabled])", nth: last}
  - wait_for: {selector: "button[aria-label=\\"Toggle side panel\\"][aria-pressed=\\"true\\"]:not([disabled])", state: hidden}
  - click: {selector: "body, button[aria-label=\\"Toggle bottom panel\\"][aria-pressed=\\"true\\"]:not([disabled])", nth: last}
  - wait_for: {selector: "button[aria-label=\\"Toggle bottom panel\\"][aria-pressed=\\"true\\"]:not([disabled])", state: hidden}
  - hold: 1000
  - click: {role: button, name: Tour options, frame: "/plugins/atlas/view"}
  - click: {role: menuitem, name: "Record \\u2014 A walk", exact: true, frame: "/plugins/atlas/view"}
  - wait_for: {selector: '[data-atlas-state=presenting]', frame: "/plugins/atlas/view", timeout_ms: 10000}
  - mark: start
  - wait_for: {selector: '[data-atlas-state=tour-done]', frame: "/plugins/atlas/view", timeout_ms: 47700}
  - mark: end
  - hold: 500
"""


def test_shot_script_golden():
    text, ms, why = R.shot_script(MODEL, TOURS, "walk", base_url="http://127.0.0.1:7953/")
    assert why == "" and ms == 27700
    assert text == GOLDEN


def test_shot_script_long_tours_split_waits():
    slides = [{"view": "index", "hold_ms": 60000}] * 8  # ~8 min
    text, ms, why = R.shot_script(MODEL, {"tours": [{"id": "long", "slides": slides}]}, "long", base_url=URL)
    assert why == "" and ms > 400_000
    starts = [0, *R.timeline(MODEL, slides)[:-1]]
    waits = [ln for ln in text.splitlines() if "[data-atlas-slide=" in ln]
    landed = [0] + [starts[int(re.search(r'slide=\\?"(\d+)', ln).group(1)) - 1] for ln in waits]
    # every chunk (wait → next wait → tour-done) fits one recorder wait with its margin
    for a, b in zip(landed, [*landed[1:], ms]):
        assert 0 < b - a <= R.CHUNK_MS, (a, b)
    assert all(
        int(ln.rsplit("timeout_ms: ", 1)[1].rstrip("}")) <= R.MAX_WAIT_MS
        for ln in text.splitlines()
        if "timeout_ms" in ln
    )
    assert "total_timeout_s: 580" in text  # the take + 90 s of setup margin


def test_a_slide_longer_than_one_wait_is_refused():
    steps = [{"id": f"step-{n:02d}", "source": "user", "target": "app.api", "label": "x"} for n in range(1, 100)]
    model = {
        **MODEL,
        "views": {**MODEL["views"], "huge": {"_type": "dynamic", "id": "huge", "nodes": [], "edges": steps}},
    }
    text, _, why = R.shot_script(model, {"tours": [{"id": "t", "slides": [{"view": "huge"}]}]}, "t", base_url=URL)
    assert text is None and "longer than one recorder wait" in why


def test_titles_and_base_url():
    tours = {"tours": [{"id": "t", "title": "A\u2028walk\u0085 through ünïcode", "slides": [{"view": "index"}]}]}
    text, _, _ = R.shot_script(MODEL, tours, "t", base_url="https://atlas.example/x")
    assert text.isascii() and "Record \\u2014 A walk through \\u00fcn\\u00efcode" in text
    assert R.shot_script(MODEL, tours, "t", base_url="javascript:alert(1)")[2].startswith("base_url")
    assert R.shot_script(MODEL, tours, "t", base_url="file:///etc")[0] is None


@pytest.mark.parametrize(
    "kw,why",
    [
        ({"tour": "nope"}, "unknown tour 'nope'"),
        ({"tour": "walk", "viewport": "big"}, "viewport 'big'"),
        ({"tour": "walk", "color_scheme": "pink"}, "color_scheme"),
        ({"tour": "walk", "bearer_env": "my-token"}, "bearer_env must be"),
    ],
)
def test_shot_script_rejects(kw, why):
    tour = kw.pop("tour")
    text, _, msg = R.shot_script(MODEL, TOURS, tour, **{"base_url": URL, **kw})
    assert text is None and why in msg


async def test_record_tool(tmp_path, registry):
    tools = {t.name: t for t in build_tools(_StubService(MODEL, TOURS, tmp_path), registry)}
    out = await tools["atlas_record_script"].ainvoke({"tour": "auto", "base_url": "http://h:1"})
    assert (
        out.startswith("Shot script for tour auto (console http://h:1) — about ")
        and '```yaml\nname: "atlas-auto"' in out
    )
    assert "Record \\u2014 Overview" in out


CAMPAIGN = Path(os.environ.get("CAMPAIGN_PLUGIN_DIR", Path.home() / "dev" / "campaign-plugin")) / "shotscript.py"


@pytest.mark.skipif(
    not CAMPAIGN.is_file(), reason="Campaign Studio's shotscript.py isn't checked out next to this repo"
)
def test_valid_against_campaigns_own_validator():
    spec = importlib.util.spec_from_file_location("campaign_shotscript", CAMPAIGN)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["campaign_shotscript"] = mod
    try:
        spec.loader.exec_module(mod)
    except ImportError as e:  # pragma: no cover — it's meant to be stdlib + pyyaml
        pytest.skip(f"shotscript.py isn't importable host-free: {e}")
    for kw in (
        {},
        {
            "base_url": "http://127.0.0.1:7953",
            "bearer_env": "CAMPAIGN_APP_TOKEN",
            "color_scheme": "light",
            "viewport": "1440x900",
        },
    ):
        text, _, _ = R.shot_script(MODEL, TOURS, "walk", **{"base_url": URL, **kw})
        script = mod.validate(text)
        marks = [st.get("name") for st in script["steps"] if st.get("op") == "mark"]
        assert marks == ["start", "end"], marks
    long = [{"view": "index", "hold_ms": 60000}] * 8
    text, _, _ = R.shot_script(MODEL, {"tours": [{"id": "long", "slides": long}]}, "long", base_url=URL)
    mod.validate(text)


def test_walked_steps_are_captioned_and_timed():
    view = {"nodes": [{"id": "a", "title": "Console"}, {"id": "x.b", "title": "Server"}]}
    assert (
        R.step_caption(view, {"source": "a", "target": "x.b", "label": "POST", "notes": {"txt": "Posts."}}) == "Posts."
    )
    assert R.step_caption(view, {"source": "x.b", "target": "a", "label": "SSE"}) == "Server → Console: SSE"
    assert R.step_caption(view, {"source": "a", "target": "zz.c"}) == "Console → c"


def test_a_dive_of_several_levels_is_one_move():
    model = {
        "views": {
            "index": {"id": "index", "_type": "element", "nodes": [{"id": "s", "navigateTo": "s_d"}]},
            "s_d": {"id": "s_d", "_type": "element", "viewOf": "s", "nodes": [{"id": "s.c", "navigateTo": "c_d"}]},
            "c_d": {"id": "c_d", "_type": "element", "viewOf": "s.c", "nodes": [{"id": "s.c.k"}]},
        }
    }
    assert R.view_chain(model, "c_d") == ["index", "s_d", "c_d"]
    # one continuous dive, 0.9 × a single drill (1150 ms) per level + mounting the levels
    assert R.view_change_ms(model, "index", "c_d") == 2 * 1035 + 300
    assert R.view_change_ms(model, "c_d", "index") == 2 * 1035 + 300  # … and up
    assert R.view_change_ms(model, "s_d", "c_d") == R.VIEW_CHANGE_MS


def test_lint_flags_hand_picked_steps_that_skip(tmp_path):
    slides = [{"view": "turn", "step": 1}, {"view": "turn", "step": 3}]
    found = [
        f for f in L.lint(MODEL, {"tours": [{"id": "t", "slides": slides}]}, tmp_path) if f["rule"] == "tour-step-skip"
    ]
    assert found and "skips 1 step(s)" in found[0]["message"]
    ok = [{"view": "turn", "step": 1}, {"view": "turn", "step": 2}]
    assert not [
        f for f in L.lint(MODEL, {"tours": [{"id": "t", "slides": ok}]}, tmp_path) if f["rule"] == "tour-step-skip"
    ]


def test_auto_tour_notes_match_the_viewer_so_the_timing_does():
    # the viewer's autoTour captions each slide `title — description` and dwells on that; the
    # backend's auto tour (atlas_record_script tour="auto") carries the same notes
    auto = L.auto_tour(MODEL)
    for s in auto["slides"]:
        v = L.views(MODEL)[s["view"]]
        d = v.get("description")
        d = (d.get("md") or d.get("txt")) if isinstance(d, dict) else d
        assert s["note"] == " — ".join(x for x in (v.get("title") or s["view"], (d or "").strip()) if x)
    assert R.timeline(MODEL, auto["slides"])[0] == R.VIEW_CHANGE_MS + R.slide_dwell_ms(auto["slides"][0])


# ── #7: the console URL is never guessed ──────────────────────────────────────────────────


def test_a_blank_base_url_is_refused_never_defaulted():
    text, _, why = R.shot_script(MODEL, TOURS, "walk")
    assert text is None and why == R.BASE_URL_REQUIRED
    assert not hasattr(R, "DEFAULT_BASE_URL")
    src = Path(R.__file__).read_text()
    assert "localhost:7870" not in src and "127.0.0.1:7870" not in src


def test_own_console_url(monkeypatch):
    import types

    monkeypatch.delenv("A2A_PUBLIC_URL", raising=False)
    # no core, or a core whose server isn't running: unknown (never the class-default 7870)
    state = types.SimpleNamespace(active_port=7870, main_loop=None)
    monkeypatch.setitem(sys.modules, "runtime", types.ModuleType("runtime"))
    monkeypatch.setitem(sys.modules, "runtime.state", types.SimpleNamespace(STATE=state))
    monkeypatch.setitem(sys.modules, "graph", types.ModuleType("graph"))
    monkeypatch.setitem(sys.modules, "graph.sdk", types.ModuleType("graph.sdk"))
    assert R.own_console_url() == ""
    # the running server's bound port (the agent card's rule)
    state.main_loop, state.active_port = object(), 7953
    assert R.own_console_url() == "http://127.0.0.1:7953"
    # A2A_PUBLIC_URL wins (a deployed agent / a fleet member behind the hub)
    monkeypatch.setenv("A2A_PUBLIC_URL", "https://hub.example/agents/w1/")
    assert R.own_console_url() == "https://hub.example/agents/w1"
    # a core seam wins over both
    sys.modules["graph.sdk"].public_base_url = lambda: "https://seam.example"
    sys.modules["graph"].sdk = sys.modules["graph.sdk"]
    assert R.own_console_url() == "https://seam.example"


def test_same_console():
    assert R.same_console("http://localhost:7953", "http://127.0.0.1:7953/")
    assert not R.same_console("http://localhost:7870", "http://127.0.0.1:7953")
    assert not R.same_console("https://a.example/x", "https://a.example/y")


async def test_record_tool_uses_its_own_console_and_warns_on_another(tmp_path, registry, monkeypatch):
    tools = {t.name: t for t in build_tools(_StubService(MODEL, TOURS, tmp_path), registry)}
    monkeypatch.setattr(R, "own_console_url", lambda: "")
    out = await tools["atlas_record_script"].ainvoke({"tour": "walk"})
    assert out.startswith("Can't write the script: base_url is required") and "7870" not in out
    monkeypatch.setattr(R, "own_console_url", lambda: "http://127.0.0.1:7953")
    out = await tools["atlas_record_script"].ainvoke({"tour": "walk"})
    assert 'base_url: "http://127.0.0.1:7953"' in out and "different console" not in out
    out = await tools["atlas_record_script"].ainvoke({"tour": "walk", "base_url": "http://localhost:7870"})
    assert out.startswith("⚠ You're recording a different console than the one you run in")
    assert 'base_url: "http://localhost:7870"' in out
    out = await tools["atlas_record_script"].ainvoke({"tour": "walk", "base_url": "http://localhost:7953/"})
    assert "different console" not in out
