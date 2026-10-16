# Atlas user guide

How to explore, present, and record an architecture model in the console, and how the agent
narrates it with you. To write or change the model itself, see [Authoring](authoring.md).

- [Exploring](#exploring)
- [Presenting](#presenting)
- [Recording a walkthrough](#recording-a-walkthrough)
- [Live agent navigation](#live-agent-navigation)
- [Theming](#theming)
- [Troubleshooting](#troubleshooting)

## Exploring

Open **Atlas** from the console rail. The view loads the model's landing view (`index`) and
keeps polling for changes every 2 seconds while it's visible, so edits to the model appear on
their own. A reload keeps you on the view you were looking at, as long as it still exists.

### Moving around

| To | Do |
|---|---|
| Go into an element | Click the drill-down icon on its node, **Open drill-down ›** in the inspector, or right-click ▸ **Drill in**. The camera zooms into the node and the element's own view grows out of it. |
| Go back up | Click a level in the breadcrumb (`System context › protoAgent subsystems › …`). |
| Jump to any view | The view picker lists element views as an indented tree, then flows (marked `▶`). |
| Find something | Press **/** (or click *Search*) and type. Hits are elements and views, ranked by title, then id, technology, and description. **Enter** opens the first hit; **Esc** clears. Picking an element opens a view that shows it and selects it. |
| Reset the camera | The **⤢** button (*Fit view*). |

Unrelated views crossfade; a parent and child zoom through each other. The speed is the
`transition_speed` setting, and the OS *reduce motion* preference replaces zooms with short fades.

### The inspector

Click a node to open the inspector beside the diagram. It shows the element's kind, parent,
technology, summary and description, then:

- **Open drill-down ›** — when the element has its own view.
- **Ask about this** — drafts a question about the element in the chat box. It never sends;
  you edit and send it. Only shown on hosts that support it (protoAgent 0.206.0 or newer).
- **Links** — code links, web links, and other links from the model (see below).
- **Metadata** and **Tags** — as written in the model.
- **Appears in** — every view that shows the element as a node (its own drill-down aside).
- The element's id (its FQN, like `proto_agent.core.graph`) at the foot.

Click the canvas or **×** to close it.

### Code links

A code link points at a file (and optionally a line range) in the project. Each one gets:

- **View** — opens the file in the console's **code pane**, beside Atlas, at those lines.
- **Open in editor** — opens it in your external editor (**Settings ▸ Chat ▸ Open files in**).

Clicking the link chip itself does **View**; **⌘-click** (Ctrl-click) does **Open in editor**.
If the code pane is off, the inspector says so (*Turn on the code pane in Tools ▸ Filesystem*)
and links open in the editor instead. With neither a code pane nor an editor set up, the console
copies `project/path:line` to the clipboard and says so (outside the console, Atlas does the same
itself).

File paths written as `` `code` `` in a description, a tour note, or a callout are links too —
for example `` `src/graph/agent.py:40` `` or `` `src/graph/agent.py#L40-L58` ``.

> [!NOTE]
> On hosts older than the console change that routes **Open in editor** explicitly
> ([protoAgent#4241](https://github.com/protoLabsAI/protoAgent/pull/4241)), both buttons go where
> the console sends any code link: the code pane when it's on, else the editor.

### The context menu

Right-click a node (inside the console) for **Ask about this**, **View code**, **Open in
editor**, **Drill in**, **Show details**, **Present from here**, and **Copy element id**. Items
that don't apply are left out.

### Flows

A flow (a LikeC4 *dynamic view*, marked `▶` in the picker) is a numbered sequence of steps.
Open one and click **▶ Walk through N steps**; then **‹** / **›** move between steps and
**Stop** ends the walk.

### When the model has errors

If the model stops compiling, Atlas keeps showing the **last good version** with a red banner:
*N model errors — showing the last good version*, the first error's `file:line` and message, and
**+N more** to expand the rest. Click a `file:line` to open it in the code pane. The banner clears
as soon as the model compiles again. The last good model is saved in the plugin's store, so it
survives a restart.

## Presenting

A **tour** is an ordered list of slides, each a view (optionally with a focus, a flow step, and
a speaker note). Tours come from the model's `atlas.tours.json` ([Authoring](authoring.md#tours));
every model also has an automatic **Overview** tour (id `auto`): the landing view, then each
drill-down view in model order, then each flow.

Start one with **P** or **▶ Present** (the first tour, from the slide showing the current view),
or pick a tour from **▾** (*Tour options*): **Present**, **Autoplay**, or **Record** each tour.

### Keys

Keys act on the diagram. On a button, link, menu, or field, **Tab**, **Enter**, and **Space**
keep their usual meaning and only **Esc** belongs to the presenter. **Tab** is never captured.

| Key | Does |
|---|---|
| **→** **Space** **PgDn** | Next slide. On a slide that shows a whole flow, walks its steps first. |
| **←** **PgUp** | Previous slide (or step). |
| **Home** / **End** | First / last slide. |
| **1**–**9**, **0** | Jump to slide 1–9; **0** is slide 10. |
| **Enter** | Drill into the focused node. |
| **Esc** / **Backspace** | Step out: stop a walk, then unfocus the node, then go up a level; at the top level, leave the presenter. |
| **.** / **,** | Focus the next / previous node. |
| **N** | Show / hide the notes panel. |
| **F** | Fullscreen. |
| **[** / **]** | Slower / faster transitions (`fast` · `normal` · `slow`), for this session. |

Clicking a node focuses it. The top bar has a tour picker (when there's more than one tour), the
slide counter, and **×** to exit. Each slide always shows its whole subject; on a busy view small
text hides and titles shrink to stay readable. Only if that still isn't legible does the presenter
frame the part the caption names, and then it shows **Fit all** to see the whole view.

### Notes and speed

The notes panel shows the slide's note (markdown-light: `**bold**`, `*em*`, `` `code` ``, and
`[links](https://…)`). On a slide that walks a whole flow, each step's own note replaces it as you
step. The caption changes when the camera arrives, not when you press the key.

### Autoplay

**Autoplay** runs the tour by itself. Each slide stays up, after its camera settles, for its
`hold_ms` — or by default its note's reading time: 1.2 s plus 260 ms a word, between 2.5 and 15 s.
A slide showing a whole flow then walks every step, each held for its own caption's reading time.
Press any presenter key to take over; autoplay stops.

## Recording a walkthrough

**Record** is autoplay for the camera: notes become large centred captions, and the toolbar, key
hints, toasts, the cursor, and hover states are gone. Keys still move the tour, but don't stop it.

### The end of a take

After the last slide, the last caption stays up a little longer (the tour's `end_hold_ms`,
default 1.5 s — and at least 5 s on screen in all), fades out over 400 ms, then the bare diagram
holds a clean beat (`end_beat_ms`, default 1 s). Only then does the take end. Both fields are
[set per tour](authoring.md#tour-fields).

### Recorder hooks

The view's `<html>` element carries stable attributes a recorder can wait on:

| Attribute | Values |
|---|---|
| `data-atlas-state` | `loading` → `ready` → `presenting` → `tour-done` |
| `data-atlas-slide` | the current slide, 1-based (while presenting) |
| `data-atlas-view` | the current view id |

For example, a recorder waits for the end with
`wait_for: {selector: "[data-atlas-state=tour-done]", frame: "/plugins/atlas/view"}`.

### Deep links

Opened directly (not inside the console), the view page accepts a hash:

- `/plugins/atlas/view#tour=overview&slide=1&present=1&autoplay=1&record=1` — start a tour.
  `record=1` implies autoplay unless `autoplay=0`.
- `/plugins/atlas/view#view=chat_turn_flow&focus=gateway&step=3` — open a view, highlight
  elements (comma-separated), and go to a flow step.

The console doesn't forward a hash into a plugin view's iframe, so inside the console use the
*Tour options* menu — that's what the shot script does.

### Recording with Campaign Studio

Ask the agent to record a tour; it calls [`atlas_record_script`](agent-tools.md#atlas_record_script),
which writes a shot script in Campaign Studio's YAML format. The script opens the console, clicks
**Atlas**, waits for `ready`, collapses the console's side and bottom docks so Atlas fills the
content area, opens *Tour options* ▸ **Record — ‹tour title›**, marks `start`, waits for
`tour-done`, and marks `end`. The footage between the marks is one continuous take — no cuts.
The tool also returns the expected duration, from the same timing model the viewer runs.
The script records the console the agent runs in — the URL it is served on — and never guesses a
port; if the agent can't tell its own URL, the tool asks for `base_url` instead.

Atlas's text sizes are tuned for crisp 2K frames: the framing and legibility checks run at a
1280×720 viewport with device scale 2 (2560×1440). The shot script sets the viewport
(`viewport`, default `1280x800`); the capture scale is the recorder's setting.

Planned on the recorder side: producing finished clips from a chat request
([campaign-plugin#18](https://github.com/protoLabsAI/campaign-plugin/issues/18)), an audio bed
([#19](https://github.com/protoLabsAI/campaign-plugin/issues/19)), and TTS voiceover synced to tour
captions ([#20](https://github.com/protoLabsAI/campaign-plugin/issues/20)).

## Live agent navigation

The agent can drive the open Atlas view while you talk. Ask *"walk me through a chat turn"* or
*"what talks to the gateway?"* and it will:

- open the view that best shows an element, or that element's own drill-down;
- highlight several elements at once — everything else dims and the camera fits them;
- highlight the relationship between two elements, or the shortest path between them;
- pin a short **callout** (up to 280 characters) to the first highlighted node;
- step through a flow, one step at a time, relative to where you are;
- start a tour or presenter mode at any slide;
- open the exact code in the code pane beside the diagram (core's `show_code` tool).

A highlight stays until the agent clears it or you click a node — your click wins. **×** on a
callout dismisses it.

### The agent can see what you see

The view reports what you're looking at — the view, the flow step, the selected element,
highlights, and whether you're presenting — so the agent can say *"the node you've selected…"*
or step *next* from where you are. It reports when this changes, every 30 s while visible, when
the tab is hidden, and when the view closes. The agent treats it as untrusted data, not as
instructions ([trust model](agent-tools.md#atlasviewing-and-its-trust-model)).

The full tool reference, with example narration loops, is in [Agent tools](agent-tools.md).

## Theming

Atlas follows the console's theme — light, dark, or a custom brand theme — live, with no
reload. It reads the console's design-system colours and maps them onto LikeC4's palette, checking
text contrast on every fill. A model's `color` names (`primary`, `secondary`, `muted`, `slate`,
`gray`, `blue`, `indigo`, `sky`, `red`, `green`, `amber`) take theme colours: `primary` is the
accent, `red` / `green` / `amber` / `blue` the status colours. There is nothing to configure.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **"Atlas needs Node.js 20+"**, or a setup banner | No usable Node. Click **Install Node runtime** on the banner, or set **Node.js path** to a Node 20+ executable. The card lists what was tried (`node_path`, PATH, managed runtime) and why each failed. If the install fails, the banner says why and offers a retry. |
| **"The layout engine (vendor/atlas-engine.mjs) is missing"** | The plugin install is incomplete. Reinstall or update Atlas. |
| **"No architecture map yet"** | No model directory. The card shows where Atlas looked (`<project>/architecture`). Ask the agent to map the project, or point **Model directory** at the right place. |
| The model is in a **different project** | Set **Project** to the filesystem project's name. Blank picks the project holding the console's project root, else the first registered one. |
| **"The architecture model doesn't compile yet"** | The model has errors and there's no earlier good version to show. Click a `file:line` to open it; ask the agent to run `atlas_validate`. |
| **"N model errors — showing the last good version"** | A recent edit broke the model. The diagram you see is **stale** until the errors are fixed. |
| **"…leaves the model directory — Atlas only reads the model's own folder"** | An `include` path in `likec4.config.json`, or a symlink, points outside the model directory. Atlas refuses the whole model rather than read files from elsewhere. |
| **"can't verify its `include` (not strict JSON)"** | The config uses JSON5 syntax (comments, trailing commas) *and* has an `include`. Use strict JSON. |
| **"likec4.config.ts/.js is not supported"** | Atlas's engine reads JSON configs only. Use `likec4.config.json`. |
| **"the layout engine timed out after 20s"** / **"crashed"** | Atlas retries after 5 s, doubling up to a minute while the files stay the same. Check the error text; a very large model may need splitting. |
| A code link does nothing, or is listed as plain text | The link leaves the project root, so Atlas never offers it as code (`atlas_validate` reports `code-link-outside`). Use a project-root path: `link /src/app.py`. |
| A code link opens the wrong file | Links starting with `/` are relative to the **project root**, not the model folder. Check **Project**. |
| **"Not authorised (HTTP 401)"** | The page was opened outside the console, without a token. Open Atlas from the console rail. |
| *Ask about this* is missing | The host is older than 0.206.0, or the view is open outside the console. |
| A highlight disappeared | You clicked a node — the agent's highlight yields to you. |
| The page is blank behind a reverse proxy | protoAgent sets no Content-Security-Policy. If your proxy adds one, the view page needs inline `<script>` and `<style>` (its bootstrap and theme) and same-origin module scripts. It makes no requests to any other origin. |
