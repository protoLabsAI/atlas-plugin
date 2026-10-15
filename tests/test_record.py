"""Recording a walkthrough — the autoplay timing model (pinned to the viewer's numbers), the
shot-script tool, and the YAML against Campaign Studio's own validator when it's importable."""

from __future__ import annotations

import importlib.util
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
    assert R.FINAL_HOLD_MS == 3000


def test_timeline():
    slides = TOURS["tours"][0]["slides"]
    # slide 1: view change 1500 + 3800; slide 2: same view 900 + 4000; slide 3: view change 1500 +
    # 2500 + 3 steps × 1800 (labels "send"/"run"/"complete"), then the final hold
    assert R.timeline(MODEL, slides) == [5300, 10200, 10200 + 1500 + 2500 + 3 * 1800 + 3000]
    assert R.timeline(MODEL, slides, "slow")[0] == 2400 + 3800


def test_hold_ms_lint():
    assert L.check_slide(MODEL, {"view": "index", "hold_ms": 5}) == [
        "hold_ms 5 must be an integer between 500 and 60000 (milliseconds)"
    ]
    assert L.check_slide(MODEL, {"view": "index", "hold_ms": 2000}) == []


GOLDEN = """name: "atlas-walk"
description: "Atlas walkthrough — A walk (3 slides, ~23 s), recorded continuously in record mode."
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
  - click: {role: menuitem, name: "Record — A walk", exact: true, frame: "/plugins/atlas/view"}
  - wait_for: {selector: '[data-atlas-state=presenting]', frame: "/plugins/atlas/view", timeout_ms: 10000}
  - mark: start
  - wait_for: {selector: '[data-atlas-state=tour-done]', frame: "/plugins/atlas/view", timeout_ms: 52600}
  - mark: end
  - hold: 500
"""


def test_shot_script_golden():
    text, ms, why = R.shot_script(MODEL, TOURS, "walk", base_url="http://localhost:7870/")
    assert why == "" and ms == 22600
    assert text == GOLDEN


def test_shot_script_long_tours_split_waits():
    slides = [{"view": "index", "hold_ms": 60000}] * 8  # ~8 min
    text, ms, _ = R.shot_script(MODEL, {"tours": [{"id": "long", "slides": slides}]}, "long")
    waits = [ln for ln in text.splitlines() if "wait_for: {selector: '[data-atlas-slide" in ln]
    assert ms > 400_000 and len(waits) >= 2
    assert all(
        int(ln.rsplit("timeout_ms: ", 1)[1].rstrip("}")) <= 180_000 for ln in text.splitlines() if "timeout_ms" in ln
    )
    assert "total_timeout_s: 580" in text  # the take + 90 s of setup margin


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
    assert "Record — Overview" in out


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
