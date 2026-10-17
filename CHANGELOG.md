# Changelog

All notable changes to Atlas. Versions follow `version` in `protoagent.plugin.yaml`.

## [0.2.5]

### Added

- **`atlas_show(caption=…)`: a narration bar under the diagram.** One plain sentence (≤ 280 characters)
  in a DS-styled caption bar below the canvas, so it never covers a node. It persists across shows
  until a new caption replaces it; `""` or `atlas_clear` removes it. Sized for recording (20–30 px).

### Fixed

- **A note on a flow step is no longer refused** ([#14](https://github.com/protoLabsAI/atlas-plugin/issues/14)).
  `atlas_show(view=…, step=N, note=…)` with nothing else highlighted now anchors the note to the
  step's target node, the way the walkthrough's own captions read.

## [0.2.4]

### Fixed

- **`atlas_show` from the console's own chat turn now moves the view** ([#11](https://github.com/protoLabsAI/atlas-plugin/issues/11)).
  The tool emits `atlas.show` and then asks the console to open Atlas. In the console that owns the
  turn, that navigate remounts an already-open view
  ([protoAgent#4283](https://github.com/protoLabsAI/protoAgent/issues/4283)), and the fresh page
  missed the show, so the diagram stayed on System context. The backend now keeps the latest show or
  clear, gated at `GET /api/plugins/atlas/last-show`. A view that mounts applies it while it is under
  15 s old, and bus events carry a `show_seq`, so a request delivered both ways applies once.

## [0.2.3]

### Changed

- **Atlas opens in the right sidebar** (`placement: right`), so chat stays open on the left while
  the agent drives the diagram with `atlas_show`. An operator can drag the icon to the left rail,
  and the console keeps that; an existing install keeps the rail it already has.
- **Narrow panels** (the right sidebar is 360 px by default): the inspector floats over the canvas
  instead of squeezing it; the toolbar drops the breadcrumb and keeps **Present** whole; a highlight's
  callout moves off the other highlighted nodes (below its anchor, else the canvas's top or bottom
  edge).
- **Recording** collapses the dock Atlas is *not* in (the left one when Atlas is in the right
  sidebar), so the take still fills the content area.

### Fixed

- In a narrow panel a walkthrough step's subject could be hidden by the at-rest cull when the
  framing fit it flush to the safe area. The cull now uses a screen-pixel tolerance and never hides
  the slide's subject; the framing never zooms past the subject's own fit to make it legible.

## [0.2.2]

### Changed

- **`atlas_record_script` resolves its own console through core's `graph.sdk.console_url()`**
  ([protoAgent#4256](https://github.com/protoLabsAI/protoAgent/issues/4256)) when the host has it:
  `A2A_PUBLIC_URL`, else the running server's bound host/port — and on a hub-spawned fleet member,
  the member's own console rather than the hub's `/agents/<id>` tenant path, which isn't a console
  base. Older hosts keep 0.2.1's rule (`A2A_PUBLIC_URL`, else the bound port). The placeholder
  `public_base_url` probe is gone (core never shipped it).

## [0.2.1]

### Fixed

- **`atlas_record_script` records the agent's OWN console** ([#7](https://github.com/protoLabsAI/atlas-plugin/issues/7)).
  A blank `base_url` used to fall back to `http://localhost:7870`, protoAgent's default port, so on a
  machine running several agents it could record a different (live) console. It now uses the URL
  this agent is served on — a core `public_base_url` seam when the host has one
  ([protoAgent#4256](https://github.com/protoLabsAI/protoAgent/issues/4256)), else the A2A card's rule:
  `A2A_PUBLIC_URL`, else the port the running server bound — and refuses when that can't be known
  (`base_url is required: pass the URL this agent's console is served on`). A `base_url` that isn't
  this agent's own console gets a warning in the result. The docs no longer show a `:7870` example.

## [0.2.0]

Live agent navigation, recording mode, 2K legibility and framing, and design-system adoption
([#1](https://github.com/protoLabsAI/atlas-plugin/pull/1), [#2](https://github.com/protoLabsAI/atlas-plugin/pull/2),
[#4](https://github.com/protoLabsAI/atlas-plugin/pull/4)). Needs protoAgent 0.182.0.

### Added

- **Live navigation.** `atlas_show` gains `element` (the smallest view showing it, or its own
  drill-down with `drill`), multi-element `focus`, `relations` (the edges or shortest path between
  two elements), `note` (a callout pinned to the highlight), and relative flow steps
  (`step="next"` / `"prev"` / `"first"` / `"last"`). Unknown ids get close-match suggestions.
- `atlas_clear` and the `atlas.clear` topic remove highlights and callouts.
- **Operator awareness.** The view publishes `atlas.viewing` (view, step, selection, highlights,
  presenter state); `atlas_describe(current=True)` reports it as untrusted viewer data.
- **Ask about this** — drafts a question about an element in the chat box (hosts ≥ 0.206.0).
- **Recording mode.** Autoplay and Record for every tour from the *Tour options* menu; caption
  notes; `data-atlas-state` / `-slide` / `-view` recorder hooks; deep links; and
  `atlas_record_script`, which writes a Campaign Studio shot script with the expected duration.
- **Tour timing fields:** slide `hold_ms` (500–60000), tour `end_hold_ms` (0–30000) and
  `end_beat_ms` (0–5000), all linted.
- A slide showing a whole flow walks every step, each captioned from its own `notes`; new lint
  `tour-step-skip` flags hand-picked steps that skip.
- **Legibility for present and record:** scaled titles and edge labels, illegible text hidden,
  densest-window framing with **Fit all**, crisp edge labels, and no text flashing during moves.
- **Safe-area framing:** the camera fits each slide between the measured chrome and caption, never
  shows a node partly at rest, and keeps the slide's subject complete.
- The example tour is now *protoAgent in 85 seconds*, with a captioned 10-step chat-turn flow.

### Changed

- **Design-system adoption:** `@protolabsai/ui` 0.68.0 components (buttons, inputs, select,
  menu, toasts, chips, inspector header), token-only CSS, and keyboard ownership — presenter keys
  act only on the diagram, never on a focused control. Node focus moved from Tab to `.` / `,`.
- A cousin or multi-level jump is one continuous move; flow-step moves fly on one eased path.
- The shot script collapses the console's side and bottom docks so Atlas fills the frame.

### Fixed

- Nested elements resolve through their ancestors' views.
- The viewer treats `atlas.viewing` as untrusted, acts only on the exact `atlas.show` /
  `atlas.clear` topics, and sends a 30 s heartbeat.
- The shot script: chunked waits that fit the recorder's 3-minute cap, ASCII-safe YAML, `http(s)`
  `base_url` only, clean menu titles.

## [0.1.0] — 2026-10-15

First release ([v0.1.0](https://github.com/protoLabsAI/atlas-plugin/releases/tag/v0.1.0)).

### Added

- Atlas: drill-down architecture diagrams from a project's LikeC4 model, as a console view —
  explore (drill-down, breadcrumb, view picker, search, inspector) and present (tours, keyboard,
  synced-camera zoom between levels, speaker notes, automatic Overview tour).
- A vendored, offline layout engine (LikeC4 1.60.0 + Graphviz WASM) that needs only Node ≥ 20 —
  `node_path`, PATH, or protoAgent's managed runtime, with a one-click setup banner.
- Live reload: the view polls with ETags and keeps the last good model, with an error banner,
  while the sources have errors.
- Agent tools `atlas_validate`, `atlas_describe`, and `atlas_show` (a view, step, focus, or tour
  slide, emitted as `atlas.show`), and the `atlas-likec4` authoring skill, verified against
  LikeC4 1.60.0.
- Code links open in the console's code pane, or the editor on ⌘/Ctrl-click.
- Theming from the console's design system, live; a `transition_speed` setting.
