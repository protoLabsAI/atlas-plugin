"""Agent tools — validate the model, describe it, and show a view / tour in the console.

Writing the model is done with the normal filesystem tools, guided by the ``atlas`` skill;
these tools close the loop (``atlas_validate`` after each edit) and let the agent talk about
and drive the diagram (``atlas_describe``, ``atlas_show``).
"""

from __future__ import annotations

import asyncio

from langchain_core.tools import tool

from . import lint as L

MAX_LIST = 60  # nodes / edges / findings echoed per answer


def _title(el: dict | None, fallback: str) -> str:
    return str((el or {}).get("title") or fallback)


def _clip(lines: list[str], limit: int = MAX_LIST) -> list[str]:
    if len(lines) <= limit:
        return lines
    return lines[:limit] + [f"… and {len(lines) - limit} more"]


def _where(e: dict) -> str:
    f = e.get("file")
    if f and e.get("line"):
        return f"{f}:{e['line']} "
    return f"{f} " if f else ""


def validate_report(service) -> str:
    payload, model = service.current()
    project_label = payload.get("project") or payload.get("project_root")
    head = f"Atlas model {payload['model_dir']} (project {project_label})"
    if not payload.get("exists", True):
        return f"{head}: no model directory. " + payload["errors"][0]["message"]
    lines = [head]
    if model:
        lines[0] += f" — {len(L.views(model))} views, {len(L.elements(model))} elements"
    errors = payload.get("errors") or []
    if payload.get("ok") or not errors:
        lines.append("Engine: OK")
    else:
        lines.append(f"Engine: {len(errors)} error(s)")
        lines += _clip([f"  {_where(e)}{e.get('message', '')}".rstrip() for e in errors])
        if payload.get("stale"):
            lines.append("  (the viewer keeps showing the last good model until these are fixed)")
    findings = L.lint(model, service.current_tours(), service.locate()[0].root) if model else []
    if findings:
        lines.append(f"Lint: {len(findings)} finding(s)")
        lines += _clip([f"  [{f['rule']}] {f['message']}" for f in findings])
    elif model:
        lines.append("Lint: clean")
    return "\n".join(lines)


def _view_tree(model: dict) -> list[str]:
    vs = L.views(model)
    scoped = {vid: v.get("viewOf") for vid, v in vs.items() if L.view_kind(v) == "scoped"}
    by_elem: dict[str, str] = {}
    for vid, of in scoped.items():
        by_elem.setdefault(of, vid)

    def parent_view(vid: str) -> str | None:
        of = scoped[vid]
        p = L.parent_of(of)
        while p:
            if p in by_elem and by_elem[p] != vid:
                return by_elem[p]
            p = L.parent_of(p)
        return "index" if "index" in vs and vid != "index" else None

    kids: dict[str | None, list[str]] = {}
    order = {f: i for i, f in enumerate(L.tree_order(model))}
    for vid in sorted(scoped, key=lambda v: order.get(scoped[v], 1 << 30)):
        kids.setdefault(parent_view(vid), []).append(vid)

    def line(vid: str, depth: int) -> str:
        v = vs[vid]
        kind = L.view_kind(v)
        extra = f" of {v['viewOf']}" if v.get("viewOf") else ""
        if kind == "dynamic":
            extra = f", {len(L.steps_of(v))} steps" + (", sequence" if v.get("variant") == "sequence" else "")
        return f"{'  ' * depth}- {vid} — {v.get('title') or vid} [{kind}{extra}]"

    out: list[str] = []

    def walk(vid: str, depth: int) -> None:
        out.append(line(vid, depth))
        for c in kids.get(vid, []):
            walk(c, depth + 1)

    if "index" in vs:
        walk("index", 0)
    for vid in kids.get(None, []):
        walk(vid, 0)
    for vid, v in vs.items():
        if L.view_kind(v) in ("element", "deployment"):
            out.append(line(vid, 0))
    dynamic = [vid for vid, v in vs.items() if L.view_kind(v) == "dynamic"]
    if dynamic:
        out.append("Walkthroughs (dynamic views):")
        out += [line(vid, 1) for vid in dynamic]
    return out


def describe_text(service, view: str = "") -> str:
    payload, model = service.current()
    if not model:
        msg = (payload.get("errors") or [{"message": "no model"}])[0]["message"]
        return f"No model to describe: {msg}"
    if not view:
        lines = ["Views:"] + _view_tree(model)
        tours = L.tour_list(service.current_tours())
        if tours:
            lines.append("Tours:")
            lines += [
                f"  - {t.get('id')} — {t.get('title') or t.get('id')} ({len(t.get('slides') or [])} slides)"
                for t in tours
            ]
        else:
            auto = L.auto_tour(model)
            lines.append(
                f"Tours: none defined — the viewer's auto-tour has {len(auto['slides'])} slides (tour='auto')."
            )
        if not payload.get("ok"):
            lines.append("(The model currently has errors — run atlas_validate.)")
        return "\n".join(lines)
    v = L.views(model).get(view)
    if v is None:
        return f"Unknown view {view!r}. Views: {', '.join(L.views(model))}"
    els = L.elements(model)
    drill = L.drilldowns(model)
    kind = L.view_kind(v)
    lines = [f"{view} — {v.get('title') or view} [{kind}{' of ' + v['viewOf'] if v.get('viewOf') else ''}]"]
    if v.get("description") and isinstance(v["description"], dict):
        lines.append(str(v["description"].get("txt") or v["description"].get("md") or ""))
    lines.append("Nodes:")
    node_lines = []
    for n in v.get("nodes") or []:
        fqn = n.get("modelRef") or n.get("id")
        el = els.get(fqn)
        tech = (el or {}).get("technology")
        dd = drill.get(fqn)
        bits = [n.get("kind") or (el or {}).get("kind") or "?"]
        if tech:
            bits.append(str(tech))
        if dd and dd != view:
            bits.append(f"drill-down: {dd}")
        node_lines.append(f"  - {fqn} — {_title(n, fqn)} ({', '.join(bits)})")
    lines += _clip(node_lines)
    edges = v.get("edges") or []
    if kind == "dynamic":
        lines.append("Steps:")
        step_lines = []
        for e in edges:
            m = L._STEP_ID.match(str(e.get("id", "")))
            num = str(e.get("id", ""))[5:] if m else "?"
            step_lines.append(
                f"  {num.lstrip('0') or num}. {e.get('source')} → {e.get('target')}: {e.get('label') or ''}".rstrip(
                    ": "
                )
            )
        lines += _clip(step_lines)
    elif edges:
        lines.append("Edges:")
        lines += _clip(
            [
                f"  - {e.get('source')} → {e.get('target')}" + (f": {e['label']}" if e.get("label") else "")
                for e in edges
            ]
        )
    return "\n".join(lines)


def show_target(
    service, *, view="", step=None, focus=None, tour=None, slide=None, present=False
) -> tuple[dict | None, str]:
    """Validate a show request → ``(event_payload, "")`` or ``(None, why)``."""
    payload, model = service.current()
    if not model:
        msg = (payload.get("errors") or [{"message": "no model"}])[0]["message"]
        return None, f"Nothing to show: {msg}"
    view = (view or "").strip()
    tour = (tour or "").strip() or None
    if not view and not tour:
        return None, "Give a `view` (see atlas_describe) or a `tour`."
    event: dict = {"present": bool(present)}
    if tour:
        if tour == "auto":
            slides = L.auto_tour(model)["slides"]
        else:
            match = [t for t in L.tour_list(service.current_tours()) if t.get("id") == tour]
            if not match:
                known = [t.get("id") for t in L.tour_list(service.current_tours())] or ["auto"]
                return None, f"Unknown tour {tour!r}. Tours: {', '.join(map(str, known))}"
            slides = match[0].get("slides") or []
        event["tour"] = tour
        if slide is not None:
            if isinstance(slide, bool) or not isinstance(slide, int) or not 1 <= slide <= len(slides):
                return None, f"slide {slide!r} is out of range for tour {tour} (1–{len(slides)})"
            event["slide"] = slide
    if view:
        problems = L.check_slide(model, {"view": view, "step": step, "focus": focus})
        if problems:
            return None, "Can't show that: " + "; ".join(problems)
        event["view"] = view
        if step is not None:
            event["step"] = step
        if focus:
            event["focus"] = focus
    return event, ""


def build_tools(service, registry):
    """The three agent tools, bound to the service and the registry (bus + navigation)."""

    @tool
    async def atlas_validate() -> str:
        """Check the project's architecture model (the LikeC4 .c4 files Atlas renders). Runs the
        layout engine and Atlas's lint, and returns engine errors as file:line messages plus lint
        findings: elements with children but no drill-down view, code links to files that don't
        exist, sequence views mixing an element with its descendant, broken tour slides, and empty
        views. Run it after every edit to the model."""
        return await asyncio.to_thread(validate_report, service)

    @tool
    async def atlas_describe(view: str = "") -> str:
        """Describe the architecture diagram. With no view: the tree of views (id, title, which
        element each drills into, kind) and the tours. With a view id: its nodes (element id,
        title, kind, technology, drill-down view) and its edges, or numbered steps for a dynamic
        walkthrough view. Use it to talk about the architecture or to pick what to show."""
        return await asyncio.to_thread(describe_text, service, view)

    @tool
    async def atlas_show(
        view: str = "",
        step: int | None = None,
        focus: str | None = None,
        tour: str | None = None,
        slide: int | None = None,
        present: bool = False,
    ) -> str:
        """Show the operator part of the architecture diagram in the console's Atlas view.
        view: a view id from atlas_describe. step: a 1-based step of a dynamic (walkthrough) view.
        focus: an element id to highlight. tour: a tour id (or "auto"), slide: its 1-based slide.
        present: true to open presenter mode (full-screen slides with speaker notes)."""
        event, why = await asyncio.to_thread(
            show_target, service, view=view, step=step, focus=focus, tour=tour, slide=slide, present=present
        )
        if event is None:
            return why
        registry.emit("atlas.show", event)
        nav = getattr(registry, "navigate", None)
        if callable(nav):
            nav("atlas")
        what = (
            f"tour {event['tour']}" + (f" slide {event['slide']}" if "slide" in event else "")
            if "tour" in event
            else ""
        )
        if "view" in event:
            what = (what + ", " if what else "") + f"view {event['view']}"
            if "step" in event:
                what += f" step {event['step']}"
            if "focus" in event:
                what += f" focused on {event['focus']}"
        return f"Showing {what} in Atlas" + (" (presenter mode)." if present else ".")

    return [atlas_validate, atlas_describe, atlas_show]
