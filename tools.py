"""Agent tools — validate the model, describe it, and show a view / tour in the console.

Writing the model is done with the normal filesystem tools, guided by the ``atlas`` skill;
these tools close the loop (``atlas_validate`` after each edit) and let the agent talk about
and drive the diagram (``atlas_describe``, ``atlas_show``).
"""

from __future__ import annotations

import asyncio

from langchain_core.tools import tool

from . import lint as L
from . import nav as N
from . import record as R

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
        lines.append('Steps (atlas_show(view=..., step=n | "next" | "prev")):')
        lines += _clip([f"  {x}" for x in N.step_lines(model, v, ids=True)])
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
    service,
    *,
    view="",
    step=None,
    focus=None,
    tour=None,
    slide=None,
    present=False,
    element=None,
    relations=None,
    note=None,
    drill=False,
    state=None,
) -> tuple[dict | None, str]:
    """Validate + resolve a show request → ``(event_payload, "")`` or ``(None, why)``.

    ``state`` is the operator's latest ``atlas.viewing`` (for step="next" and view ties)."""
    payload, model = service.current()
    if not model:
        msg = (payload.get("errors") or [{"message": "no model"}])[0]["message"]
        return None, f"Nothing to show: {msg}"
    tour = (tour or "").strip() or None
    event: dict = {"present": bool(present)}
    if tour:
        if tour == "auto":
            slides = L.auto_tour(model)["slides"]
        else:
            match = [t for t in L.tour_list(service.current_tours()) if t.get("id") == tour]
            if not match:
                known = [t.get("id") for t in L.tour_list(service.current_tours())] + ["auto"]
                return None, f"Unknown tour {tour!r}. Tours: {', '.join(map(str, known))}"
            slides = match[0].get("slides") or []
        event["tour"] = tour
        if slide is not None:
            if isinstance(slide, bool) or not isinstance(slide, int) or not 1 <= slide <= len(slides):
                return None, f"slide {slide!r} is out of range for tour {tour} (1–{len(slides)})"
            event["slide"] = slide
        if not (view or element or focus or relations or step is not None):
            return event, ""
    planned, why = N.plan_view_show(
        model, state, view=view, element=element, focus=focus, relations=relations, note=note, step=step, drill=drill
    )
    if planned is None:
        return None, "Can't show that: " + why
    event.update(planned)
    return event, ""


def describe_show(event: dict, model: dict) -> str:
    """The one-line confirmation for a show."""
    els = L.elements(model)
    t = lambda f: str((els.get(f) or {}).get("title") or f)  # noqa: E731
    parts = []
    if "tour" in event:
        parts.append(f"tour {event['tour']}" + (f" slide {event['slide']}" if "slide" in event else ""))
    if "view" in event:
        v = L.views(model).get(event["view"]) or {}
        parts.append(f"view {event['view']} ({v.get('title') or event['view']})")
        if "step" in event:
            sl = N.step_lines(model, v)
            n = event["step"]
            parts.append(
                f"step {n} of {len(L.steps_of(v))}" + (f" — {sl[n - 1].split('. ', 1)[1]}" if 0 < n <= len(sl) else "")
            )
        if event.get("focus"):
            parts.append("highlighting " + ", ".join(t(f) for f in event["focus"]))
        if event.get("edges"):
            parts.append(f"{len(event['edges'])} edge(s)")
        if event.get("note"):
            parts.append("with a callout")
    return "Showing " + ", ".join(parts) + " in Atlas" + (" (presenter mode)." if event.get("present") else ".")


def build_tools(service, registry, state: N.ViewerState | None = None):
    """The agent tools, bound to the service, the registry (bus + navigation) and the viewer state."""
    state = state or N.ViewerState()

    @tool
    async def atlas_validate() -> str:
        """Check the project's architecture model (the LikeC4 .c4 files Atlas renders). Runs the
        layout engine and Atlas's lint, and returns engine errors as file:line messages plus lint
        findings: elements with children but no drill-down view, code links to files that don't
        exist, sequence views mixing an element with its descendant, broken tour slides, views with more than 12 nodes, and empty
        views. Run it after every edit to the model."""
        return await asyncio.to_thread(validate_report, service)

    @tool
    async def atlas_describe(view: str = "", current: bool = False) -> str:
        """Describe the architecture diagram. No args: the tree of views (id, title, which element
        each drills into, kind) and the tours. view=<id>: its nodes (element id, title, kind,
        technology, drill-down view) and edges — or, for a dynamic walkthrough, its numbered
        steps (from → to: label). current=true: what the operator is looking at RIGHT NOW in the
        Atlas view — the view, walkthrough step, selected element, highlights, presenter mode.
        Check it before narrating ("the node you've selected…") and before step="next"."""
        if current:
            _payload, model = await asyncio.to_thread(service.current)
            return N.describe_current(model, state)
        return await asyncio.to_thread(describe_text, service, view)

    @tool
    async def atlas_show(
        view: str = "",
        element: str | list[str] | None = None,
        focus: str | list[str] | None = None,
        relations: list[list[str]] | None = None,
        note: str | None = None,
        step: int | str | None = None,
        drill: bool = False,
        tour: str | None = None,
        slide: int | None = None,
        present: bool = False,
    ) -> str:
        """Show and highlight part of the architecture diagram live in the console's Atlas view —
        use it to narrate the architecture while the operator watches.
        element: one element id (or a list) to show — with no view, Atlas picks the smallest view
          containing it/them (drill=true: the element's own drill-down view instead).
        focus: element id(s) to highlight in the view; everything else dims and the camera fits them.
        relations: [[from, to], ...] — highlight the edges (or the shortest path) between elements.
        note: a short callout (markdown-light, ≤ 280 chars) pinned to the first highlighted node.
        view: a view id from atlas_describe. step: a 1-based walkthrough step of a dynamic view,
          or "next" / "prev" relative to the operator's current step.
        tour + slide (1-based): a presenter tour ("auto" always exists). present: open presenter mode.
        A highlight stays until the next atlas_show / atlas_clear or the operator clicks."""
        event, why = await asyncio.to_thread(
            show_target,
            service,
            view=view,
            step=step,
            focus=focus,
            tour=tour,
            slide=slide,
            present=present,
            element=element,
            relations=relations,
            note=note,
            drill=drill,
            state=state.get(),
        )
        if event is None:
            return why
        registry.emit("atlas.show", event)
        nav = getattr(registry, "navigate", None)
        if callable(nav):
            nav("atlas")
        _payload, model = service.current()
        return describe_show(event, model or {})

    @tool
    async def atlas_record_script(
        tour: str,
        base_url: str = "",
        color_scheme: str = "dark",
        viewport: str = "1280x800",
        bearer_env: str = "",
    ) -> str:
        """Write a screen-recording shot script (Campaign Studio's YAML format) that records an
        Atlas tour as one continuous walkthrough: open the console, open the Atlas view, start
        the tour in record mode (autoplay, caption-style notes, no chrome), wait for it to end.
        tour: a tour id from atlas_describe ("auto" always exists). base_url: leave it blank — the
        script then records THIS agent's own console (the URL it is served on); pass a URL only to
        record a different console on purpose. color_scheme: dark | light. viewport: WIDTHxHEIGHT.
        bearer_env: the NAME of an env var holding the console token, if it needs one.
        Returns the YAML plus the expected duration — hand it to the recorder unchanged."""

        def build() -> str:
            payload, model = service.current()
            if not model:
                return "Nothing to record: " + (payload.get("errors") or [{"message": "no model"}])[0]["message"]
            speed = "normal"
            try:
                from .api import transition_speed

                speed = transition_speed(service.conf())
            except Exception:  # noqa: BLE001 — a stub service in tests
                pass
            own = R.own_console_url()
            url = base_url.strip() or own
            if not url:
                return f"Can't write the script: {R.BASE_URL_REQUIRED} (this agent couldn't tell its own console URL)."
            warn = ""
            if base_url.strip() and own and not R.same_console(base_url, own):
                warn = (
                    f"⚠ You're recording a different console than the one you run in: base_url {base_url.strip()} "
                    f"is not this agent's console ({own}). Leave base_url blank to record your own.\n\n"
                )
            text, ms, why = R.shot_script(
                model,
                service.current_tours(),
                tour.strip(),
                base_url=url,
                color_scheme=color_scheme.strip().lower(),
                viewport=viewport,
                speed=speed,
                bearer_env=bearer_env.strip(),
            )
            if text is None:
                return f"Can't write the script: {why}"
            return f"{warn}Shot script for tour {tour} (console {url.rstrip('/')}) — about {round(ms / 1000)} s of footage between mark start and mark end:\n\n```yaml\n{text}```"

        return await asyncio.to_thread(build)

    @tool
    async def atlas_clear() -> str:
        """Remove Atlas highlights and callouts (the view itself stays where it is)."""
        registry.emit("atlas.clear", {})
        return "Cleared the Atlas highlights."

    return [atlas_validate, atlas_describe, atlas_show, atlas_clear, atlas_record_script]
