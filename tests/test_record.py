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


def test_dwell_numbers_match_the_viewer():
    # the same cases as web/test/record.test.mjs — change both or neither
    assert R.words("The **graph** owns `the` loop.") == 5
    assert R.slide_dwell_ms({"note": ""}) == 2500
    assert R.slide_dwell_ms({"note": "one two three four five six seven eight nine ten"}) == 3800
    assert R.slide_dwell_ms({"note": "x", "hold_ms": 7000}) == 7000
    assert R.slide_dwell_ms({"note": "w " * 200}) == 15000
    assert R.step_dwell_ms("POST chat") == 1800
    assert R.step_dwell_ms("one two three four five six") == 2560
    assert (R.END_HOLD_MS, R.CAPTION_FADE_MS, R.BEAT_MS) == (2500, 400, 2000)
    assert R.outro_ms() == 4900 and R.outro_ms(0) == 2400


def test_timeline():
    slides = TOURS["tours"][0]["slides"]
    # slide 1: view change 1500 + 3800; slide 2: same view 900 + 4000; slide 3: view change 1500 +
    # 2500 + 3 steps × 1800 (labels "send"/"run"/"complete"), then end hold + caption fade + beat
    assert R.timeline(MODEL, slides) == [5300, 10200, 10200 + 1500 + 2500 + 3 * 1800 + 4900]
    assert R.timeline(MODEL, slides, "slow")[0] == 2400 + 3800


def test_end_hold(tmp_path):
    tours = {"tours": [{**TOURS["tours"][0], "end_hold_ms": 6000}]}
    assert R.end_hold_ms(tours, "walk") == 6000 and R.end_hold_ms(TOURS, "walk") == 2500
    assert R.end_hold_ms({"tours": [{"id": "walk", "end_hold_ms": 99999}]}, "walk") == 2500
    _, ms, _ = R.shot_script(MODEL, tours, "walk")
    assert ms == 24500 + 3500
    bad = [
        f
        for f in L.lint(MODEL, {"tours": [{"id": "t", "end_hold_ms": -1, "slides": [{"view": "index"}]}]}, tmp_path)
        if f["rule"] == "tour-end-hold"
    ]
    assert bad and "between 0 and 30000" in bad[0]["message"]


def test_hold_ms_lint():
    assert L.check_slide(MODEL, {"view": "index", "hold_ms": 5}) == [
        "hold_ms 5 must be an integer between 500 and 60000 (milliseconds)"
    ]
    assert L.check_slide(MODEL, {"view": "index", "hold_ms": 2000}) == []


GOLDEN = """name: "atlas-walk"
description: "Atlas walkthrough \\u2014 A walk (3 slides, ~24 s), recorded continuously in record mode."
base_url: "http://localhost:7870"
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
  - wait_for: {selector: '[data-atlas-state=tour-done]', frame: "/plugins/atlas/view", timeout_ms: 44500}
  - mark: end
  - hold: 500
"""


def test_shot_script_golden():
    text, ms, why = R.shot_script(MODEL, TOURS, "walk", base_url="http://localhost:7870/")
    assert why == "" and ms == 24500
    assert text == GOLDEN


def test_shot_script_long_tours_split_waits():
    slides = [{"view": "index", "hold_ms": 60000}] * 8  # ~8 min
    text, ms, why = R.shot_script(MODEL, {"tours": [{"id": "long", "slides": slides}]}, "long")
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
    assert "total_timeout_s: 582" in text  # the take + 90 s of setup margin


def test_a_slide_longer_than_one_wait_is_refused():
    steps = [{"id": f"step-{n:02d}", "source": "user", "target": "app.api", "label": "x"} for n in range(1, 100)]
    model = {
        **MODEL,
        "views": {**MODEL["views"], "huge": {"_type": "dynamic", "id": "huge", "nodes": [], "edges": steps}},
    }
    text, _, why = R.shot_script(model, {"tours": [{"id": "t", "slides": [{"view": "huge"}]}]}, "t")
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
    text, _, msg = R.shot_script(MODEL, TOURS, tour, **kw)
    assert text is None and why in msg


async def test_record_tool(tmp_path, registry):
    tools = {t.name: t for t in build_tools(_StubService(MODEL, TOURS, tmp_path), registry)}
    out = await tools["atlas_record_script"].ainvoke({"tour": "auto", "base_url": "http://h:1"})
    assert out.startswith("Shot script for tour auto — about ") and '```yaml\nname: "atlas-auto"' in out
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
            "base_url": "http://localhost:7870",
            "bearer_env": "CAMPAIGN_APP_TOKEN",
            "color_scheme": "light",
            "viewport": "1440x900",
        },
    ):
        text, _, _ = R.shot_script(MODEL, TOURS, "walk", **kw)
        script = mod.validate(text)
        marks = [st.get("name") for st in script["steps"] if st.get("op") == "mark"]
        assert marks == ["start", "end"], marks
    long = [{"view": "index", "hold_ms": 60000}] * 8
    text, _, _ = R.shot_script(MODEL, {"tours": [{"id": "long", "slides": long}]}, "long")
    mod.validate(text)
