"""Live navigation — resolve what the agent asked to show into a concrete viewer command, and
keep what the operator is looking at.

* ``resolve_element`` — an element by fqn, or forgivingly by unique title / last segment, with
  close-match suggestions on a miss;
* ``best_view`` — the view to show a set of elements in: the element's own drill-down when asked,
  else the smallest view containing all of them (ties → the view the operator is on);
* ``path_edges`` — the edges joining two elements in a view (direct, else the shortest path);
* ``resolve_step`` — a dynamic-view step: 1-based, or ``"next"`` / ``"prev"`` relative to the
  operator's current step; a miss lists every step as ``from → to: label`` to narrate from;
* ``ViewerState`` — the latest ``atlas.viewing`` the viewer published (view, step, selection,
  highlight, presenter) for ``atlas_describe(current=True)``.

Pure functions over the exported model dict (``lint`` helpers) — no host, no engine.
"""

from __future__ import annotations

import difflib
import threading
import time
from collections import deque

from . import lint as L

NOTE_MAX = 280
_REL_STEPS = ("next", "prev", "previous", "first", "last")


# ── elements ─────────────────────────────────────────────────────────────────────────────────


def _close(name: str, options: list[str], n: int = 4) -> list[str]:
    return difflib.get_close_matches(name, options, n=n, cutoff=0.45)


def suggest(name: str, model: dict) -> str:
    """`` Did you mean: a, b?`` for an unknown element (by fqn, title or last segment)."""
    els = L.elements(model)
    by_title = {str(e.get("title") or ""): f for f, e in els.items()}
    by_leaf = {f.rsplit(".", 1)[-1]: f for f in els}
    hits: list[str] = []
    for c in (
        _close(name, list(els))
        + [by_title[t] for t in _close(name, list(by_title))]
        + [by_leaf[x] for x in _close(name.rsplit(".", 1)[-1], list(by_leaf))]
    ):
        if c not in hits:
            hits.append(c)
    return f" Did you mean: {', '.join(hits[:5])}?" if hits else ""


def resolve_element(model: dict, name: str) -> tuple[str | None, str]:
    """``(fqn, "")`` or ``(None, why)``. Exact fqn first, then a UNIQUE case-insensitive title or
    last-segment match."""
    els = L.elements(model)
    name = (name or "").strip()
    if not name:
        return None, "empty element id"
    if name in els:
        return name, ""
    low = name.lower()
    matches = [
        f for f, e in els.items() if str(e.get("title") or "").lower() == low or f.rsplit(".", 1)[-1].lower() == low
    ]
    if len(matches) == 1:
        return matches[0], ""
    if len(matches) > 1:
        return None, f"{name!r} is ambiguous: {', '.join(sorted(matches))}"
    return None, f"unknown element {name!r}.{suggest(name, model)}"


def as_list(v) -> list[str]:
    if v is None or v == "":
        return []
    if isinstance(v, str):
        return [s.strip() for s in v.split(",") if s.strip()] if "," in v else [v.strip()]
    return [str(x).strip() for x in v if str(x).strip()]


# ── views ────────────────────────────────────────────────────────────────────────────────────


def node_ids(view: dict) -> set[str]:
    return {str(n.get("id")) for n in view.get("nodes") or []}


def node_for(view: dict, fqn: str) -> str | None:
    """The node showing ``fqn`` in ``view``: the element itself, else its nearest ancestor."""
    ids = node_ids(view)
    f = fqn
    while f:
        if f in ids:
            return f
        f = L.parent_of(f)
    return None


def views_containing(model: dict, fqns: list[str], *, dynamic: bool = False, via_ancestors: bool = False) -> list[str]:
    """Views showing every element as a node — or, ``via_ancestors``, as itself or its nearest
    ancestor, with all of them landing on DIFFERENT nodes (so they can still be told apart)."""
    out = []
    for vid, v in L.views(model).items():
        kind = L.view_kind(v)
        if kind == "deployment" or (kind == "dynamic") != dynamic:
            continue
        if via_ancestors:
            mapped = [node_for(v, f) for f in fqns]
            if all(mapped) and len(set(mapped)) == len(mapped):
                out.append(vid)
        elif all(f in node_ids(v) for f in fqns):
            out.append(vid)
    return out


def best_view(
    model: dict, fqns: list[str], *, current: str | None = None, drill: bool = False
) -> tuple[str | None, str]:
    """The view to show ``fqns`` in → ``(view_id, "")`` or ``(None, why)``."""
    if drill and len(fqns) == 1:
        dd = L.drilldowns(model).get(fqns[0])
        if dd:
            return dd, ""
    cands = (
        views_containing(model, fqns)
        or views_containing(model, fqns, dynamic=True)
        # none shows them all as themselves → the closest view showing each through an ancestor
        or views_containing(model, fqns, via_ancestors=True)
    )
    if not cands:
        per = []
        for f in fqns:
            where = views_containing(model, [f]) + views_containing(model, [f], dynamic=True)
            per.append(f"{f}: {', '.join(where) if where else 'no view'}")
        return None, "no single view shows " + " + ".join(fqns) + " (" + "; ".join(per) + ")"
    ranked = rank_views(model, fqns, cands, current)
    return ranked[0], ""


def rank_views(model: dict, fqns: list[str], cands: list[str], current: str | None = None) -> list[str]:
    """Best first: elements shown as themselves (else by the closest ancestors), then the fewest
    nodes, then the operator's current view."""
    vs = L.views(model)

    def distance(vid: str) -> int:  # how far each element sits below the node that shows it
        return sum(f.count(".") - (node_for(vs[vid], f) or "").count(".") for f in fqns)

    return sorted(cands, key=lambda vid: (distance(vid), len(vs[vid].get("nodes") or []), vid != current, vid))


def path_edges(view: dict, a: str, b: str) -> list[str]:
    """Edge ids joining node ``a`` to node ``b``: every direct edge between them (either
    direction), else the shortest directed path, else the shortest undirected one."""
    edges = view.get("edges") or []
    direct = [e["id"] for e in edges if {e.get("source"), e.get("target")} == {a, b}]
    if direct:
        return direct
    for directed in (True, False):
        adj: dict[str, list[tuple[str, str]]] = {}
        for e in edges:
            s, t = e.get("source"), e.get("target")
            adj.setdefault(s, []).append((t, e["id"]))
            if not directed:
                adj.setdefault(t, []).append((s, e["id"]))
        prev: dict[str, tuple[str, str]] = {a: ("", "")}
        q = deque([a])
        while q:
            n = q.popleft()
            if n == b:
                path = []
                while n != a:
                    n, eid = prev[n]
                    path.append(eid)
                return list(reversed(path))
            for m, eid in adj.get(n, []):
                if m not in prev:
                    prev[m] = (n, eid)
                    q.append(m)
    return []


# ── steps ────────────────────────────────────────────────────────────────────────────────────


def step_lines(model: dict, view: dict, *, ids: bool = False) -> list[str]:
    """``N. From → To: label`` per walkthrough step (titles, for narration; ``ids`` appends
    ``[from.fqn → to.fqn]`` so the agent can target them)."""
    els = L.elements(model)
    title = lambda f: str((els.get(f) or {}).get("title") or f)  # noqa: E731
    out = []
    for n in L.steps_of(view):
        e = next((e for e in view.get("edges") or [] if str(e.get("id", "")).startswith(f"step-{n:02d}")), {})
        label = f": {e['label']}" if e.get("label") else ""
        ref = f" [{e.get('source')} → {e.get('target')}]" if ids else ""
        out.append(f"{n}. {title(e.get('source'))} → {title(e.get('target'))}{label}{ref}")
    return out


def resolve_step(model: dict, vid: str, step, state: dict | None) -> tuple[int | None, str]:
    """A 1-based step (int or digit string) or ``next``/``prev``/``first``/``last`` relative to the
    operator's step on ``vid`` → ``(n, "")`` or ``(None, why)`` (the why lists every step)."""
    view = L.views(model).get(vid) or {}
    if L.view_kind(view) != "dynamic":
        return None, f"{vid} is not a dynamic (walkthrough) view — steps only exist on dynamic views"
    steps = L.steps_of(view)
    listing = f"{vid} has {len(steps)} step(s):\n" + "\n".join(f"  {s}" for s in step_lines(model, view))
    if not steps:
        return None, listing
    if isinstance(step, str) and step.strip().isdigit():
        step = int(step.strip())
    if isinstance(step, str):
        rel = step.strip().lower()
        if rel not in _REL_STEPS:
            return None, f"step {step!r} isn't a number or next/prev/first/last. {listing}"
        if rel == "first":
            return steps[0], ""
        if rel == "last":
            return steps[-1], ""
        cur = 0
        if state and state.get("view") == vid and isinstance(state.get("step"), int):
            cur = state["step"]
        if rel == "next":
            nxt = [s for s in steps if s > cur]
            return (nxt[0], "") if nxt else (None, f"already at the last step ({cur} of {len(steps)}). {listing}")
        prv = [s for s in steps if s < cur]
        return (prv[-1], "") if prv else (None, f"already at the first step. {listing}")
    if isinstance(step, bool) or not isinstance(step, int) or step not in steps:
        return None, f"step {step!r} is out of range (1–{steps[-1]}). {listing}"
    return step, ""


# ── what the operator sees ───────────────────────────────────────────────────────────────────


class ViewerState:
    """The latest ``atlas.viewing`` payload, kept in memory (thread-safe)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict | None = None
        self._at = 0.0

    def update(self, data) -> None:
        if not isinstance(data, dict):
            return
        clean = {
            k: data.get(k)
            for k in ("view", "step", "selected", "focus", "edges", "note", "mode", "tour", "slide", "steps")
        }
        with self._lock:
            self._data, self._at = clean, time.time()

    def on_event(self, payload) -> None:
        """A bus handler: ``{event, data, seq}`` (or the bare data)."""
        if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
            payload = payload["data"]
        self.update(payload)

    def get(self) -> dict | None:
        with self._lock:
            return dict(self._data) if self._data else None

    def age(self) -> float:
        return time.time() - self._at if self._at else float("inf")


def describe_current(model: dict | None, state: ViewerState) -> str:
    cur = state.get()
    if not cur:
        return "No viewer state yet — the Atlas view isn't open in the console (atlas_show opens it)."
    els = L.elements(model)
    vs = L.views(model)
    t = lambda f: f"{f} ({(els.get(f) or {}).get('title') or f})"  # noqa: E731
    vid = cur.get("view")
    v = vs.get(vid) or {}
    lines = [
        f"The operator is on view {vid} — {v.get('title') or vid}"
        + (
            " (presenter mode" + (f", tour {cur['tour']} slide {cur['slide']}" if cur.get("tour") else "") + ")"
            if cur.get("mode") == "present"
            else ""
        )
        + "."
    ]
    if isinstance(cur.get("step"), int) and v:
        sl = step_lines(model, v)
        n = cur["step"]
        lines.append(
            f"Walkthrough step {n} of {len(L.steps_of(v))}"
            + (f": {sl[n - 1].split('. ', 1)[1]}" if 0 < n <= len(sl) else "")
        )
    if cur.get("selected"):
        lines.append(f"Selected element: {t(cur['selected'])}")
    if cur.get("focus"):
        lines.append("Highlighted: " + ", ".join(t(f) for f in cur["focus"]))
    if cur.get("edges"):
        lines.append(f"Highlighted edges: {len(cur['edges'])}")
    if cur.get("note"):
        lines.append(f"Callout: {cur['note']}")
    age = state.age()
    lines.append(f"(as of {int(age)}s ago)" if age < 3600 else "(stale — over an hour old)")
    return "\n".join(lines)


# ── the show command ─────────────────────────────────────────────────────────────────────────


def plan_view_show(
    model: dict,
    state: dict | None,
    *,
    view="",
    element=None,
    focus=None,
    relations=None,
    note=None,
    step=None,
    drill=False,
) -> tuple[dict | None, str]:
    """Resolve a view-level show (no tour) → ``(event, "")`` or ``(None, why)``."""
    vs = L.views(model)
    targets, problems = [], []
    for name in as_list(element) + as_list(focus):
        f, why = resolve_element(model, name)
        if f is None:
            problems.append(why)
        elif f not in targets:
            targets.append(f)
    pairs = []
    for rel in relations or []:
        if not isinstance(rel, (list, tuple)) or len(rel) != 2:
            problems.append(f"relation {rel!r} must be a [from, to] pair")
            continue
        ends = []
        for name in rel:
            f, why = resolve_element(model, str(name))
            if f is None:
                problems.append(why)
            else:
                ends.append(f)
        if len(ends) == 2:
            pairs.append(ends)
    if problems:
        return None, "; ".join(problems)
    view = (view or "").strip()
    current = (state or {}).get("view")
    if step is not None and not view:
        view = current if current in vs and L.view_kind(vs[current]) == "dynamic" else ""
        if not view:
            dyn = [vid for vid, v in vs.items() if L.view_kind(v) == "dynamic"]
            return None, "a step needs a dynamic view — give view= (walkthroughs: " + (", ".join(dyn) or "none") + ")"
    if not view:
        wanted = targets + [f for p in pairs for f in p if f not in targets]
        if not wanted:
            return None, "Give a `view`, an `element`, or a `tour` (see atlas_describe)."
        view, why = best_view(model, wanted, current=current, drill=drill)
        if not view:
            return None, why
        if pairs:  # prefer the best-ranked view where every relation actually has a path
            pool = views_containing(model, wanted) or views_containing(model, wanted, via_ancestors=True)
            ok = [
                vid
                for vid in rank_views(model, wanted, pool, current)
                if all(path_edges(vs[vid], node_for(vs[vid], a) or "", node_for(vs[vid], b) or "") for a, b in pairs)
            ]
            view = ok[0] if ok else view
    if view not in vs:
        close = _close(view, list(vs))
        return None, f"unknown view {view!r}." + (
            f" Did you mean: {', '.join(close)}?" if close else f" Views: {', '.join(vs)}"
        )
    v = vs[view]
    event: dict = {"view": view}
    if step is not None:
        n, why = resolve_step(model, view, step, state)
        if n is None:
            return None, why
        event["step"] = n
    shown = view == L.drilldowns(model).get(targets[0]) if (drill and len(targets) == 1) else False
    hl = []
    for f in [] if shown else targets:
        nid = node_for(v, f)
        if nid is None:
            where = views_containing(model, [f])
            return None, f"{f} isn't in view {view}" + (f" — it's in: {', '.join(where)}" if where else "")
        if nid not in hl:
            hl.append(nid)
    edges = []
    for a, b in pairs:
        na, nb = node_for(v, a), node_for(v, b)
        if not na or not nb:
            missing = a if not na else b
            return None, f"{missing} isn't in view {view}"
        path = path_edges(v, na, nb)
        if not path:
            return None, f"no relationship path between {a} and {b} in view {view}"
        edges += [e for e in path if e not in edges]
        for n in (na, nb):
            if n not in hl:
                hl.append(n)
    if hl:
        event["focus"] = hl
    if edges:
        event["edges"] = edges
    if note:
        note = str(note).strip()
        if len(note) > NOTE_MAX:
            return None, f"note is {len(note)} characters — keep it to {NOTE_MAX} (one or two sentences)"
        if not hl:
            return None, "a note needs something to anchor to — give element/focus/relations"
        event["note"] = note
    return event, ""
