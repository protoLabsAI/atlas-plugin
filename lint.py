"""Model helpers + Atlas lint — the checks LikeC4's own validator doesn't make.

Rules (each finding is ``{rule, message, view?, element?, tour?}``):

* ``no-drilldown`` — an element with children but no scoped view (``view x of <elem>``), so
  clicking it goes nowhere;
* ``code-link-missing`` — a code link whose file doesn't exist in the project;
  ``code-link-outside`` — a file link that escapes the project root;
* ``sequence-nesting`` — a ``variant sequence`` dynamic view using both an element and one of its
  descendants (LikeC4 silently drops those steps);
* ``tour-*`` — tours naming an unknown view / element, a step out of range, or a malformed file;
* ``empty-view`` — a view with no nodes;
* ``busy-view`` — a view with more than ``MAX_VIEW_NODES`` nodes (unreadable in the console panel —
  group the elements into sub-systems with their own scoped views).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

TOURS_FILE = "atlas.tours.json"
_STEP_ID = re.compile(r"^step-(\d+)")
MAX_VIEW_NODES = 12


# ── model helpers ───────────────────────────────────────────────────────────────────────────


def elements(model: dict | None) -> dict:
    return (model or {}).get("elements") or {}


def views(model: dict | None) -> dict:
    return (model or {}).get("views") or {}


def parent_of(fqn: str) -> str:
    return fqn.rpartition(".")[0]


def is_ancestor(a: str, b: str) -> bool:
    """Is ``a`` a strict ancestor of ``b``?"""
    return b.startswith(a + ".")


def children_of(model: dict | None) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for fqn in elements(model):
        p = parent_of(fqn)
        if p:
            out.setdefault(p, []).append(fqn)
    return out


def view_kind(view: dict) -> str:
    """``index`` | ``scoped`` | ``dynamic`` | ``deployment`` | ``element``."""
    t = view.get("_type")
    if t == "dynamic":
        return "dynamic"
    if t == "deployment":
        return "deployment"
    if view.get("viewOf"):
        return "scoped"
    if view.get("id") == "index":
        return "index"
    return "element"


def drilldowns(model: dict | None) -> dict[str, str]:
    """element fqn → the id of its (first) scoped view."""
    out: dict[str, str] = {}
    for vid, v in views(model).items():
        of = v.get("viewOf")
        if of and of not in out:
            out[of] = vid
    return out


def steps_of(view: dict) -> list[int]:
    """The 1-based walkthrough steps of a dynamic view (``step-NN`` edges; parallel sub-steps
    ``step-03.01`` belong to step 3)."""
    nums = set()
    for e in view.get("edges") or []:
        m = _STEP_ID.match(str(e.get("id", "")))
        if m:
            nums.add(int(m.group(1)))
    return sorted(nums)


def tree_order(model: dict | None) -> list[str]:
    """Element fqns in model-tree (depth-first) order."""
    kids = children_of(model)
    roots = [f for f in elements(model) if not parent_of(f)]
    out: list[str] = []

    def walk(f: str) -> None:
        out.append(f)
        for c in kids.get(f, []):
            walk(c)

    for r in roots:
        walk(r)
    return out


def auto_tour(model: dict | None) -> dict:
    """The tour the viewer derives with no tours file: ``index``, then each scoped view in model
    tree order, then each dynamic view."""
    vs = views(model)
    slides = []
    if "index" in vs:
        slides.append({"view": "index"})
    order = {f: i for i, f in enumerate(tree_order(model))}
    scoped = sorted(
        (vid for vid, v in vs.items() if view_kind(v) == "scoped"),
        key=lambda vid: order.get(vs[vid].get("viewOf"), len(order)),
    )
    slides += [{"view": vid} for vid in scoped]
    slides += [{"view": vid} for vid, v in vs.items() if view_kind(v) == "dynamic"]
    return {"id": "auto", "title": "Overview", "slides": slides}


def read_tours(model_dir: Path) -> tuple[dict | None, list[dict]]:
    """``(tours_doc, errors)`` from ``atlas.tours.json``. ``(None, [])`` when there's no file."""
    path = model_dir / TOURS_FILE
    if not path.is_file():
        return None, []
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return None, [{"message": f"{TOURS_FILE}: {exc.msg}", "file": str(path), "line": exc.lineno}]
    except OSError as exc:
        return None, [{"message": f"{TOURS_FILE}: {exc}", "file": str(path), "line": 1}]
    if not isinstance(doc, dict) or not isinstance(doc.get("tours"), list):
        return None, [{"message": f'{TOURS_FILE}: expected {{"tours": [...]}}', "file": str(path), "line": 1}]
    return doc, []


def tour_list(tours: dict | None) -> list[dict]:
    return [t for t in ((tours or {}).get("tours") or []) if isinstance(t, dict)]


# ── lint ──────────────────────────────────────────────────────────────────────────────────


def _lint_drilldown(model: dict) -> list[dict]:
    have = drilldowns(model)
    out = []
    for fqn, kids in children_of(model).items():
        if fqn in elements(model) and fqn not in have:
            out.append(
                {
                    "rule": "no-drilldown",
                    "element": fqn,
                    "message": f"{fqn} has {len(kids)} child element(s) but no scoped view — add `view {fqn.replace('.', '_')}_detail of {fqn} {{ include * }}`",
                }
            )
    return out


def _lint_links(model: dict, project_root: Path) -> list[dict]:
    out = []
    seen = set()
    for fqn, el in elements(model).items():
        for link in el.get("links") or []:
            if not isinstance(link, dict):
                continue
            key = (fqn, link.get("url"))
            if key in seen:
                continue
            seen.add(key)
            if link.get("kind") == "code" and not (project_root / link["path"]).exists():
                out.append(
                    {
                        "rule": "code-link-missing",
                        "element": fqn,
                        "message": f"{fqn}: code link {link.get('url')} → {link['path']} does not exist in the project",
                    }
                )
            elif link.get("kind") == "invalid":
                out.append(
                    {
                        "rule": "code-link-outside",
                        "element": fqn,
                        "message": f"{fqn}: link {link.get('url')} is {link.get('error', 'invalid')}",
                    }
                )
    return out


def _lint_sequence(model: dict) -> list[dict]:
    out = []
    for vid, v in views(model).items():
        if view_kind(v) != "dynamic" or v.get("variant") != "sequence":
            continue
        used: set[str] = set()
        for e in v.get("edges") or []:
            used.update(x for x in (e.get("source"), e.get("target")) if isinstance(x, str))
        for n in v.get("nodes") or []:
            ref = n.get("modelRef") or n.get("id")
            if isinstance(ref, str):
                used.add(ref)
        pairs = sorted((a, b) for a in used for b in used if is_ancestor(a, b))
        for a, b in pairs:
            out.append(
                {
                    "rule": "sequence-nesting",
                    "view": vid,
                    "message": f"sequence view {vid} uses both {a} and its descendant {b} — LikeC4 drops such steps; use one level",
                }
            )
    return out


def _lint_busy(model: dict) -> list[dict]:
    return [
        {
            "rule": "busy-view",
            "view": vid,
            "message": f"view {vid} shows {len(v['nodes'])} nodes (max {MAX_VIEW_NODES}) — group elements into sub-systems with their own scoped views",
        }
        for vid, v in views(model).items()
        if len(v.get("nodes") or []) > MAX_VIEW_NODES
    ]


def _lint_empty(model: dict) -> list[dict]:
    return [
        {"rule": "empty-view", "view": vid, "message": f"view {vid} has no nodes — its include rules match nothing"}
        for vid, v in views(model).items()
        if not (v.get("nodes") or [])
    ]


def check_slide(model: dict, slide: dict) -> list[str]:
    """Problems with one tour slide / show target (empty list = fine)."""
    problems = []
    vs = views(model)
    vid = slide.get("view")
    if not isinstance(vid, str) or not vid:
        return ["slide has no `view`"]
    view = vs.get(vid)
    if view is None:
        return [f"unknown view {vid!r}"]
    for key in ("focus", "via"):
        fqn = slide.get(key)
        if fqn is not None and fqn not in elements(model):
            problems.append(f"{key} {fqn!r} is not an element")
    step = slide.get("step")
    if step is not None:
        if view_kind(view) != "dynamic":
            problems.append(f"step {step} on {vid}, which is not a dynamic view")
        else:
            steps = steps_of(view)
            if isinstance(step, bool) or not isinstance(step, int) or step not in steps:
                problems.append(f"step {step!r} is out of range for {vid} (1–{max(steps) if steps else 0})")
    return problems


def _lint_tours(model: dict, tours: dict | None) -> list[dict]:
    out = []
    seen_ids = set()
    for i, tour in enumerate(tour_list(tours)):
        tid = tour.get("id") or f"#{i + 1}"
        if tid in seen_ids:
            out.append({"rule": "tour-duplicate", "tour": tid, "message": f"tour id {tid!r} is used twice"})
        seen_ids.add(tid)
        slides = tour.get("slides")
        if not isinstance(slides, list) or not slides:
            out.append({"rule": "tour-empty", "tour": tid, "message": f"tour {tid} has no slides"})
            continue
        for n, slide in enumerate(slides, 1):
            if not isinstance(slide, dict):
                out.append({"rule": "tour-slide", "tour": tid, "message": f"tour {tid} slide {n} is not an object"})
                continue
            for problem in check_slide(model, slide):
                out.append({"rule": "tour-slide", "tour": tid, "message": f"tour {tid} slide {n}: {problem}"})
    return out


def lint(model: dict | None, tours: dict | None, project_root: Path) -> list[dict]:
    if not model:
        return []
    return (
        _lint_drilldown(model)
        + _lint_links(model, project_root)
        + _lint_sequence(model)
        + _lint_tours(model, tours)
        + _lint_empty(model)
        + _lint_busy(model)
    )
