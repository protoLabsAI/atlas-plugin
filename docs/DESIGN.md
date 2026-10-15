# Atlas — design contract (v0.1)

Atlas is a protoAgent plugin for **drill-down architecture diagrams you can explore and present**.
It is built on [LikeC4](https://likec4.dev) 1.60.0: one model, many views. A scoped view
(`view x of elem`) is that element's drill-down; dynamic views are step-by-step walkthroughs.
The design was proven in a throwaway spike (authoring trials, an embed, the presenter) before this repo.

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Engine | `vendor/atlas-engine.mjs` (built from `web/engine.mjs` by `npm run build:engine`) | Single-file LikeC4 parser + Graphviz-WASM layout. Needs only `node` ≥ 20. No npm at runtime. |
| Backend | `__init__.py` + flat modules (`nodes.py`, `project.py`, `engine.py`, `links.py`, `lint.py`, `api.py`, `tools.py`) | Python; finds node, runs the engine, serves the model, tools. |
| Viewer | `web/src` → built into `static/` (committed) | React + `@likec4/diagram`; explorer + presenter. |
| Skill | `skills/atlas/SKILL.md` | How to author LikeC4 for Atlas (tested). |

## Engine CLI

```
node vendor/atlas-engine.mjs validate <model_dir>   → {"ok", "errors":[{message,file,line}], "ms"}
node vendor/atlas-engine.mjs export   <model_dir>   → same + "model": <LikeC4 layouted model $data>
```
Lines are 1-based. Exit code 0 even when the model has errors; non-zero means the engine crashed.

## Where the model lives

A project's architecture model is a directory of `.c4` files, default `<project root>/architecture/`
(config `model_dir`, relative to the active project, or absolute). It holds a
`likec4.config.json` (`{"name": "<project>"}`) and optionally `atlas.tours.json`.

**Code links** in the model are written `link /src/graph/agent.py#L10` and mean **relative to the
project root** (not the model dir). The backend normalises every element link in the exported model:
a link that points at a file in the project becomes `{kind:"code", path:"src/graph/agent.py", line:10}`
alongside the original url; `http(s)` links stay `{kind:"web", url}`.

## Tours (`atlas.tours.json`)

```json
{"tours": [{"id": "overview", "title": "protoAgent in 5 minutes",
  "slides": [{"view": "index", "focus": "protoagent", "note": "Speaker note…"},
             {"view": "proto_agent_detail", "via": "protoagent", "note": "…"},
             {"view": "chat_turn_flow", "step": 3, "note": "…"}]}]}
```
`view` required; `focus` = element FQN to highlight; `step` = dynamic-view walkthrough step (1-based);
`hold_ms` = autoplay/record dwell for the slide (500–60000; default from the note's length);
`via` = node to zoom through when entering the view; `note` = speaker notes (markdown-light).
With no tours file, the viewer derives an **auto-tour**: `index`, then each scoped view in model
tree order, then each dynamic view.

## HTTP

Page + assets on the PUBLIC prefix (iframe navigations carry no bearer); data GATED.

| Route | Auth | Returns |
|---|---|---|
| `GET /plugins/atlas/view` | public | `static/index.html` |
| `GET /plugins/atlas/static/{path}` | public (manifest `public_paths`) | built viewer assets |
| `GET /api/plugins/atlas/model` | bearer | `{ok, errors, model, tours, hash, model_dir, project_root, ms, stale}` — cached by a hash of the model dir's files (path+mtime+size); supports `If-None-Match`/`ETag` = hash → 304. When the current sources have errors but a previous good export exists, return the last good `model` with `ok:false`, `errors`, `stale:true`. |
| `GET /api/plugins/atlas/status` | bearer | `{node:{path,version,ok,source:"config"\|"path"\|"managed"}, model_dir, exists, engine:"vendor/atlas-engine.mjs"}` |

## Bus

`atlas.show` `{view, step?, focus?: [node id], edges?: [edge id], note?, tour?, slide?, present?: bool}`
— emitted by `atlas_show` (fully resolved: the backend picks the view, maps elements onto view
nodes, finds relation paths, turns `step: "next"` into a number). The open viewer zooms there, dims
everything but the highlighted set, fits the camera to it and pins `note` as a callout (or enters
presenter mode when `present`). `atlas.clear` `{}` drops highlights + callouts.

`atlas.viewing` `{view, step, selected, focus, edges, note, mode, tour, slide}` — published by the
viewer (debounced) whenever what the operator sees changes; the backend keeps the latest in
memory (`registry.on`) for `atlas_describe(current=True)` and relative steps.

## Agent tools

* `atlas_validate()` — run the engine + Atlas lint, return a compact report: engine errors
  (file:line message) and lint findings:
  - element with children but no scoped view (no drill-down);
  - code link whose file doesn't exist in the project;
  - a `variant sequence` dynamic view that uses both an element and its descendant (LikeC4 silently
    drops steps);
  - tours referencing unknown views / elements / out-of-range steps;
  - empty views.
* `atlas_describe(view: str = "", current: bool = False)` — no arg: the view tree (id, title,
  scoped-of, kind) + tours. With a view: its nodes (fqn, title, kind, has drill-down) and edges, or
  a dynamic view's steps (`N. From → To: label [from.fqn → to.fqn]`). `current=True`: the operator's
  latest `atlas.viewing`.
* `atlas_show(view="", element=None, focus=None, relations=None, note=None, step=None, drill=False,
  tour=None, slide=None, present=False)` — resolve + validate (see Bus), emit `atlas.show`, return a
  one-line confirmation. Element ids resolve by fqn, else a unique title / last segment; misses list
  close matches; a bad step lists every step. Writing the model is done with the normal filesystem
  tools, guided by the skill.
* `atlas_clear()` — emit `atlas.clear`.
* `atlas_record_script(tour, base_url="", color_scheme="dark", viewport="1280x800", bearer_env="")` — a
  Campaign Studio shot script recording the tour in record mode (see README *Recording a
  walkthrough*); timing model in `record.py`, mirrored by `web/src/logic.mjs`.

## Node resolution

1. config `node_path` (if set);
2. `node` on PATH, if `--version` ≥ 20;
3. core's managed Node (ADR 0085: `infra.node_runtime.managed_node_bin_dir()`, lazy + guarded import).

Always run the engine as `<absolute node> vendor/atlas-engine.mjs …` (never a shebang). No usable
node → `registry.report_setup_gap("node", …)` with an action pointing the operator at the managed
Node runtime install; clear the gap once node is found.

## Viewer

* Four rules: public page, gated data via the DS kit's `apiFetch`, slug-aware `BASE`, link
  `<BASE>/_ds/plugin-kit.{css,js}`. No CDN: `injectFontCss={false}`; fonts from the DS tokens.
* **Explore**: `ReactLikeC4` on the current view; click → drill-down (`onNavigateTo`); breadcrumb of
  levels; search; an element details panel (title, kind, technology, description, metadata, links —
  code links post `protoagent:code:open` to the parent so the console's code pane opens). Light/dark
  from the console theme.
* **Present**: the spike's presenter, ported — tours, keyboard
  (→ ← Enter Esc Tab 1–9 N F), synced-camera zoom into nodes, speaker notes, reduced-motion fade.
* Live reload: poll `/model` with ETag every 2 s while visible; keep the current view when it still
  exists; show an error banner (with file:line) on `ok:false` and keep rendering the last good model.
* Handles `atlas.show` from the bus.
