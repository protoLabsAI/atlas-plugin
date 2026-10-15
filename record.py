"""Recording a walkthrough — the autoplay timing model and a Campaign Studio shot script.

Atlas only has to be *recordable*: the viewer autoplays a tour in record mode (caption-style
notes, no chrome, a final hold) and exposes stable hooks on its root element —
``data-atlas-state`` = ``loading`` | ``ready`` | ``presenting`` | ``tour-done``,
``data-atlas-slide`` (1-based) and ``data-atlas-view``. ``shot_script`` writes the YAML a
recorder (Campaign Studio's ``shotscript`` format) runs: open the console, open the Atlas rail
view, start the tour from the Present menu's "Record" item, ``mark: start``, wait for
``tour-done``, ``mark: end``. No code coupling — it is just text.

The timing here MUST match the viewer's (``web/src/logic.mjs`` ``slideDwellMs`` / ``stepDwellMs``
/ ``FINAL_HOLD_MS``) — ``tests/test_record.py`` pins both to the same numbers.
"""

from __future__ import annotations

import json
import re

from . import lint as L

# reading speed ≈ 230 wpm → ~260 ms a word, plus a beat to look at the diagram
MIN_SLIDE_MS = 2500
SLIDE_BASE_MS = 1200
PER_WORD_MS = 260
MAX_SLIDE_MS = 15_000
MIN_STEP_MS = 1800
STEP_BASE_MS = 1000
FINAL_HOLD_MS = 3000
# the camera: a view change (zoom/fade, one hop) and a same-view focus ease, at normal speed
VIEW_CHANGE_MS = 1500
SAME_VIEW_MS = 900
SPEED = {"slow": 1.6, "normal": 1.0, "fast": 0.6}
MAX_WAIT_MS = 180_000  # Campaign's per-step ceiling
FRAME = "/plugins/atlas/view"
DEFAULT_BASE_URL = "http://localhost:7870"  # protoAgent's default console


def words(text: str | None) -> int:
    return len(re.findall(r"\S+", re.sub(r"[*`_\[\]()]", " ", str(text or ""))))


def slide_dwell_ms(slide: dict) -> int:
    hold = slide.get("hold_ms")
    if isinstance(hold, int) and not isinstance(hold, bool) and hold > 0:
        return hold
    return min(MAX_SLIDE_MS, max(MIN_SLIDE_MS, SLIDE_BASE_MS + words(slide.get("note")) * PER_WORD_MS))


def step_dwell_ms(label: str | None) -> int:
    return min(MAX_SLIDE_MS, max(MIN_STEP_MS, STEP_BASE_MS + words(label) * PER_WORD_MS))


def tour_slides(model: dict, tours: dict | None, tour: str) -> tuple[list[dict] | None, str, str]:
    """``(slides, title, "")`` or ``(None, "", why)``."""
    if tour == "auto":
        auto = L.auto_tour(model)
        return auto["slides"], auto.get("title") or "Overview", ""
    for t in L.tour_list(tours):
        if t.get("id") == tour:
            return list(t.get("slides") or []), str(t.get("title") or tour), ""
    known = [str(t.get("id")) for t in L.tour_list(tours)] + ["auto"]
    return None, "", f"unknown tour {tour!r}. Tours: {', '.join(known)}"


def timeline(model: dict, slides: list[dict], speed: str = "normal") -> list[int]:
    """Milliseconds from the start of the take until each slide is DONE (cumulative), the last
    entry including the final hold — the autoplay schedule the viewer runs."""
    k = SPEED.get(speed, 1.0)
    vs = L.views(model)
    out, t, prev = [], 0, None
    for i, s in enumerate(slides):
        v = vs.get(s.get("view")) or {}
        t += round((VIEW_CHANGE_MS if s.get("view") != prev else (SAME_VIEW_MS if i else 0)) * k)
        prev = s.get("view")
        t += slide_dwell_ms(s)
        if L.view_kind(v) == "dynamic" and not s.get("step"):
            for n in L.steps_of(v):
                e = next((e for e in v.get("edges") or [] if str(e.get("id", "")).startswith(f"step-{n:02d}")), {})
                t += step_dwell_ms(e.get("label"))
        out.append(t)
    if out:
        out[-1] += FINAL_HOLD_MS
    return out


def _yaml_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)  # JSON strings are valid YAML scalars


def shot_script(
    model: dict,
    tours: dict | None,
    tour: str,
    *,
    base_url: str = "",
    color_scheme: str = "dark",
    viewport: str = "1280x800",
    speed: str = "normal",
    bearer_env: str = "",
) -> tuple[str | None, int, str]:
    """``(yaml, duration_ms, "")`` or ``(None, 0, why)``."""
    slides, title, why = tour_slides(model, tours, tour)
    if slides is None:
        return None, 0, why
    if not slides:
        return None, 0, f"tour {tour} has no slides"
    for n, s in enumerate(slides, 1):
        problems = L.check_slide(model, s)
        if problems:
            return None, 0, f"tour {tour} slide {n}: {'; '.join(problems)} — fix it (atlas_validate) before recording"
    m = re.fullmatch(r"\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*", viewport or "")
    if not m:
        return None, 0, f"viewport {viewport!r} must look like 1280x800"
    w, h = int(m.group(1)), int(m.group(2))
    if color_scheme not in ("dark", "light"):
        return None, 0, "color_scheme must be dark or light"
    if bearer_env and not re.fullmatch(r"[A-Z_][A-Z0-9_]*", bearer_env):
        return None, 0, "bearer_env must be an environment variable NAME like CAMPAIGN_APP_TOKEN"
    marks = timeline(model, slides, speed)
    duration = marks[-1]
    total_s = min(900, max(120, (duration + 90_000) // 1000))
    f = _yaml_str(FRAME)
    lines = [
        f"name: {_yaml_str('atlas-' + re.sub(r'[^A-Za-z0-9_.-]+', '-', tour)[:56])}",
        f"description: {_yaml_str(f'Atlas walkthrough — {title} ({len(slides)} slides, ~{round(duration / 1000)} s), recorded continuously in record mode.')}",
    ]
    lines.append(f"base_url: {_yaml_str((base_url or DEFAULT_BASE_URL).rstrip('/'))}")
    lines += [
        f"viewport: {{width: {w}, height: {h}}}",
        f"color_scheme: {color_scheme}",
        "cursor: false",
        "step_timeout_ms: 20000",
        f"total_timeout_s: {total_s}",
        "redact: {presets: [home_paths, emails, secrets]}",
    ]
    if bearer_env:
        lines.append(f"auth: {{bearer_env: {bearer_env}}}")
    lines += [
        "steps:",
        "  - goto: /app/",
        "  - wait_for: {role: button, name: Atlas, timeout_ms: 60000}",
        "  - click: {role: button, name: Atlas}",
        f"  - wait_for: {{selector: '[data-atlas-state=ready]', frame: {f}, timeout_ms: 60000}}",
        "  - hold: 1000",
        f"  - click: {{role: button, name: Tour options, frame: {f}}}",
        f"  - click: {{role: menuitem, name: {_yaml_str('Record — ' + title)}, exact: true, frame: {f}}}",
        f"  - wait_for: {{selector: '[data-atlas-state=presenting]', frame: {f}, timeout_ms: 10000}}",
        "  - mark: start",
    ]
    # one wait per ≤ 3 min chunk (Campaign's per-step ceiling): wait for the slide that starts
    # the next chunk, then for tour-done
    t0 = 0
    for i, t in enumerate(marks[:-1]):
        if t - t0 > MAX_WAIT_MS * 0.8:
            lines.append(
                f"  - wait_for: {{selector: '[data-atlas-slide=\"{i + 2}\"]', frame: {f}, timeout_ms: {MAX_WAIT_MS}}}"
            )
            t0 = t
    tail = min(MAX_WAIT_MS, duration - t0 + 30_000)
    lines += [
        f"  - wait_for: {{selector: '[data-atlas-state=tour-done]', frame: {f}, timeout_ms: {tail}}}",
        "  - mark: end",
        "  - hold: 500",
    ]
    return "\n".join(lines) + "\n", duration, ""
