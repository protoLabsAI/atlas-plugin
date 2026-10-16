# Authoring models and tours

How to write an Atlas model and its tours, and what `atlas_validate` checks. Usually the agent
does the writing — the bundled skill ([`skills/atlas/SKILL.md`](../skills/atlas/SKILL.md)) is its
LikeC4 reference, with the syntax and every common error verified against LikeC4 1.60.0. This
page covers what's specific to Atlas; for LikeC4 syntax, read the skill or
[likec4.dev](https://likec4.dev).

- [Where the model lives](#where-the-model-lives)
- [Atlas conventions](#atlas-conventions)
- [Flows with per-step notes](#flows-with-per-step-notes)
- [Tours](#tours)
- [Lint rules](#lint-rules)
- [The validation loop](#the-validation-loop)

## Where the model lives

The model is a directory of LikeC4 files — by default `<project>/architecture/` (the
`model_dir` setting; relative to the project root, or absolute). [`examples/protoagent/`](../examples/protoagent)
is a complete one:

```text
architecture/
├── likec4.config.json   # required: {"name": "<project>"}
├── spec.c4              # specification: element kinds, tags, colours
├── model.c4             # the elements and relationships
├── views.c4             # views: index, one scoped view per parent, flows
└── atlas.tours.json     # optional: presenter tours
```

Every `.c4`, `.likec4`, or `.like-c4` file under the folder is merged into one model
(subfolders included; `node_modules`, `.git`, `.svn`, `.yarn`, `.pnpm` skipped).

**The config is JSON only.** Use `likec4.config.json` (`.likec4rc` and `.likec4.config.json` are
also read). Atlas's engine doesn't load `likec4.config.ts` / `.js`. An `include` in the config
must stay inside the model folder, and must be strict JSON so Atlas can check it — otherwise
Atlas refuses the model. Symlinks leaving the folder are refused the same way. Up to 5,000 model
files.

## Atlas conventions

Atlas works with any valid LikeC4 model, but these make it read well in a console panel. The
skill's §8 has the long form.

1. **One model, many views.** Declare each element once, in `model`; views only select from it.
2. **Levels:** `system` → `container` → `component`. Actors and external systems at the top.
3. **A scoped view for every parent.** `view <fqn_with_underscores>_detail of <fqn> { include * }`.
   That's what makes a node clickable: the first scoped view of an element becomes its drill-down,
   and every other view's node for it links there. A parent without one is flagged
   (`no-drilldown`).
4. **At most 12 nodes per view** (`busy-view`). A view any busier is unreadable in a console
   panel. Group children into sub-systems (a `subsystem` kind) with their own scoped views.
   `include *` in a scoped view also pulls in neighbours its children talk to — count them.
5. **Stable snake_case ids** (`proto_agent`, `tool_loop`). View ids, FQNs, tours, and deep links
   all derive from them. Titles carry the display text.
6. **Code links are project-root paths.** A leading `/` means the **project root**, not the model
   folder — so `link /src/graph/agent.py#L10-L40 'Source'` is right wherever the `.c4` file lives.
   Line fragments: `#L10`, `#L10-L20`, `#L10-20`, `#10`. `./` and `../` links are relative to the
   `.c4` file. Anything that leaves the project root is never offered as a code link
   (`code-link-outside`).
7. **Metadata** is shown in the inspector as written. Atlas's convention is `adr` (a string, or an
   array of ADR numbers as strings) and `owner`. Values must be quoted strings, arrays, or
   booleans — `adr '0023'`, not `adr 23`.

```likec4
model {
  proto_agent = system 'protoAgent' 'LangGraph agent runtime' {
    link /README.md 'README'
    core = subsystem 'Agent core' 'The LangGraph agent and what it calls' {
      graph = container 'Agent graph' 'Tool loop, subagents, middleware' 'LangGraph' {
        link /src/graph/agent.py 'Source'
        metadata {
          adr ['0004', '0118']
          owner 'core'
        }
      }
    }
  }
}

views {
  view index { include * }
  view proto_agent_detail of proto_agent { include * }
  view proto_agent_core_detail of proto_agent.core { include * }
}
```

## Flows with per-step notes

A flow is a `dynamic view`. Give each step a one-sentence `notes` — it becomes that step's
caption in the presenter and in recordings. Without one, the caption is `From → To: label`.

```likec4
views {
  dynamic view chat_turn_flow {
    title 'Chat turn'
    operator -> proto_agent.interfaces.console 'sends message' {
      notes 'You send a message in the console.'
    }
    proto_agent.interfaces.console -> proto_agent.interfaces.server.chat 'POST /a2a' {
      notes 'The console posts it to the server.'
    }
    proto_agent.core.graph.agent_core <- proto_agent.core.tools 'result' {
      notes '…and feeds the result back to the model.'
    }
  }
}
```

A tour slide that shows a flow with no `step` walks **every** step, each held for its caption's
reading time. Prefer that to hand-picking a few `step` slides — skipping steps reads as skipping
half the flow (`tour-step-skip`).

In a `variant sequence` flow, don't use an element and one of its descendants: LikeC4 turns the
ancestor into a frame and silently drops its steps (`sequence-nesting`). Use leaf elements, or
one level of a branch.

## Tours

Tours live in `atlas.tours.json`, next to the config. Without the file, the viewer still has the
automatic **Overview** tour (id `auto`): `index`, then each scoped view in model order, then each
flow. Don't name a tour of your own `auto`: the agent tools always mean the automatic tour by it.

```json
{
  "tours": [
    {
      "id": "overview",
      "title": "protoAgent in 85 seconds",
      "end_hold_ms": 1500,
      "slides": [
        { "view": "index", "focus": "proto_agent",
          "note": "**protoAgent**: a self-hosted runtime for your own AI agents." },
        { "view": "proto_agent_detail", "via": "proto_agent",
          "note": "Inside: the **interfaces**, the **agent core**, and **platform services**." },
        { "view": "chat_turn_flow", "note": "Follow one chat turn." },
        { "view": "chat_turn_flow", "step": 5, "hold_ms": 6000,
          "note": "Every completion goes through the gateway." }
      ]
    }
  ]
}
```

### Tour fields

| Field | Type | Range | Meaning |
|---|---|---|---|
| `id` | string | unique | How tools and deep links name the tour (`tour="overview"`). |
| `title` | string | | Shown in the presenter and in the *Tour options* menu (`Record — <title>`). Line breaks become spaces. |
| `slides` | array | ≥ 1 | The slides, in order. |
| `end_hold_ms` | integer | 0–30000 | Record / autoplay: extra time on the last caption before it fades. Default 1500, topped up so the last caption is on screen at least 5 s in all. An explicit value is used as is. |
| `end_beat_ms` | integer | 0–5000 | Record / autoplay: the clean diagram, with no caption, before the take ends. Default 1000. |

### Slide fields

| Field | Type | Range | Meaning |
|---|---|---|---|
| `view` | string | **required**; a view id | The view the slide shows. |
| `focus` | string, or list of strings | element FQNs | The element to focus. A single focus is framed with its direct neighbours; a list highlights them all and dims the rest. See the note below. |
| `via` | string | an element FQN | The node to zoom *through* when entering this view from the previous slide's view. Only needed when nothing else links the two: Atlas already zooms through a node that drills into the view, or the node of the view's scope element. Otherwise the views crossfade. |
| `step` | integer | 1 … the flow's step count; dynamic views only | Show one flow step. Omit it on a flow slide to walk every step. |
| `note` | string | | The speaker note / caption. Markdown-light: `**bold**`, `*em*`, `` `code` `` (file paths become code links), `[text](https://…)`, blank-line paragraphs. Keep it to one or two sentences. |
| `hold_ms` | integer | 500–60000 | Autoplay / record: how long the slide stays up after its camera settles. Default: the note's reading time, 1.2 s + 260 ms a word, clamped to 2.5–15 s. |

> [!WARNING]
> **A list `focus` isn't shown yet.** The linter accepts `focus` as a list, but the current viewer
> keeps a slide's `focus` only when it's a single string naming a node in that view; a list (or
> an id that isn't a node there) is dropped and the slide shows the whole view. Tracked in
> [atlas-plugin#5](https://github.com/protoLabsAI/atlas-plugin/issues/5).

The viewer also drops a slide whose `view` doesn't exist, and a `step` or `hold_ms` out of range,
rather than fail — `atlas_validate` is where you find out.

## Lint rules

`atlas_validate` runs LikeC4's own validation (reported as `Engine:` errors, `file:line message`)
and then these Atlas checks (reported as `Lint:` findings, `[rule] message`). A malformed
`atlas.tours.json` is an engine-level error: `atlas.tours.json:2 atlas.tours.json: Expecting value`.

| Rule | Fires when | Example finding |
|---|---|---|
| `no-drilldown` | An element has children but no scoped view, so its node isn't clickable. | `shop has 2 child element(s) but no scoped view — add `` `view shop_detail of shop { include * }` `` |
| `code-link-missing` | A code link's file doesn't exist in the project. | `shop: code link /src/missing.py → src/missing.py does not exist in the project` |
| `code-link-outside` | A file link escapes the project root (lexically or through a symlink). | `shop: link ../../../etc/passwd is outside the project` |
| `sequence-nesting` | A `variant sequence` flow uses an element and one of its descendants. | `sequence view seq uses both shop and its descendant shop.api — LikeC4 drops such steps; use one level` |
| `tour-duplicate` | Two tours share an `id`. | `tour id 't' is used twice` |
| `tour-empty` | A tour has no slides. | `tour t has no slides` |
| `tour-end-hold` | `end_hold_ms` isn't an integer in 0–30000. | `tour t end_hold_ms 99999 must be an integer between 0 and 30000` |
| `tour-end-beat` | `end_beat_ms` isn't an integer in 0–5000. | `tour t end_beat_ms -1 must be an integer between 0 and 5000` |
| `tour-slide` | A slide is broken: not an object, no `view`, an unknown view, a `focus` / `via` that isn't an element, a `step` on a non-flow view or out of range, or `hold_ms` outside 500–60000. | `tour t slide 4: step 2 on index, which is not a dynamic view` |
| `tour-step-skip` | Consecutive slides on the same flow jump over steps. | `tour t slide 3: step 1 → 3 on seq skips 1 step(s) — one slide with no `` `step` `` walks them all (each captioned from its step `` `notes` ``)` |
| `empty-view` | A view's include rules match nothing. | `view nothing has no nodes — its include rules match nothing` |
| `busy-view` | A view has more than 12 nodes. | `view big_detail shows 14 nodes (max 12) — group elements into sub-systems with their own scoped views` |

The other `tour-slide` messages: `slide has no `` `view` ``, `unknown view 'missing'`,
`focus 'ghost' is not an element`, `via 'nope' is not an element`,
`step 9 is out of range for seq (1–3)`, `hold_ms 100 must be an integer between 500 and 60000
(milliseconds)`, and `tour t slide 7 is not an object`.

## The validation loop

1. Edit the `.c4` files or `atlas.tours.json` with the file tools.
2. Run `atlas_validate`. It uses the same engine the viewer does.
3. Fix the **first** error in each file first — a parse error cascades into a long
   `Expecting: one of these possible Token sequences…` list (Atlas clips each message to 300
   characters).
4. Repeat until it says `Engine: OK` and `Lint: clean`.

A clean run looks like this:

```text
Atlas model /path/to/project/architecture (project my-project) — 8 views, 34 elements
Engine: OK
Lint: clean
```

While the model has errors, the open view keeps showing the last good version with an error
banner, so nobody watching sees a blank diagram mid-edit.

You can also run the engine directly — handy in CI:

```bash
node vendor/atlas-engine.mjs validate examples/protoagent
# {"ok":true,"errors":[],"ms":153}
```

`export` prints the same plus the laid-out model (`"model": {...}`). The engine exits 0 even when
the model has errors; a non-zero exit means the engine itself crashed. It runs only the LikeC4
checks — the lint rules above need `atlas_validate`.
