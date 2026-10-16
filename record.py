"""Recording a walkthrough — the autoplay timing model and a Campaign Studio shot script.

Atlas only has to be *recordable*: the viewer autoplays a tour in record mode (caption-style
notes, no chrome, a final hold) and exposes stable hooks on its root element —
``data-atlas-state`` = ``loading`` | ``ready`` | ``presenting`` | ``tour-done``,
``data-atlas-slide`` (1-based) and ``data-atlas-view``. ``shot_script`` writes the YAML a
recorder (Campaign Studio's ``shotscript`` format) runs: open the console, open the Atlas rail
view, start the tour from the Present menu's "Record" item, ``mark: start``, wait for
``tour-done``, ``mark: end``. No code coupling — it is just text.

The timing here MUST match the viewer's (``web/src/logic.mjs`` ``slideDwellMs`` / ``stepDwellMs``
/ ``END_HOLD_MS`` / ``CAPTION_FADE_MS`` / ``BEAT_MS``) — ``tests/test_record.py`` pins both to the same
numbers.

The end of a take: the last slide's reading-time dwell, then ``end_hold_ms`` more (a tour field,
default 2.5 s) so the last caption can be read, then the caption fades out (400 ms) and the clean
diagram holds a 2 s beat — and only then ``data-atlas-state=tour-done`` (where an outro cuts).
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
END_HOLD_MS = 2500  # default extra time on the last caption (tour `end_hold_ms`, 0–30000)
CAPTION_FADE_MS = 400
BEAT_MS = 2000  # the clean diagram, no caption, before tour-done
# the camera: a view change (a zoom through the portal, or ONE crossfade-zoom for a cousin /
# multi-level jump — never a hop-by-hop route) and a same-view focus ease, at normal speed
# (measured in-console: dev/console-framing.mjs prints the take's presenting → tour-done time)
VIEW_CHANGE_MS = 1200
SAME_VIEW_MS = 900
SPEED = {"slow": 1.6, "normal": 1.0, "fast": 0.6}
MAX_WAIT_MS = 180_000  # Campaign's per-step ceiling
TAIL_MARGIN_MS = 20_000  # slack on each wait for camera drift / a slow machine
CHUNK_MS = MAX_WAIT_MS - TAIL_MARGIN_MS
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


def end_hold_ms(tours: dict | None, tour: str) -> int:
    """The tour's ``end_hold_ms`` (validated 0–30000) or the default."""
    for t in L.tour_list(tours):
        if t.get("id") == tour:
            v = t.get("end_hold_ms")
            if isinstance(v, int) and not isinstance(v, bool) and L.END_HOLD_MIN_MS <= v <= L.END_HOLD_MAX_MS:
                return v
    return END_HOLD_MS


def outro_ms(end_hold: int = END_HOLD_MS) -> int:
    """From the last slide's dwell ending to tour-done."""
    return end_hold + CAPTION_FADE_MS + BEAT_MS


def tour_slides(model: dict, tours: dict | None, tour: str) -> tuple[list[dict] | None, str, str]:
    """``(slides, title, "")`` or ``(None, "", why)``."""
    if tour == "auto":
        auto = L.auto_tour(model)
        return auto["slides"], auto.get("title") or "Overview", ""
    for t in L.tour_list(tours):
        if t.get("id") == tour:
            return list(t.get("slides") or []), clean_title(t.get("title") or tour), ""
    known = [str(t.get("id")) for t in L.tour_list(tours)] + ["auto"]
    return None, "", f"unknown tour {tour!r}. Tours: {', '.join(known)}"


def timeline(model: dict, slides: list[dict], speed: str = "normal", end_hold: int = END_HOLD_MS) -> list[int]:
    """Milliseconds from the start of the take until each slide is DONE (cumulative), the last
    entry running on to tour-done (end hold + caption fade + beat) — the schedule the viewer runs."""
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
        out[-1] += outro_ms(end_hold)
    return out


# The console's dock toggles (bottom-right): aria-pressed="true" while that dock is open; disabled
# when it holds nothing. Scripts can't branch, so each collapse clicks the LAST of
# `body, <the open toggle>` in document order: the toggle when that dock is open, else <body>
# (a click on the Atlas canvas, which only clears a selection). Then it waits until it's closed.
DOCKS = ("Toggle side panel", "Toggle bottom panel")


def _collapse(label: str) -> list[str]:
    open_toggle = f'button[aria-label="{label}"][aria-pressed="true"]:not([disabled])'
    return [
        f"  - click: {{selector: {_yaml_str('body, ' + open_toggle)}, nth: last}}",
        f"  - wait_for: {{selector: {_yaml_str(open_toggle)}, state: hidden}}",
    ]


def _yaml_str(s: str) -> str:
    # JSON strings are valid YAML scalars; ASCII-only escapes (\uXXXX) keep NEL / U+2028 and other
    # characters YAML treats as line breaks out of the raw text
    return json.dumps(s, ensure_ascii=True)


_BREAKS = re.compile(r"[\u0000-\u001f\u007f-\u009f\u2028\u2029]+")


def clean_title(t) -> str:
    """The tour title as the viewer shows it in its menu (web/src/logic.mjs ``cleanTitle``)."""
    return re.sub(r"\s+", " ", _BREAKS.sub(" ", str(t or ""))).strip() or "Tour"


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
    if base_url and not re.fullmatch(r"https?://[^\s/?#]+(/[^\s?#]*)?", base_url.strip()):
        return None, 0, f"base_url {base_url!r} must be an http(s) URL like http://localhost:7870"
    if bearer_env and not re.fullmatch(r"[A-Z_][A-Z0-9_]*", bearer_env):
        return None, 0, "bearer_env must be an environment variable NAME like CAMPAIGN_APP_TOKEN"
    marks = timeline(model, slides, speed, end_hold_ms(tours, tour))
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
        # give Atlas the whole content area: collapse the console's side + bottom docks when open
        *[ln for dock in DOCKS for ln in _collapse(dock)],
        "  - hold: 1000",
        f"  - click: {{role: button, name: Tour options, frame: {f}}}",
        f"  - click: {{role: menuitem, name: {_yaml_str('Record — ' + title)}, exact: true, frame: {f}}}",
        f"  - wait_for: {{selector: '[data-atlas-state=presenting]', frame: {f}, timeout_ms: 10000}}",
        "  - mark: start",
    ]
    # Campaign caps one wait at 3 min: wait on the LAST slide start that still fits within the cap
    # (minus a margin for camera drift) from the previous wait, then for tour-done.
    starts = [0, *marks[:-1]]  # slide k (1-based) starts when slide k-1 is done
    for k in range(len(marks)):
        if marks[k] - starts[k] > CHUNK_MS:
            return (
                None,
                0,
                (
                    f"slide {k + 1} runs {round((marks[k] - starts[k]) / 1000)} s — longer than one recorder wait "
                    f"({CHUNK_MS // 1000} s). Shorten its hold_ms / split the flow into several slides."
                ),
            )
    t0, k = 0, 0  # k = index of the slide the last wait landed on (0 = the start)
    while marks[-1] - t0 > CHUNK_MS:
        nxt = max(j for j in range(k + 1, len(starts)) if starts[j] - t0 <= CHUNK_MS)
        lines.append(
            f"  - wait_for: {{selector: '[data-atlas-slide=\"{nxt + 1}\"]', frame: {f}, timeout_ms: {MAX_WAIT_MS}}}"
        )
        t0, k = starts[nxt], nxt
    tail = marks[-1] - t0 + TAIL_MARGIN_MS
    assert tail <= MAX_WAIT_MS, tail
    lines += [
        f"  - wait_for: {{selector: '[data-atlas-state=tour-done]', frame: {f}, timeout_ms: {round(tail)}}}",
        "  - mark: end",
        "  - hold: 500",
    ]
    return "\n".join(lines) + "\n", duration, ""
