# Developing Atlas

For contributors: the layout of the repo, building, running locally, testing, releasing, and
recipes for extending Atlas. Read [Architecture](architecture.md) first.

- [Repo layout](#repo-layout)
- [Building](#building)
- [Running locally](#running-locally)
- [Testing](#testing)
- [CI and releases](#ci-and-releases)
- [Extending Atlas](#extending-atlas)

## Repo layout

```text
atlas-plugin/
├── protoagent.plugin.yaml   # manifest: config, settings, view, public_paths, bus topics
├── pyproject.toml           # version (lockstep with the manifest), ruff + pytest config
├── __init__.py              # register(): routers, tools, bus handler, setup step, skill
├── nodes.py                 # finding Node ≥ 20; the setup gap + Install Node runtime step
├── project.py               # which project; where the model directory is
├── engine.py                # running the engine; AtlasService (cache, backoff, last good)
├── links.py                 # element-link normalisation + the project fence
├── lint.py                  # model helpers + Atlas lint
├── nav.py                   # live navigation: resolve, best view, paths, steps, ViewerState
├── record.py                # autoplay timing model + the shot script
├── api.py                   # HTTP routes
├── tools.py                 # the five agent tools
├── skills/atlas/SKILL.md    # the LikeC4 authoring skill
├── examples/protoagent/     # a complete model of protoAgent (used by tests and CI)
├── tests/                   # host-free pytest suite
├── vendor/atlas-engine.mjs  # BUILT engine — committed
├── static/                  # BUILT viewer — committed
└── web/
    ├── engine.mjs           # engine source (→ vendor/)
    ├── stubs/               # bundle-require stub (no TS/JS configs)
    ├── src/                 # viewer source (→ static/)
    ├── test/                # node --test unit tests for the pure modules
    ├── dev/                 # dev server, mock harnesses, real-console checks
    ├── scripts/notices.mjs  # THIRD_PARTY_NOTICES.md generator
    └── licenses/            # license texts packages don't ship themselves
```

The backend modules are flat (not a package directory) because protoAgent loads the repo itself
as the `atlas` package. Host-only imports (`graph.*`, `infra.*`, `tools.fs_tools`, `runtime.*`)
stay inside functions and are guarded, so everything imports with no host.

## Building

`static/` and `vendor/` are **committed**: the plugin installs from git with no build step, and a
host may have no npm or network. Rebuild them in the same commit as the source change.

```bash
cd web
npm ci
npm run build          # build:engine + build:view + notices
```

| Script | Does |
|---|---|
| `npm run build:engine` | esbuild `engine.mjs` → `../vendor/atlas-engine.mjs` (node20 ESM, `bundle-require` aliased to the stub), plus `build/engine-meta.json` for the notices. |
| `npm run build:view` | Vite → `../static/`: `assets/atlas-<hash>.js` and a generated `index.html` with the inlined `atlas.css` and the pinned kit's `:root` token snapshot. |
| `npm run notices` | Regenerates `../THIRD_PARTY_NOTICES.md` from the modules both bundles actually contain (run after `build:engine`). |
| `npm test` | `node --test "test/*.test.mjs"`. |

The build is reproducible: rebuilding an unchanged tree leaves `static/` and `vendor/`
byte-identical, so a diff in them always means a real change.

> [!WARNING]
> **Known issue:** `npm run notices` (and so `npm run build`) currently exits 1 with
> *@protolabsai/ui 0.68.0 ships no license file*. The package declares MIT but ships no LICENSE,
> and its repository is private, so `web/licenses/protolabsai__ui-LICENSE.txt` must be added by a
> maintainer. `build:engine` and `build:view` still complete. Until then `THIRD_PARTY_NOTICES.md`
> doesn't list `@protolabsai/ui`.

When a dependency adds a package without a license file, `notices` names it; add its license to
`web/licenses/<scope__name>-LICENSE.txt`. A Graphviz version bump needs its `COPYING` text the
same way.

## Running locally

### The viewer dev server (no protoAgent)

[`web/dev/server.mjs`](../web/dev/server.mjs) stands in for the host and the Atlas backend: it
serves the built viewer, the pinned DS kit from `node_modules`, `/api/plugins/atlas/model` (the
real engine's export of `--model`, with ETag/304, last-good, and stale), `/status`,
`/api/fs/roots`, and a console-like harness page — at the root and under a fleet-style
`/agents/<slug>` prefix.

```bash
cd web && npm ci && npm run build:view     # the server serves ../static
node dev/server.mjs                        # http://localhost:4720
# then browse to http://localhost:4720/harness.html?src=/plugins/atlas/view&theme=dark
```

| Flag | Default |
|---|---|
| `--port` | `4720` |
| `--model <dir>` | `examples/protoagent` |
| `--project-root <dir>` | `$ATLAS_PROJECT_ROOT`, else the repo — where code links resolve |
| `--project <name>` | omitted, so the viewer resolves the name through `/api/fs/roots` |
| `--real-kit` | serve a console's built kit from `$PROTOAGENT_DIR/apps/web/dist/_ds` |

`POST /__mock?scenario=normal|empty|nonode&token=<t>&tours=0|1` switches scenarios (no model, no
Node, a required token, no tours file).

### The Playwright harnesses

Playwright isn't a dependency. Each script loads it from `$PLAYWRIGHT_FROM` — a directory whose
`node_modules` has `playwright` — and, as written, launches Playwright's Chromium headless shell
from the macOS arm64 cache (`~/Library/Caches/ms-playwright`; `npx playwright install` puts it
there). The mock-server ones need `dev/server.mjs` running:

| Script | Checks |
|---|---|
| `dev/drive.mjs` | Screenshots of every state: explore (fleet prefix, dark), code pane off, presenter, auto tour + reduced motion, live reload with an error banner, empty / engine-missing. |
| `dev/live-drive.mjs` | Live navigation: highlights, dims, edge paths, callouts, clear, operator takeover, `atlas.viewing`. |
| `dev/keyboard.mjs` | Presenter keys never steal Tab / Enter from controls; *Tour options* is a real menu. |
| `dev/framing-check.mjs` | Record framing at 1280×720, scale 2: every visible node inside the safe rect, nothing partly clipped, centred ±5 %. Writes a contact sheet. |
| `dev/measure-text.mjs` | On-screen text sizes per view at the present fit. |
| `dev/noflash.mjs` | Small text never flips visibility during a drill-in or a step move. |

```bash
node dev/server.mjs &
PLAYWRIGHT_FROM=/path/with/playwright node dev/framing-check.mjs --tour overview
# … PASS slide 8 · index — 6 shown, off-centre 0,-2 (±59,28)
# 18/18 frames pass
```

### An isolated protoAgent instance

To test inside a real console without touching your own agent, install your branch into a
throwaway box root from a protoAgent checkout:

```bash
export PROTOAGENT_BOX_ROOT=/tmp/atlas-dev PROTOAGENT_INSTANCE=atlas
cd /path/to/protoAgent
uv run python -m server plugin install file:///path/to/atlas-plugin --ref my-branch
uv run python -m server --port 7953
```

The installer clones a **committed** ref — commit first, and reinstall with `--force` after each
change. Enable Atlas in **Settings ▸ Plugins** (or add `atlas` to `plugins.enabled`), register the
project you're mapping under **Settings ▸ Filesystem**, and turn on the code pane in
**Tools ▸ Filesystem** to test code links. A fresh box root has no model connection; configure one
before chatting.

The real-console scripts default to `--host http://127.0.0.1:7953` and take `--token` (or
`$ATLAS_TOKEN`) when the console needs one:

| Script | Checks |
|---|---|
| `dev/console-framing.mjs` | **The in-console framing checker.** Drives the console exactly as the shot script does (rail → docks collapsed → *Tour options* → **Record**), then while the take plays: every ~100 ms nothing draws under the top chrome or the caption, the breadcrumb shows the slide's target within 300 ms, nothing is partial or clip-cut wherever the picture stops (≥ 150 ms still), and no frame is near-empty mid-move; at each settled slide and step, every node, compound, edge, and label chip is wholly inside the safe rect (or off-canvas / faded), the content is centred ±5 %, and the slide's subject is complete. Writes a contact sheet. Add [`dev/jumps.tour.json`](../web/dev/jumps.tour.json) to the host model's tours to test cousin jumps (`--tour-title 'Framing test: cousin jumps'`). |
| `dev/console-theme.mjs` | Light ↔ dark, a custom brand theme, transition timing. |
| `dev/console-bridge.mjs` | Code links (pane / editor routing, the pane-off hint), the node context menu, chord forwarding. |
| `dev/live-console.mjs` | Live navigation end to end: resolves `atlas.show` with Atlas's own tool logic ([`dev/resolve_show.py`](../web/dev/resolve_show.py); set `$ATLAS_PY` to a Python with `langchain_core`), publishes it on the bus, and reads `atlas.viewing` back. |

## Testing

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt ruff
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/pytest -q
cd web && npm ci && npm test
```

- **pytest is host-free.** [`tests/conftest.py`](../tests/conftest.py) registers the repo as the
  `atlas` package and provides a fake registry; `requirements-dev.txt` supplies fastapi,
  langchain-core, and pyyaml, which the host normally provides. The engine tests run the real
  `vendor/atlas-engine.mjs` against `examples/protoagent` and skip without Node 20+ on PATH.
  `tests/test_record.py` also validates the shot script with Campaign Studio's own
  `shotscript.py` when a campaign-plugin checkout is found (`$CAMPAIGN_PLUGIN_DIR`, else
  `~/dev/campaign-plugin`); otherwise that test skips.
- **`npm test`** covers the viewer's pure modules — `logic.mjs` (tours, links, search, keys, bus
  parsing, highlights, deep links, legibility), `framing.mjs`, `palette.mjs` — with `node --test`.
- **Pinned in both languages:** the autoplay timing (`record.py` ↔ `logic.mjs`; change
  `tests/test_record.py` and `web/test/record.test.mjs` together), and the auto tour order
  (`lint.auto_tour` ↔ `logic.mjs autoTour`).
- **Packaging contract** (`tests/test_packaging.py`): manifest and `pyproject.toml` versions
  agree, every setting is a config key, the view path is public and `static/` exempt, `register()`
  wires five tools, the `atlas.viewing` handler, the setup step, and the skill.

## CI and releases

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every PR and push to `main`:
Python 3.12 and Node 22, `ruff check` + `ruff format --check`, `pytest -q`, and
`node vendor/atlas-engine.mjs validate examples/protoagent` must report `ok`. Same-repo runs use
the org's Namespace runner (`vars.NSC_RUNNER`); PRs from forks run on `ubuntu-latest`. The web
unit tests aren't in CI — run `npm test` before you push.

### Release ritual

1. Bump `version` in **both** `protoagent.plugin.yaml` and `pyproject.toml` (a test enforces
   lockstep), and move the `CHANGELOG.md` entries under the new version.
2. Merge to `main` with a commit titled `chore: release vX.Y.Z` — or, when the bump rode in on a
   feature PR, run `gh workflow run Release`.
3. [`release.yml`](../.github/workflows/release.yml) calls the shared
   `protoLabsAI/release-tools` `plugin-release.yml@v2`, which reads the version from the
   manifest, tags `vX.Y.Z`, writes the release notes, posts to Discord, and creates the GitHub
   release. It's idempotent: an existing tag is skipped.

Never create the release by hand (`gh release create`) — the workflow owns tags and notes. Bump
`min_protoagent_version` when you use a newer host API, and update the comment above it.

## Extending Atlas

Each recipe names the files to touch and the tests to add. Keep the docs in step: the user-facing
pages are [README](../README.md), [user-guide.md](user-guide.md), [authoring.md](authoring.md), and
[agent-tools.md](agent-tools.md).

### Add an agent tool

1. In [`tools.py`](../tools.py) `build_tools()`, add an `@tool async def atlas_<name>(…) -> str`.
   Do blocking work (engine, files) through `await asyncio.to_thread(…)`; read the model with
   `service.current()` and tours with `service.current_tours()`. Return errors as text.
2. The docstring is what the model reads: a plain string literal, over 40 characters
   (`test_tool_docstrings_are_plain_literals`).
3. Append it to the returned list.
4. Tests: `tests/test_tools.py`, and add the name to the set in
   `tests/test_packaging.py::test_register_wires_everything`.
5. Update the manifest `description`, the README, and [agent-tools.md](agent-tools.md).

### Add a lint rule

1. In [`lint.py`](../lint.py), write `_lint_<rule>(model) -> list[dict]` returning findings
   `{"rule": "<kebab-name>", "message": …, "view" | "element" | "tour": …}`. Make the message
   say how to fix it. Model helpers (`views`, `elements`, `children_of`, `view_kind`,
   `steps_of`, `drilldowns`) are in the same file.
2. Add it to `lint()`, and to the module docstring's rule list.
3. Tests: `tests/test_lint.py` — a failing and a clean case.
4. Docs: the table in [authoring.md](authoring.md#lint-rules), §9 of the skill, and the
   `atlas_validate` docstring if it names the categories.

### Add a tour or slide field

A field has to survive three places, or the viewer silently drops it:

1. **Lint:** validate it in `lint.check_slide` (slides) or `_lint_tours` (tours), with range
   constants next to `HOLD_MIN_MS`.
2. **Viewer:** carry it through `cleanTours` in [`web/src/logic.mjs`](../web/src/logic.mjs) —
   it rebuilds every slide from known keys — and add it to the `Slide` / `Tour` types in
   `Presenter.tsx`, where it's used.
3. **Timing:** if it changes how long anything is on screen, change `record.py` **and**
   `logic.mjs` identically, plus `tests/test_record.py` and `web/test/record.test.mjs`.
4. Tests: `tests/test_lint.py`, `web/test/logic.test.mjs` (survives `toursFor`). Rebuild
   `static/`.
5. Docs: the field tables in [authoring.md](authoring.md#tours).

### Add a bus message

- **Agent → view:** emit from a tool with `registry.emit("atlas.<event>", payload)` (resolve and
  validate in Python first, as `atlas_show` does). In the viewer, add a topic constant in
  `logic.mjs` (next to `SHOW_TOPIC`), validate the payload against the model in a pure function,
  and dispatch it in `App.tsx`'s `message` handler — exact topic match only. The view already
  subscribes to `atlas.#`.
- **View → agent:** `post({type: 'protoagent:publish', topic: 'atlas.<event>', data})` from the
  view; in `__init__.py`, `registry.on("atlas.<event>", handler)`. Treat the payload as untrusted:
  sanitize it like `nav.sanitize_viewing` (known keys, types, bounded sizes).
- Declare it in the manifest's `emits` / `subscribes`. Tests: `web/test/live.test.mjs` or
  `bridge.test.mjs`, `tests/test_nav.py`. Document it in [agent-tools.md](agent-tools.md#bus-topics).

### Add a presenter transition

1. In [`web/src/Stage.tsx`](../web/src/Stage.tsx), `transition()` picks a kind (`in`, `out`,
   `fade`) and runs both layers' cameras on one timeline; `goNow()` routes a view change to one
   transition or a dive. Add the new kind there, with a reduced-motion path (a short fade).
2. Durations live in [`motion.ts`](../web/src/motion.ts) (`ZOOM_MS`, `FADE_MS`, `JUMP_MS`) and are
   multiplied by `factor()` (the speed setting).
3. If it changes how long a view change takes, update `VIEW_CHANGE_MS` / `SAME_VIEW_MS` /
   `view_change_ms` in `record.py` (measure with `dev/console-framing.mjs`, which prints the
   take's presenting → tour-done time) and `tests/test_record.py`.
4. Verify with `dev/framing-check.mjs`, `dev/noflash.mjs`, and in a real console
   `dev/console-framing.mjs` (nothing partial at rest, no empty frames mid-move).

### Map more theme tokens

1. [`web/src/theme.ts`](../web/src/theme.ts) `readTokens()` lists the `--pl-color-*` tokens read.
2. [`web/src/palette.mjs`](../web/src/palette.mjs) `buildPalette()` maps them onto LikeC4's colour
   names (pick every text colour with `readable()` so it's contrast-checked); `paletteCss()` emits
   the per-colour overrides and the chrome variables (chrome may use `var(--pl-*)` directly).
3. Viewer chrome CSS in `web/src/atlas.css` uses DS tokens only — no raw colours, no `var()`
   fallbacks.
4. Tests: `web/test/palette.test.mjs` (contrast for light, dark, and odd brand accents; missing
   tokens fall back). Check a real console with `dev/console-theme.mjs`.
