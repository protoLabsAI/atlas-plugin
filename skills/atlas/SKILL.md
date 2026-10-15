---
name: atlas-likec4
description: Author LikeC4 architecture models (.c4 files) for the Atlas plugin — one model, drill-down views (context → containers → components), dynamic flow views, links to source. Use when creating or editing .c4/.likec4 files or fixing `likec4 validate` errors.
---

# Writing LikeC4 for Atlas

Verified against **likec4 1.60.0**. Every snippet here is an excerpt of a project under
`examples/` that passes `likec4 validate` (`bash examples/check.sh` re-proves it).
LikeC4 is **not** Mermaid and **not** Structurizr. Don't carry those habits over (see *Common mistakes*).

## 1. Project layout

A project is a directory holding `likec4.config.json`. Every `.c4`/`.likec4` file below it
(recursively, `node_modules` excluded) is merged into **one** model. A file may contain
any of the top-level blocks `specification`, `model`, `views`, `global`, `deployment`, and each can repeat.

```json
{
  "$schema": "https://likec4.dev/schemas/config.json",
  "name": "atlas",
  "title": "protoAgent Atlas",
  "exclude": ["**/node_modules/**", "**/.venv/**"]
}
```
`name` is required. Useful extra key: `"implicitViews": true` auto-generates a scoped view
for any element that lacks one, which Atlas does **not** rely on (see §8).

## 2. `specification`: declare everything before using it

Element kinds, relationship kinds, tags and custom colors **must be declared**. There are no built-in
kinds (not even `system`, `container`, `person`, `softwareSystem`).

```likec4
specification {
  element actor { style { shape person } }
  element system
  element container
  element component
  element database { style { shape cylinder } }

  relationship async { line dashed }

  tag deprecated { color gray }
  tag external

  color brand #3B82F6
}
```
- Shapes: `rectangle` (default) `component` `storage` `cylinder` `browser` `mobile` `person` `queue` `bucket` `document` `agent`.
- Colors: `primary` `secondary` `muted` `slate` `blue` `indigo` `sky` `red` `gray` `green` `amber`, or a name you
  declared with `color <name> #hex`. A raw `#hex` inside `style {}` is a parse error.
- Line: `solid` `dashed` `dotted`. Sizes (`size`, `textSize`, `padding`): `xs sm md lg xl`.

## 3. `model`: elements, nesting, relationships

`<id> = <kind> '<title>' '<summary>' '<technology>'` (all positional strings optional), or `<kind> <id> '<title>'`.
Ids: letters, digits, `_`, `-`; they can't start with a digit and can't contain `.`. Dots join FQNs: `agent.server.api`.

```likec4
model {
  user = actor 'Operator' 'Uses the console'

  agent = system 'protoAgent' {
    description 'LangGraph agent runtime'

    server = container 'Server' {
      technology 'FastAPI'
      link ./src/server/app.py#L1-L40 'Entrypoint'
      metadata {
        adr '0023'
        owner 'core'
      }
      api = component 'A2A endpoint'
    }
    graph = container 'Agent graph' 'Tool loop + subagents' 'LangGraph'
    store = database 'Session store' {
      #deprecated
      technology 'SQLite'
    }

    server -> graph 'submits message'
    graph -> store 'reads/writes' {
      technology 'SQL'
    }
  }

  gateway = system 'LiteLLM gateway' {
    #external
    style {
      color brand
    }
  }

  user -> agent.server.api 'chats via A2A'
  agent.graph -[async]-> gateway 'calls model'
}
```
Rules the validator enforces:
- Inside `{ }` the order is **`#tags` first**, then properties (`title`, `description`, `technology`, `link`, `metadata`, `style`),
  then **child elements and relationships last**. A property after a child is a parse error.
- Relationship: `src -> dst 'title' 'description' 'technology'` (positional), or a body with `technology`, `description`,
  `#tag`, `link`, `metadata`, `navigateTo`. Kinded: `src -[async]-> dst`. Both ends must exist (they may be declared later).
- Name resolution: inside a parent's block, sibling short names work (`server -> graph`). A short name also resolves
  elsewhere **in the same file** if it is unique. **In a different file, use the full FQN** (`agent.graph`).
  Top-level ids work everywhere.
- `metadata` values: quoted strings, `['a', 'b']` arrays, or `true`/`false`. Bare numbers fail, so write `adr '0023'`, not `adr 23`.

## 4. Links (verified resolution rules)

`link <uri> ['label']`. The URI is **unquoted** and must start with a scheme (`https://`, `vscode://`, …),
`./`, `../`, or `/`. A bare `graph/agent.py` or a quoted `'./x'` is a parse error. `#L10` and `#L10-L20` are allowed.
Links are never checked for existence. In `likec4 export json`, each link gets a `relative` field:

| written in `atlas/model.c4` | exported `relative` (relative to the **config dir**) |
|---|---|
| `link /graph/agent.py#L1-L2` | `graph/agent.py#L1-L2` (leading `/` = project root) |
| `link ./src/x.py` | `atlas/src/x.py` (`./` and `../` are relative to the **.c4 file**) |
| `link ../../../x.py` (escapes project) | `file:///abs/path/x.py` (machine-specific; avoid) |
| `link https://…` / `vscode://…` | no `relative`; kept as is |

## 5. `views`: static views and predicates

```likec4
views {
  view index {
    title 'System context'
    include *
    autoLayout LeftRight
  }

  view agent_detail of agent {
    title 'protoAgent containers'
    include *
    style agent.store {
      color muted
    }
  }
}
```
- `view index` is the landing view. Unscoped `include *` = top-level elements.
- `view <name> of <fqn>` is **scoped**: `*` = the element, its children, and their neighbours. Short names resolve inside the scope.
- **Drill-down:** the first scoped view of an element becomes its *default view*. On every other view that element's
  node gets `navigateTo` that view, so clicking it zooms in. No scoped view means no click-through. Verified in export JSON:
  `index` → `agent` node has `navigateTo: "agent_detail"`.
- View properties (`title`, `description`, `#tag`, `link`) must come **before** any predicate.
- Predicates run in order. `exclude` only removes what was already included.

Predicate cheat-sheet (from `examples/predicates`):
```likec4
  view graph_neighbours {
    title 'Who talks to the graph'
    include agent.graph, * -> agent.graph, agent.graph -> *
  }

  view server_to_graph {
    include agent.server.*
    // adds agent.graph only if it relates to something already visible
    include -> agent.graph ->
  }

  view server_children {
    include agent.server.*
    include console, llm
    include agent.server.* -> agent.graph with {
      color red
      line solid
    }
    include agent.graph with {
      title 'Agent graph (LangGraph)'
      navigateTo agent_detail
    }
    style agent.server.* {
      color green
    }
    autoLayout LeftRight 120 80
  }

  view no_legacy {
    include agent.**
    exclude * where tag is #deprecated
  }
```
| predicate | meaning |
|---|---|
| `x` / `x.*` / `x.**` / `x._` | element / children / descendants that have relationships / children that relate to visible elements |
| `* -> x`, `x -> *`, `a <-> b` | elements on relationships matching the pattern (the neighbour view) |
| `-> x`, `x ->`, `-> x ->` | add `x` only if it has incoming/outgoing/any relations with **already visible** elements |
| `... where kind is k and tag is #t` | filter. `exclude * where tag is not #v1` is the tidy form |
| `... with { title color shape navigateTo … }` | per-view override. **Only valid after `include`** |
| `exclude element.tag = #t` / `element.kind = k` | legacy form, still valid |

`autoLayout` takes `TopBottom|BottomTop|LeftRight|RightLeft` plus optional rank and node spacing.
Abbreviations like `lr` fail. Views can inherit with `view b extends a { ... }`.

## 6. Dynamic views (flows) and the sequence variant

Steps are written in the view itself, not in the model, and don't need a matching model relationship.

```likec4
  dynamic view chat_turn {
    title 'One chat turn'
    user -> agent.api 'POST /a2a'
    agent.api -> agent.graph {
      notes 'Server never calls the model directly'
      navigateTo tool_call
    }
    parallel {
      agent.graph -> llm 'stream completion'
      agent.graph -> agent.store 'checkpoint'
    }
    agent.api <- agent.graph 'final answer'
    user <- agent.api 'SSE stream'
  }

  dynamic view tool_call {
    variant sequence
    title 'Tool call (sequence)'
    agent.graph -> llm 'completion'
    agent.graph <- llm 'tool_calls'
    opt 'if tool requested' {
      agent.graph -> agent.tools 'execute'
    }
    agent.graph -> agent.store 'persist result'
  }

  dynamic view chained {
    // same as: user -> api; api -> graph; api <- graph (back-edge)
    user -> agent.api -> agent.graph -> agent.api
  }
```
- `<-` is a response step. `notes` accepts Markdown (`'''…'''`). A step's `navigateTo` must name a **dynamic** view.
- Blocks: `parallel`/`par`, `opt`, `loop`, `break`, `alt { when 'x' {…} else {…} }`, `try {…} catch {…} finally {…}`.
  These are marked experimental upstream. **`parallel` inside `parallel` is rejected.** From `examples/flow_control`:
  ```likec4
    alt {
      when 'in stock' { shop.api -> shop.db 'reserve' }
      else 'sold out' { shop.api -> ui 'error' }
    }
    try { shop.api -> shop.db 'commit' }
    catch 'on failure' { shop.api -> ui 'rollback notice' }
    finally { shop.api -> shop.api 'release lock' }
    include shop
  ```
- `include a, b` in a dynamic view adds boundary/context elements (and sets actor order in the sequence variant).
- `variant sequence` (or `diagram`, the default) is only valid in `dynamic view`.
- **Sequence leaf rule, which the validator does NOT enforce:** if a step uses an element *and* another step uses one of
  its descendants, the ancestor turns into a frame and **its steps are silently dropped**
  (`examples/silent_sequence_ancestor`: 3 steps declared, 2 rendered). In sequence views use only leaf elements, or
  only one level of a branch.
- Model relationships can zoom into a flow: `a -> b { navigateTo chat_turn_flow }`. That target **must be a dynamic view**.

## 7. `extend`: split the model across files

```likec4
// A second file adds children to an element defined elsewhere.
// extend needs the fully qualified name.
model {
  extend agent.server {
    metadata {
      owner 'core'
    }
    ops = component 'Operator API'
    ops -> agent.graph 'admin'
  }
}
```
Inside `extend X { }` you get X's scope, so siblings resolve by short name. `extend` can add tags, links, metadata
(duplicate metadata keys merge into arrays), children, and relationships.

## 8. Conventions for Atlas

1. **One model, many views.** Each element is declared once. Views select from the model and never redeclare elements.
   Suggested files: `atlas/spec.c4`, `atlas/model.c4` (plus `atlas/<area>.c4` using `extend`), `atlas/views.c4`.
2. **Levels:** `system` (context) → `container` → `component`. Actors and external systems are top-level.
3. **Every element that has children gets `view <fqn_with_underscores>_detail of <fqn>`**, so drill-down always works.
   Declare it before any other scoped view of that element, because the first one is the default.
4. **Ids are stable snake_case** (`proto_agent`, `tool_loop`), never renamed casually: view names, FQNs and URLs derive from them.
   Titles carry the display text.
5. **Code links use root-relative paths:** put `likec4.config.json` at the **repo root** and write
   `link /graph/agent.py#L10-L40 'Source'`. LikeC4 resolves the leading `/` against the project root, so it stays correct
   wherever the `.c4` file lives.
6. **Metadata keys:** `adr` (string or array of ADR numbers as strings), `owner`. Use quoted strings only.
7. **Flows** are `dynamic view <name>_flow` over leaf components. Link them from the model relationship with `navigateTo`.

```likec4
    graph = container 'Agent graph' {
      technology 'LangGraph'
      link /graph/agent.py#L1-L2 'Source'
      metadata {
        adr ['0004', '0118']
      }
      tool_loop = component 'Tool loop'
      subagents = component 'Subagent delegation'
      tool_loop -> subagents 'task()'
    }

    session_store = store 'Session store' 'SQLite'

    server.a2a_route -> graph.tool_loop 'submits message' {
      navigateTo chat_turn_flow
    }
```
(Full project, including `proto_agent_detail` / `proto_agent_server_detail` / `proto_agent_graph_detail` views: `examples/atlas`.)

## 9. Validation loop

```bash
npx likec4 validate --json --no-layout <project-dir> 2>/dev/null > /tmp/v.json; echo "exit=$?"
```
1. Write or edit the `.c4` files.
2. Run the command. JSON goes to stdout and logs go to stderr. Exit code is `0` when valid and `1` when not.
3. For each `errors[]` entry, open `file` at **`line + 1`** (lines and columns are 0-based) and fix the **first** error in
   each file first. Parse errors cascade into long `Expecting: one of these possible Token sequences…` lists.
4. Repeat until `valid` is true **and** `stats.totalErrors == 0`. With `-f/--file`, `valid` covers only the filtered
   files, so it can be `true` while other files are broken. See `VALIDATE_OUTPUT.md`.
5. To check rendering (drill-down, sequence steps): `npx likec4 export json --skip-layout -o out.json <dir>`, then read
   `views.<id>.nodes[].navigateTo` and `edges`. The output is an **array** with one entry per project.

## 10. Common mistakes (real 1.60.0 errors)

Each one is reproduced under `examples/_mistakes/<name>/` and asserted by `check.sh`.

| You wrote | Error (verbatim) | Fix |
|---|---|---|
| `api = service 'API'` (kind not in spec) | `Could not resolve reference to ElementKind named 'service'.` | declare `element service` |
| `shop = softwareSystem 'Shop'` (Structurizr) | `Could not resolve reference to ElementKind named 'softwareSystem'.` | same: no built-in kinds |
| `api -> db` with no `db` | `Could not resolve reference to Referenceable named 'db'.` + `Target not resolved` | declare it, or fix the FQN |
| `ui -> graph` in another file | `Could not resolve reference to Referenceable named 'graph'.` | `ui -> agent.graph` |
| `ui -> api` where two `api` exist | `Could not resolve reference to Referenceable named 'api'.` | use the FQN `billing.api` |
| `extend api {` (short name) | `Could not resolve reference to Element named 'api'.` | `extend shop.api {` |
| `a --> b : calls` (Mermaid) | `unexpected character: ->-<- at offset: …` | `a -> b 'calls'` |
| `a -> b: 'calls'` | ``Expecting token of type '}' but found `:`.`` | no colon |
| `systemContext a { … }` | ``Expecting token of type '}' but found `systemContext`.`` | `view a_detail of a { include * }` |
| two `api = component` under one parent | `Duplicate element name api (shop.api)` (reported on both) | unique ids per parent |
| two `view index` | `Duplicate view 'index'` | unique view names |
| `shop.api = component` | `Expecting: one of these possible Token sequences: … but found: '='` | nest it or use `extend shop` |
| `shop = system Shop System` | `Could not resolve reference to ElementKind named 'Shop'.` | quote titles: `'Shop System'` |
| `#tag` after `description` | ``Expecting token of type '}' but found `#`.`` | tags first |
| `#legacy` not in spec | `Could not resolve reference to Tag named '#legacy'.` | `tag legacy` |
| `a -[async]-> b`, kind undeclared | `Could not resolve reference to RelationshipKind named 'async'.` | `relationship async` |
| `description` after a child element | ``Expecting token of type '}' but found `description`.`` | properties before children |
| `title` after `include` in a view | ``Expecting token of type '}' but found `title`.`` | properties first |
| `autoLayout lr` | `Expecting: … [TopBottom] … [LeftRight] … but found: 'lr'` | `autoLayout LeftRight` |
| `include shop/*` | `unexpected character: ->/<- …` | `include shop.*` |
| `exclude a with { … }` | `Invalid usage inside "exclude"` | `with` is include-only |
| `link './graph/agent.py'` | `Expecting: … [URI_WITH_SCHEMA] [URI_RELATIVE] [URI_ALIAS] but found: ''./graph/agent.py''` | unquoted |
| `link graph/agent.py` | `… but found: 'graph'` | `/graph/agent.py` or `./…` |
| `metadata { adr 23 }` | `Expecting: … [MarkdownString] [String] [[] [BOOLEAN] but found: '23'` | `adr '23'` |
| `color purple` | `Could not resolve reference to CustomColor named 'purple'.` | built-in token or `color purple #…` in spec |
| `color #FF0000` in `style` | `Expecting: … [primary] … but found: '#'` | declare a named color |
| `shape database` | `Expecting: … [rectangle] [component] … but found: 'database'` | `shape cylinder` |
| nested `parallel` | `Nested parallel blocks are not allowed` | flatten |
| model rel `navigateTo index` (static view) | `Could not resolve reference to DynamicView named 'index'.` | target a dynamic view |
| `variant sequence` in a static `view` | ``Expecting token of type '}' but found `variant`.`` | only in `dynamic view` |
| step `{ navigateTo index }` (static view) | `Could not resolve reference to DynamicView named 'index'.` | target a dynamic view |
| `view = system 'View layer'` (keyword as id) | ``Expecting token of type '}' but found `view`.`` | `view_layer = system …` |

**Valid, but wrong** (the validator stays silent):
- Steps on an ancestor in a `variant sequence` view are dropped (§6).
- `a -> b 'Calls' 'HTTPS'` puts HTTPS in **description**. The positional order is title, description, technology. Prefer `{ technology 'HTTPS' }`.
- Excluding before including is a silent no-op.
