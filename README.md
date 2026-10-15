# Atlas — architecture diagrams you can explore and present

A [protoAgent](https://github.com/protoLabsAI/protoAgent) plugin. Atlas renders a project's
[LikeC4](https://likec4.dev) model as a console view: one model, many views. Click an element
to drill into it, follow its code links into the console's code pane, and run guided tours in
presenter mode. The agent authors the model with its normal file tools (guided by the bundled
`atlas` skill) and checks, describes, narrates it live, and scripts recordings of it with five tools.

Design contract: [`docs/DESIGN.md`](docs/DESIGN.md).

## Install

```bash
protoagent plugin install https://github.com/protoLabsAI/atlas-plugin
```

It ships **disabled**. Enable it in Settings ▸ Plugins. It needs protoAgent **0.182.0** or
newer, and **Node.js 20+** to lay out diagrams. It uses the `node` on PATH, or protoAgent's
managed Node runtime. If neither is there, a setup banner offers an **Install Node runtime**
button.

## The model

Put the model's `.c4` files in `<project>/architecture/` (the `model_dir` setting), next to a
`likec4.config.json` (`{"name": "<project>"}`). Optionally add an `atlas.tours.json` file of
presenter tours. If you don't, the viewer derives an auto-tour.
[`examples/protoagent/`](examples/protoagent) is a working model of protoAgent itself, with a
8-slide overview tour.

- **Drill-down:** `view x of elem` is `elem`'s drill-down view.
- **Walkthroughs:** a `dynamic view` is a step-by-step walkthrough.
- **Code links:** `link /src/graph/agent.py#L10` is relative to the **project root**. Atlas turns it
  into a code link that opens in the console's code pane.

## Agent tools

| Tool | What it does |
|---|---|
| `atlas_validate()` | Runs the engine and Atlas lint. Reports engine errors as `file:line` and lint findings: no drill-down view, missing code-link files, sequence views that mix an element with its descendant, broken tour slides, and empty views. |
| `atlas_describe(view="", current=False)` | With no argument, lists the view tree and tours. With a view, lists that view's nodes and edges, or its numbered steps (`from → to: label`). `current=True`: what the operator is looking at now — view, step, selected element, highlights, presenter mode. |
| `atlas_show(view, element, focus, relations, note, step, drill, tour, slide, present)` | Live navigation. `element` picks the view itself (the smallest view containing it/them; `drill=True` → its own drill-down). `focus` highlights element(s) and dims the rest; `relations=[[a, b]]` highlights the edges (or shortest path) between them; `note` pins a ≤ 280-char callout to the first highlighted node; `step` is a walkthrough step or `"next"`/`"prev"` relative to the operator's. Unknown ids get close-match suggestions. Emits `atlas.show` and opens the view. |
| `atlas_clear()` | Removes highlights and callouts (`atlas.clear`). |
| `atlas_record_script(tour, base_url, color_scheme, viewport, bearer_env)` | Writes a screen-recording shot script (Campaign Studio's YAML) for a tour, plus its expected duration. See *Recording a walkthrough*. |

## Recording a walkthrough

Atlas is recordable without any coupling to a recorder:

- **Autoplay / Record.** The `▾` next to *Present* (aria-label *Tour options*) lists every tour with
  *Present*, *Autoplay* and *Record*. Autoplay holds each slide for its `hold_ms` (optional, 500–60000,
  linted) or, by default, for the note's reading time (1.2 s + 260 ms a word, 2.5–15 s), after the
  camera settles. A slide that shows a whole dynamic view then walks its steps (1–15 s each, from the
  step label). The schedule is deterministic and waits for fonts to load. *Record* is autoplay plus
  large caption-style notes, with no toolbar, keyboard hints, toasts, cursor or hover states, and a
  3 s hold on the last slide.
- **Hooks.** The view's `<html>` carries `data-atlas-state` (`loading` → `ready` → `presenting` → `tour-done`),
  `data-atlas-slide` (1-based) and `data-atlas-view`, so a recorder can
  `wait_for: {selector: "[data-atlas-state=tour-done]", frame: "/plugins/atlas/view"}`.
- **Deep links.** `/plugins/atlas/view#tour=<id>&slide=<n>&present=1&autoplay=1&record=1` and
  `#view=<id>&focus=<fqn>[,<fqn>]&step=<n>` work when the page is opened directly. The console doesn't
  forward a hash into a plugin view's iframe, so inside the console use the menu (that's what the script does).
- **`atlas_record_script(tour)`** writes the shot script. It opens `/app/`, clicks the *Atlas* rail
  button, waits for `ready`, collapses the console's side and bottom docks when they're open (so Atlas fills
  the content area), then opens *Tour options* → *Record — <tour title>*. It marks `start`,
  waits for `tour-done` (split into ≤ 3 min waits on `data-atlas-slide` for long tours), and marks `end`.
  It returns the expected duration from the same timing model the viewer runs. The footage between
  the marks is one continuous take of the Atlas view: no cuts, and nothing to ramp.
  A console that needs a token: `bearer_env: CAMPAIGN_APP_TOKEN`, or add
  `auth: {storage_state: …}` holding `protoagent.authToken` in localStorage.

## HTTP

| Route | Auth | Returns |
|---|---|---|
| `GET /plugins/atlas/view` | public | the viewer (`static/index.html`) |
| `GET /plugins/atlas/static/{path}` | public (`public_paths`) | the built viewer assets |
| `GET /api/plugins/atlas/model` | bearer | `{ok, errors, model, tours, hash, model_dir, project_root, project, exists, ms, stale}`, with ETag/304 |
| `GET /api/plugins/atlas/status` | bearer | the Node it found, the model dir, and the engine |

When the model has errors, `/model` keeps serving the **last good** model with `stale: true`. The
last good model is also stored in the plugin's store, so it survives a restart.

## Settings

| Key | Default | |
|---|---|---|
| `model_dir` | `architecture` | Relative to the project root, or an absolute path. |
| `project` | blank | The filesystem project the model describes. Blank picks the console's project, else the first registered project. |
| `node_path` | blank | A Node 20+ executable. Blank tries PATH, then the managed runtime. |

## Develop

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt ruff
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/pytest -q
```

The suite needs no protoAgent host. The engine tests run the real vendored engine
(`vendor/atlas-engine.mjs`) with the system Node, and are skipped without Node 20+.

The viewer (`web/` → `static/`) and the engine (`web/engine.mjs` → `vendor/`) are built with
`npm run build` in `web/`. Both outputs are committed, so installing from git needs no build.
`npm run build` also regenerates `THIRD_PARTY_NOTICES.md` (`npm run notices`), from the modules both bundles
actually contain.

**Viewer dev loop (`web/dev/`).** `node web/dev/server.mjs` stands in for the protoAgent host and the Atlas
backend. It serves the built viewer, a DS-kit stub, `/model` (exported from `--model`, default `examples/protoagent`)
and a console-like harness page. Use `--project-root <dir>` (or `$ATLAS_PROJECT_ROOT`) for code links, and
`--real-kit` with `$PROTOAGENT_DIR` to serve a real console's `_ds` kit. `node web/dev/drive.mjs` screenshots the
viewer through that server with Playwright. Set `$PLAYWRIGHT_FROM` to a folder whose `node_modules` has Playwright;
shots go to `--out`, or a temp dir by default.

## Release

Bump `version` in `protoagent.plugin.yaml` **and** `pyproject.toml` (a test keeps them in
lockstep). Then merge a `chore: release vX.Y.Z` commit to `main`. `release.yml` tags it and
publishes the release.

## License

[MIT](LICENSE) © 2026 protoLabs. The prebuilt engine and viewer bundles include third-party code under its own
licenses (MIT, Apache-2.0, BSD-3-Clause, 0BSD, ISC, BlueOak-1.0.0, and EPL-2.0 for the Graphviz inside the layout engine). The full texts,
plus where to get the exact Graphviz source, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
