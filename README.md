# Atlas — architecture diagrams you can explore and present

A [protoAgent](https://github.com/protoLabsAI/protoAgent) plugin. Atlas renders a project's
[LikeC4](https://likec4.dev) model as a console view: one model, many views. Click an element
to drill into it, follow its code links into the console's code pane, and run guided tours in
presenter mode. The agent authors the model with its normal file tools (guided by the bundled
`atlas` skill) and checks, describes, and shows it with three tools.

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
7-slide overview tour.

- **Drill-down:** `view x of elem` is `elem`'s drill-down view.
- **Walkthroughs:** a `dynamic view` is a step-by-step walkthrough.
- **Code links:** `link /src/graph/agent.py#L10` is relative to the **project root**. Atlas turns it
  into a code link that opens in the console's code pane.

## Agent tools

| Tool | What it does |
|---|---|
| `atlas_validate()` | Runs the engine and Atlas lint. Reports engine errors as `file:line` and lint findings: no drill-down view, missing code-link files, sequence views that mix an element with its descendant, broken tour slides, and empty views. |
| `atlas_describe(view="")` | With no argument, lists the view tree and tours. With a view, lists that view's nodes and edges, or its steps. |
| `atlas_show(view, step, focus, tour, slide, present)` | Checks the target, emits `atlas.show`, and opens the Atlas view. |

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

## Release

Bump `version` in `protoagent.plugin.yaml` **and** `pyproject.toml` (a test keeps them in
lockstep). Then merge a `chore: release vX.Y.Z` commit to `main`. `release.yml` tags it and
publishes the release.
