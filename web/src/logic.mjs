// Atlas viewer — pure logic (no DOM, no React). Unit-tested with `node --test test/`.
// Everything here works on the LikeC4 layouted model `$data` (one project object, as
// returned by `GET /api/plugins/atlas/model` → `model`) or on plain values.

// ---------------------------------------------------------------- model helpers

/** Views of a model `$data` in declaration order. */
export function viewList(data) {
  return Object.values(data?.views ?? {})
}

/** FQN → depth-first tree order index (parents before children, siblings in source order). */
export function elementOrder(data) {
  const ids = Object.keys(data?.elements ?? {})
  const known = new Set(ids)
  const parentOf = (fqn) => {
    let i = fqn.lastIndexOf('.')
    while (i > 0) {
      const p = fqn.slice(0, i)
      if (known.has(p)) return p
      i = p.lastIndexOf('.')
    }
    return null
  }
  const kids = new Map()
  const roots = []
  for (const id of ids) {
    const p = parentOf(id)
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)).push(id)
    else roots.push(id)
  }
  const order = new Map()
  const walk = (id) => {
    order.set(id, order.size)
    for (const k of kids.get(id) ?? []) walk(k)
  }
  roots.forEach(walk)
  return order
}

const textOf = (d) => (d == null ? '' : typeof d === 'string' ? d : (d.md ?? d.txt ?? '')).trim()

/** Plain text of a LikeC4 description/summary value (`{txt}` | `{md}` | string). */
export { textOf as descriptionText }

/** The view (id) holding a node that drills down into `viewId`, else a sensible parent. */
export function parentView(data, viewId) {
  const views = viewList(data)
  const target = data?.views?.[viewId]
  if (!target || viewId === 'index') return null
  for (const v of views) if (v.id !== viewId && v.nodes?.some((n) => n.navigateTo === viewId)) return v.id
  if (target.viewOf) {
    // a scoped view nobody links to: the view whose scope is the nearest ancestor holding the element
    let best = null
    for (const v of views) {
      if (v.id === viewId || v._type !== 'element') continue
      if (!v.nodes?.some((n) => n.id === target.viewOf)) continue
      const depth = v.viewOf && target.viewOf.startsWith(v.viewOf + '.') ? v.viewOf.split('.').length : 0
      if (!best || depth > best.depth) best = { id: v.id, depth }
    }
    if (best) return best.id
  }
  return data.views.index ? 'index' : null
}

/** [root, …, viewId] following parentView, cycle-safe. */
export function viewChain(data, viewId, parentFn = (v) => parentView(data, v)) {
  const out = [viewId]
  let p = parentFn(viewId)
  while (p && !out.includes(p)) {
    out.unshift(p)
    p = parentFn(p)
  }
  return out
}

/** The dynamic-view step edges (`step-01`, `step-02`, …) in order. */
export function dynamicSteps(view) {
  return (view?.edges ?? []).filter((e) => /^step-\d+/.test(e.id)).sort((a, b) => a.id.localeCompare(b.id))
}

const edgeLabel = (e) => (e?.label ?? e?.labelBBox?.text ?? '').toString().trim()

// ---------------------------------------------------------------- tours

/**
 * Auto-tour when there's no `atlas.tours.json` — the SAME slide list as the backend's
 * `lint.auto_tour` (so `atlas_show(tour="auto", slide=n)` lands where the agent means):
 * `index`, then each scoped view in model tree order, then each dynamic view. A dynamic
 * slide carries no `step`; the presenter walks its steps with → before moving on.
 */
export function autoTour(data) {
  const views = viewList(data)
  if (!views.length) return []
  const order = elementOrder(data)
  const slides = []
  const noteOf = (v) => [v.title || v.id, textOf(v.description)].filter(Boolean).join(' — ')
  if (data.views.index) slides.push({ view: 'index', note: noteOf(data.views.index) })
  const scoped = views
    .filter((v) => v._type !== 'dynamic' && v._type !== 'deployment' && v.viewOf)
    .map((v, i) => ({ v, k: order.get(v.viewOf) ?? order.size, i }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.v)
  for (const v of scoped) {
    const s = { view: v.id, note: noteOf(v) }
    // no node drills into it → zoom through the scope element in the previous slide's view
    const prev = slides.length ? data.views[slides[slides.length - 1].view] : null
    if (!views.some((o) => o.nodes?.some((n) => n.navigateTo === v.id)) && prev?.nodes?.some((n) => n.id === v.viewOf)) s.via = v.viewOf
    slides.push(s)
  }
  for (const v of views.filter((v) => v._type === 'dynamic')) slides.push({ view: v.id, note: noteOf(v) })
  return slides
}

/** The `tours` field of the model response: the tours-file doc `{tours:[…]}` or a bare list. */
export function tourArray(tours) {
  if (Array.isArray(tours)) return tours
  if (tours && typeof tours === 'object' && Array.isArray(tours.tours)) return tours.tours
  return []
}

/** A title safe to show + match as a menu item name: control chars, NEL and the Unicode
 *  line / paragraph separators become spaces (record.py's clean_title does the same). */
export function cleanTitle(t) {
  return String(t ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Tour'
}

/** Validate API tours against the model: drops unknown views, bad steps, unknown focus. */
export function cleanTours(tours, data) {
  const out = []
  for (const t of tourArray(tours)) {
    if (!t || !Array.isArray(t.slides)) continue
    const slides = []
    for (const s of t.slides) {
      const v = s && data?.views?.[s.view]
      if (!v) continue
      const slide = { view: s.view, note: typeof s.note === 'string' ? s.note : '' }
      if (Number.isInteger(s.step) && s.step >= 1 && s.step <= dynamicSteps(v).length) slide.step = s.step
      if (typeof s.focus === 'string' && v.nodes?.some((n) => n.id === s.focus)) slide.focus = s.focus
      if (typeof s.via === 'string') slide.via = s.via
      if (Number.isInteger(s.hold_ms) && s.hold_ms >= 500 && s.hold_ms <= 60000) slide.hold_ms = s.hold_ms
      slides.push(slide)
    }
    if (slides.length) out.push({ id: String(t.id ?? `tour${out.length + 1}`), title: cleanTitle(t.title ?? t.id ?? 'Tour'), slides })
  }
  return out
}

/** API tours (validated) or the auto-tour, always ≥ 1 tour when the model has views. */
export function toursFor(apiTours, data) {
  const list = cleanTours(apiTours, data)
  // the auto tour is ALWAYS there (atlas_show / atlas_record_script accept tour="auto")
  const auto = autoTour(data)
  if (auto.length && !list.some((t) => t.id === 'auto')) list.push({ id: 'auto', title: 'Overview', slides: auto, auto: true })
  return list
}

// ---------------------------------------------------------------- links

const LINE_FRAG = /#L(\d+)(?:-L?(\d+))?$/i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** A project-relative path the console's fs fence would accept, else null. */
export function safeRelPath(p) {
  if (typeof p !== 'string') return null
  let s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!s || s.startsWith('~') || SCHEME.test(s)) return null
  if (s.split('/').some((seg) => seg === '..')) return null
  s = s.replace(/\/+/g, '/')
  return s
}

/**
 * Normalise one element link — the backend shape `{kind:"code", path, line}` /
 * `{kind:"web", url}` or LikeC4's raw `{url, title?, relative?}` (or a bare string) —
 * to `{kind: "code"|"web"|"other", title, url, path?, line?, endLine?}`.
 */
export function normaliseLink(link) {
  if (link == null) return null
  const raw = typeof link === 'string' ? { url: link } : link
  const url = typeof raw.url === 'string' ? raw.url : ''
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : ''
  const posInt = (n) => (Number.isInteger(n) && n > 0 ? n : undefined)
  if (raw.kind === 'code' && typeof raw.path === 'string') {
    const path = safeRelPath(raw.path.replace(LINE_FRAG, ''))
    if (path) {
      const line = posInt(raw.line)
      const end = posInt(raw.end_line ?? raw.endLine)
      return { kind: 'code', title: title || path, url, path, line, endLine: line && end && end >= line ? end : undefined }
    }
  }
  // the backend's verdict wins: an escaping / non-file link is never offered as code
  if (raw.kind === 'invalid' || raw.kind === 'other' || raw.kind === 'code') return url || title ? { kind: 'other', title: title || url, url } : null
  if (raw.kind === 'web' && url) return { kind: /^https?:/i.test(url) ? 'web' : 'other', title: title || url, url }
  if (!url && !raw.relative) return null
  if (/^https?:\/\//i.test(url)) return { kind: 'web', title: title || url, url }
  if (SCHEME.test(url) || url.startsWith('//')) return { kind: 'other', title: title || url, url }
  // raw relative link: `/src/x.py#L10` means relative to the project root
  const src = url || raw.relative
  const m = LINE_FRAG.exec(src)
  const path = safeRelPath(src.replace(LINE_FRAG, '').replace(/[?#].*$/, ''))
  if (!path) return { kind: 'other', title: title || src, url: src }
  const line = m ? Number(m[1]) : undefined
  const end = m && m[2] ? Number(m[2]) : undefined
  return { kind: 'code', title: title || path, url: src, path, line, endLine: line && end && end >= line ? end : undefined }
}

export function normaliseLinks(links) {
  return (Array.isArray(links) ? links : []).map(normaliseLink).filter(Boolean)
}

/**
 * Which console project + project-relative path a code link opens. `info` is the model
 * response (`project?`, `project_root`), `roots` is `GET /api/fs/roots` → `{name: abs}`.
 */
export function resolveProject(info, roots, path) {
  if (info && typeof info.project === 'string' && info.project.trim()) return { project: info.project, path }
  const root = trimSlash(info?.project_root)
  if (root && roots && typeof roots === 'object') {
    let best = null
    for (const [name, abs] of Object.entries(roots)) {
      const r = trimSlash(abs)
      if (!r) continue
      if (root === r) return { project: name, path }
      if (root.startsWith(r + '/') && (!best || r.length > best.r.length)) best = { name, r }
    }
    if (best) return { project: best.name, path: `${root.slice(best.r.length + 1)}/${path}` }
  }
  if (root) return { project: root.split('/').pop(), path }
  return null
}
const trimSlash = (s) => (typeof s === 'string' ? s.trim().replace(/\/+$/, '') : '')

/** The `protoagent:code:open` message for a normalised code link, or null. */
export function codeOpenMessage(target, link, note, openIn) {
  if (!target || !link || link.kind !== 'code') return null
  const msg = { type: 'protoagent:code:open', project: target.project, path: target.path }
  if (openIn === 'pane' || openIn === 'editor') msg.open_in = openIn
  if (link.line) msg.line = link.line
  if (link.line && link.endLine) msg.end_line = link.endLine
  if (note) msg.note = String(note).slice(0, 280)
  return msg
}

/** An error's `file` (the backend makes it project-relative) → a code-pane path, or null. */
export function errorFileRel(file, info) {
  if (typeof file !== 'string' || !file) return null
  const f = file.replace(/\\/g, '/')
  if (!f.startsWith('/')) return safeRelPath(f)
  const root = trimSlash(info?.project_root)
  if (root && f.startsWith(root + '/')) return safeRelPath(f.slice(root.length + 1))
  return null
}

/** Short display path for an error file (relative to the model dir when inside it). */
export function displayFile(file, info) {
  if (typeof file !== 'string') return ''
  const md = trimSlash(info?.model_dir)
  const f = file.replace(/\\/g, '/')
  if (md && f.startsWith(md + '/')) return f.slice(md.length + 1)
  const root = trimSlash(info?.project_root)
  if (root && f.startsWith(root + '/')) return f.slice(root.length + 1)
  return f
}

// ---------------------------------------------------------------- search + navigation

/** Element/view search. Returns ≤ `limit` hits `{type:'element'|'view', id, title, sub}`. */
export function searchModel(data, query, limit = 12) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q || !data) return []
  const hits = []
  const score = (title, id, extra) => {
    const t = (title ?? '').toLowerCase()
    if (t === q) return 0
    if (t.startsWith(q)) return 1
    if (t.split(/[\s_.-]+/).some((w) => w.startsWith(q))) return 2
    if (t.includes(q)) return 3
    if ((id ?? '').toLowerCase().includes(q)) return 4
    if ((extra ?? '').toLowerCase().includes(q)) return 5
    return -1
  }
  const order = elementOrder(data)
  for (const e of Object.values(data.elements ?? {})) {
    const s = score(e.title, e.id, [e.technology, textOf(e.summary), textOf(e.description), ...(e.tags ?? [])].join(' '))
    if (s >= 0) hits.push({ type: 'element', id: e.id, title: e.title || e.id, sub: [e.kind, e.technology].filter(Boolean).join(' · '), s, o: order.get(e.id) ?? 0 })
  }
  for (const v of viewList(data)) {
    const s = score(v.title, v.id, textOf(v.description))
    if (s >= 0) hits.push({ type: 'view', id: v.id, title: v.title || v.id, sub: v._type === 'dynamic' ? 'dynamic view' : 'view', s: s + 0.5, o: 0 })
  }
  hits.sort((a, b) => a.s - b.s || a.o - b.o || a.title.localeCompare(b.title))
  return hits.slice(0, limit).map(({ s, o, ...h }) => h)
}

/** Scoped (drill-down) view of an element, if any. */
export function scopedViewOf(data, fqn) {
  return viewList(data).find((v) => v._type === 'element' && v.viewOf === fqn)?.id ?? null
}

/**
 * Where to show an element: `{view, focus}`. Prefers the view scoped to its parent (the
 * element shown among its siblings), then any element view containing it, then its own
 * drill-down view.
 */
export function viewForElement(data, fqn, current) {
  const views = viewList(data)
  const has = (v) => v.nodes?.some((n) => n.id === fqn)
  if (current && data?.views?.[current] && has(data.views[current])) return { view: current, focus: fqn }
  const parent = fqn.includes('.') ? fqn.slice(0, fqn.lastIndexOf('.')) : null
  const byParent = views.find((v) => v._type === 'element' && parent && v.viewOf === parent && has(v))
  if (byParent) return { view: byParent.id, focus: fqn }
  const any = views.find((v) => v._type === 'element' && v.id === 'index' && has(v)) ?? views.find((v) => v._type === 'element' && has(v))
  if (any) return { view: any.id, focus: fqn }
  const own = scopedViewOf(data, fqn)
  if (own) return { view: own, focus: null }
  const dyn = views.find(has)
  return dyn ? { view: dyn.id, focus: fqn } : null
}

/** Keep the current view across a reload when it still exists. */
export function keepView(data, current) {
  if (current && data?.views?.[current]) return current
  if (data?.views?.index) return 'index'
  return viewList(data)[0]?.id ?? null
}

/** View picker entries: tree-indented element views, then dynamic views. */
export function viewOptions(data) {
  const views = viewList(data)
  const out = []
  const seen = new Set()
  const kids = new Map()
  for (const v of views) {
    const p = v._type === 'element' ? parentView(data, v.id) : null
    if (p && p !== v.id) (kids.get(p) ?? kids.set(p, []).get(p)).push(v)
  }
  const walk = (v, depth) => {
    if (seen.has(v.id)) return
    seen.add(v.id)
    out.push({ id: v.id, title: v.title || v.id, depth, dynamic: v._type === 'dynamic' })
    for (const k of kids.get(v.id) ?? []) walk(k, depth + 1)
  }
  const roots = views.filter((v) => v._type === 'element' && !parentView(data, v.id))
  roots.forEach((v) => walk(v, 0))
  views.filter((v) => v._type === 'element').forEach((v) => walk(v, 0))
  views.filter((v) => v._type !== 'element').forEach((v) => walk(v, 0))
  return out
}

// ---------------------------------------------------------------- presenter keyboard

/**
 * Presenter key → action. `ctx = {slide, count, steps?, step?}` — `steps` > 0 when the
 * current slide is a whole dynamic view (no `step` of its own): → / ← then walk its steps
 * (`step` = the walk position, 0 = not walking) before leaving the slide. Returns `null`
 * for keys the presenter doesn't own (they fall through to the page / host), else one of
 *   {type:'goto', index} · {type:'step', step} (0 = stop walking) · {type:'drill'} ·
 *   {type:'up'} · {type:'focus', dir} · {type:'notes'} · {type:'fullscreen'} ·
 *   {type:'noop'} (owned, nothing to do).
 */
export function presenterKey(key, mods = {}, ctx = { slide: 0, count: 0 }) {
  if (mods.metaKey || mods.ctrlKey || mods.altKey) return null
  const { slide, count } = ctx
  const steps = ctx.steps > 0 ? ctx.steps : 0
  const step = Math.min(Math.max(ctx.step ?? 0, 0), steps)
  const go = (i) => (i >= 0 && i < count && i !== slide ? { type: 'goto', index: i } : { type: 'noop' })
  switch (key) {
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      return step < steps ? { type: 'step', step: step + 1 } : go(slide + 1)
    case 'ArrowLeft':
    case 'PageUp':
      return step > 0 ? { type: 'step', step: step - 1 } : go(slide - 1)
    case 'Home':
      return go(0)
    case 'End':
      return go(count - 1)
    case 'Enter':
      return { type: 'drill' }
    case 'Escape':
    case 'Backspace':
      return { type: 'up' }
    case 'Tab':
      return { type: 'focus', dir: mods.shiftKey ? -1 : 1 }
    case 'n':
    case 'N':
      return { type: 'notes' }
    case 'f':
    case 'F':
      return { type: 'fullscreen' }
  }
  if (/^[0-9]$/.test(key)) return go(key === '0' ? 9 : Number(key) - 1)
  return null
}

/** Next index when cycling `list` from `current` by `dir` (wraps; -1 current → first/last). */
export function cycle(list, current, dir) {
  if (!list.length) return null
  const i = list.indexOf(current)
  if (i < 0) return list[dir > 0 ? 0 : list.length - 1]
  return list[(i + dir + list.length) % list.length]
}

/** Slide to open when entering the presenter from `view` (first slide showing it, else 0). */
export function slideForView(slides, view) {
  const i = slides.findIndex((s) => s.view === view && !s.step)
  if (i >= 0) return i
  const j = slides.findIndex((s) => s.view === view)
  return j >= 0 ? j : 0
}

// ---------------------------------------------------------------- bus

/** Validate an `atlas.show` payload against the model + tours → a navigation request or null. */
export function parseShow(d, data, tours) {
  if (!d || typeof d !== 'object' || !data) return null
  const present = d.present === true
  if (d.tour != null || (present && d.slide != null)) {
    const tour = tours.find((t) => t.id === d.tour) ?? (d.tour == null ? tours[0] : null)
    if (tour) {
      let slide = Number.isInteger(d.slide) ? d.slide : 0
      // slides are addressed 1-based on the wire (like steps); accept 0 as the first too
      slide = Math.min(Math.max(slide > 0 ? slide - 1 : 0, 0), tour.slides.length - 1)
      if (d.view && !Number.isInteger(d.slide)) slide = slideForView(tour.slides, d.view)
      return { kind: 'tour', tour: tour.id, slide, present: present || d.tour != null }
    }
  }
  if (typeof d.view !== 'string' || !data.views?.[d.view]) return null
  const v = data.views[d.view]
  const step = Number.isInteger(d.step) && d.step >= 1 && d.step <= dynamicSteps(v).length ? d.step : undefined
  const ids = new Set((v.nodes ?? []).map((n) => n.id))
  const focus = (Array.isArray(d.focus) ? d.focus : typeof d.focus === 'string' ? [d.focus] : []).filter((f) => typeof f === 'string' && ids.has(f))
  const eids = new Set((v.edges ?? []).map((e) => e.id))
  const edges = (Array.isArray(d.edges) ? d.edges : []).filter((e) => typeof e === 'string' && eids.has(e))
  const note = typeof d.note === 'string' && d.note.trim() && (focus.length || edges.length) ? d.note.trim().slice(0, 280) : undefined
  return { kind: 'view', view: d.view, step, focus, edges, note, present }
}

// ---------------------------------------------------------------- live highlights

/**
 * What to light up in a view: the focused nodes + every edge's endpoints stay lit (and the
 * compounds containing them, so their context reads), the rest dims; `bounds` is the box the
 * camera fits. → {lit: Set<nodeId>, active: Set<edgeId>, dimNodes: [], dimEdges: [], bounds|null}
 */
export function highlightPlan(view, focus = [], edges = []) {
  const nodes = view?.nodes ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const allEdges = view?.edges ?? []
  const active = new Set(edges.filter((e) => allEdges.some((x) => x.id === e)))
  const core = new Set(focus.filter((f) => byId.has(f)))
  for (const e of allEdges) if (active.has(e.id)) (core.add(e.source), core.add(e.target))
  const lit = new Set(core)
  for (const id of core) {
    let p = byId.get(id)?.parent
    while (p && byId.has(p)) {
      lit.add(p)
      p = byId.get(p)?.parent
    }
  }
  let bounds = null
  for (const id of core) {
    const n = byId.get(id)
    if (!n || !(n.width > 0)) continue
    const b = { x: n.x, y: n.y, x2: n.x + n.width, y2: n.y + n.height }
    bounds = bounds ? { x: Math.min(bounds.x, b.x), y: Math.min(bounds.y, b.y), x2: Math.max(bounds.x2, b.x2), y2: Math.max(bounds.y2, b.y2) } : b
  }
  return {
    lit,
    active,
    dimNodes: nodes.map((n) => n.id).filter((id) => !lit.has(id)),
    dimEdges: allEdges.map((e) => e.id).filter((id) => !active.has(id)),
    bounds: bounds && { x: bounds.x, y: bounds.y, width: bounds.x2 - bounds.x, height: bounds.y2 - bounds.y },
    empty: core.size === 0,
  }
}

/**
 * Where an on-canvas callout goes: above the node's on-screen box, centred and clamped to the
 * canvas; below when there's no room above. `node` in flow coords, `vp` = {x, y, zoom},
 * `canvas`/`size` = {width, height}. → {left, top, side: 'above'|'below', arrowX}
 */
export function calloutPlacement(node, vp, canvas, size, gap = 12, margin = 8) {
  const sx = node.x * vp.zoom + vp.x
  const sy = node.y * vp.zoom + vp.y
  const sw = node.width * vp.zoom
  const sh = node.height * vp.zoom
  const cx = sx + sw / 2
  let left = Math.round(cx - size.width / 2)
  left = Math.max(margin, Math.min(left, canvas.width - size.width - margin))
  let side = 'above'
  let top = Math.round(sy - gap - size.height)
  if (top < margin) {
    side = 'below'
    top = Math.round(Math.min(sy + sh + gap, canvas.height - size.height - margin))
  }
  const arrowX = Math.round(Math.max(12, Math.min(cx - left, size.width - 12)))
  return { left, top, side, arrowX }
}

/** The `atlas.viewing` payload — what the operator sees right now. */
export function viewingPayload({ mode, view, step, selected, highlight, tour, slide }) {
  const out = { mode: mode === 'present' ? 'present' : 'explore', view: view ?? null, step: Number.isInteger(step) && step > 0 ? step : null, selected: selected ?? null }
  out.focus = highlight?.focus?.length ? [...highlight.focus] : []
  out.edges = highlight?.edges?.length ? [...highlight.edges] : []
  out.note = highlight?.note ?? null
  if (out.mode === 'present') ((out.tour = tour ?? null), (out.slide = Number.isInteger(slide) ? slide + 1 : null))
  return out
}

/**
 * "Ask about this" — the chat draft for an element (protoagent:chat:compose). Includes the
 * element's code-link paths and, on a dynamic view, the current step.
 */
export function askPrompt(data, { view, fqn, step } = {}) {
  const v = data?.views?.[view]
  const el = fqn ? data?.elements?.[fqn] : null
  const vt = v?.title || view || 'Atlas'
  const title = (f) => data?.elements?.[f]?.title || f
  let text
  if (el) text = `In the Atlas view "${vt}", tell me about ${el.title || fqn} (${fqn}) — how it works and where it lives in the code.`
  else text = `In the Atlas view "${vt}", walk me through what this view shows and where it lives in the code.`
  if (v?._type === 'dynamic' && Number.isInteger(step) && step > 0) {
    const e = dynamicSteps(v)[step - 1]
    if (e) text += ` We're at step ${step}: ${title(e.source)} → ${title(e.target)}${e.label ? ` "${e.label}"` : ''}.`
  }
  const paths = el ? normaliseLinks(el.links).filter((l) => l.kind === 'code').map((l) => l.path + (l.line ? `:${l.line}` : '')) : []
  if (paths.length) text += ` Code links: ${[...new Set(paths)].join(', ')}.`
  return text.length > 1200 ? text.slice(0, 1199) + '…' : text
}

/** Does the host support protoagent:chat:compose? Only when its version is KNOWN to be ≥ 0.206.0
 *  (the first release that can carry core #4243) — an unknown / unparseable version hides it. */
export function hostSupportsCompose(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''))
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a > 0 || b >= 206
}

// ---------------------------------------------------------------- text + theme

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])

/**
 * A code span that names a project file — `src/x.py`, `src/x.py:12`, `src/x.py:12-20`,
 * `src/x.py#L12` — as a code link, else null. (Already HTML-escaped text; must look like
 * a relative path with an extension.)
 */
export function parseCodeRef(text) {
  const m = /^((?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]{1,8})(?:(?::|#L)(\d+)(?:-L?(\d+))?)?$/.exec(String(text ?? '').trim())
  if (!m) return null
  const path = safeRelPath(m[1])
  if (!path || /^\d+(\.\d+)+$/.test(path)) return null // a version number, not a file
  const line = m[2] ? Number(m[2]) : undefined
  const end = m[3] ? Number(m[3]) : undefined
  return { kind: 'code', title: path, url: text, path, line, endLine: line && end && end >= line ? end : undefined }
}

/** Markdown-light → safe HTML (`opts.codeRefs`: file-path code spans become code links): **bold**, *em*, `code`, [text](https://…), paragraphs + breaks. */
export function mdLight(src, opts = {}) {
  const paras = String(src ?? '').trim().split(/\n\s*\n/)
  return paras
    .filter((p) => p.trim())
    .map((p) => {
      let h = escapeHtml(p.trim())
      const codes = []
      h = h.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
      h = h
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\n/g, '<br>')
      h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => {
        const c = codes[Number(i)]
        const ref = opts.codeRefs ? parseCodeRef(c) : null
        return ref
          ? `<code class="coderef" role="button" tabindex="0" data-path="${escapeHtml(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ''}${ref.endLine ? ` data-end-line="${ref.endLine}"` : ''} title="View in the code pane (⌘/Ctrl-click: open in editor)">${c}</code>`
          : `<code>${c}</code>`
      })
      return `<p>${h}</p>`
    })
    .join('')
}

/** Relative luminance of an `[r,g,b]` (0–255) → 'light' | 'dark' scheme for content on it. */
export function schemeForRgb(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return 'dark'
  const lin = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  const L = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
  return L > 0.4 ? 'light' : 'dark'
}

// ---------------------------------------------------------------- camera math

/** van Wijk & Nuij smooth zoom between `[cx, cy, width]` views (same as d3.interpolateZoom.rho). */
export function interpolateZoom(rho = Math.SQRT2) {
  const rho2 = rho * rho
  const rho4 = rho2 * rho2
  return (p0, p1) => {
    const [ux0, uy0, w0] = p0
    const [ux1, uy1, w1] = p1
    const dx = ux1 - ux0
    const dy = uy1 - uy0
    const d2 = dx * dx + dy * dy
    if (d2 < 1e-12) {
      const S = Math.log(w1 / w0) / rho
      return (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)]
    }
    const d1 = Math.sqrt(d2)
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1)
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1)
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
    const S = (Math.log(Math.sqrt(b1 * b1 + 1) - b1) - r0) / rho
    return (t) => {
      const s = t * S
      const c0 = Math.cosh(r0)
      const u = (w0 / (rho2 * d1)) * (c0 * Math.tanh(rho * s + r0) - Math.sinh(r0))
      return [ux0 + u * dx, uy0 + u * dy, (w0 * c0) / Math.cosh(rho * s + r0)]
    }
  }
}

/** Viewport `{x,y,zoom}` fitting box `b` inside rect `r` with padding. */
export function fitBox(b, r, pad, maxZoom = 8) {
  const zoom = Math.max(1e-3, Math.min((r.width - 2 * pad) / b.width, (r.height - 2 * pad) / b.height, maxZoom))
  return { zoom, x: r.x + r.width / 2 - (b.x + b.width / 2) * zoom, y: r.y + r.height / 2 - (b.y + b.height / 2) * zoom }
}

// ---------------------------------------------------------------- host bridge helpers

/** The console's chord name for a keydown (ADR 0063 forwarding): "mod+shift+k". */
export function keyCombo(e) {
  const k = String(e?.key ?? '').toLowerCase()
  if (!k || ['meta', 'control', 'shift', 'alt'].includes(k)) return null
  return [e.metaKey || e.ctrlKey ? 'mod' : '', e.shiftKey ? 'shift' : '', e.altKey ? 'alt' : '', k].filter(Boolean).join('+')
}

/** Forward a keydown to the host? Only chords (mod/alt) the page didn't handle itself. */
export function shouldForwardKey(e) {
  return !!e && !e.defaultPrevented && !!(e.metaKey || e.ctrlKey || e.altKey) && keyCombo(e) !== null
}

/** The parent frame's origin: ancestorOrigins (Chromium/WebKit) → referrer → our own origin. */
export function parentOriginOf({ ancestorOrigins, referrer, origin }) {
  const a = ancestorOrigins && ancestorOrigins.length ? ancestorOrigins[0] : ''
  if (a && a !== 'null') return a
  try {
    if (referrer) return new URL(referrer).origin
  } catch {
    /* bad referrer */
  }
  return origin
}

/** Context-menu items for a node (`protoagent:contextmenu:open`). Ids carry no dots (the host namespaces them). */
export function nodeMenuItems({ hasCode, paneOn, canDrill, canPresent, canAsk }) {
  const items = []
  if (canAsk) items.push({ id: 'ask', label: 'Ask about this' }, { divider: true })
  if (hasCode) {
    if (paneOn !== false) items.push({ id: 'view', label: 'View code' })
    items.push({ id: 'editor', label: 'Open in editor' })
    items.push({ divider: true })
  }
  if (canDrill) items.push({ id: 'drill', label: 'Drill in' })
  items.push({ id: 'details', label: 'Show details' })
  if (canPresent) items.push({ id: 'present', label: 'Present from here' })
  items.push({ divider: true })
  items.push({ id: 'copy', label: 'Copy element id' })
  return items
}

/** How a code link click routes: `{open_in}` — ⌘/Ctrl → editor; the pane when it's on, else the editor. */
export function codeRoute(mods, paneOn) {
  if (mods && (mods.metaKey || mods.ctrlKey)) return 'editor'
  return paneOn === false ? 'editor' : 'pane'
}

// ---------------------------------------------------------------- autoplay / recording
// The autoplay schedule. MUST match record.py (SLIDE_* / STEP_* / FINAL_HOLD_MS) — the
// backend's shot script waits for the same timeline.
export const MIN_SLIDE_MS = 2500
export const SLIDE_BASE_MS = 1200
export const PER_WORD_MS = 260
export const MAX_SLIDE_MS = 15000
export const MIN_STEP_MS = 1800
export const STEP_BASE_MS = 1000
export const FINAL_HOLD_MS = 3000

export const words = (text) => (String(text ?? '').replace(/[*`_[\]()]/g, ' ').match(/\S+/g) ?? []).length

/** How long a slide stays up (after its camera settles): `hold_ms`, else from the note's length. */
export function slideDwellMs(slide) {
  const hold = slide?.hold_ms
  if (Number.isInteger(hold) && hold > 0) return hold
  return Math.min(MAX_SLIDE_MS, Math.max(MIN_SLIDE_MS, SLIDE_BASE_MS + words(slide?.note) * PER_WORD_MS))
}

/** How long one walkthrough step of a whole-dynamic-view slide stays up. */
export function stepDwellMs(label) {
  return Math.min(MAX_SLIDE_MS, Math.max(MIN_STEP_MS, STEP_BASE_MS + words(label) * PER_WORD_MS))
}

/**
 * A deep link in the page's hash: `#tour=<id>&slide=<n>&present=1&autoplay=1&record=1` or
 * `#view=<id>&focus=<fqn>[,<fqn>]&step=<n>`. → {tour?, slide?, present, autoplay, record, view?, focus[], step?} | null
 */
export function parseDeepLink(hash) {
  const raw = String(hash ?? '').replace(/^#/, '')
  if (!raw || !/(^|&)(tour|view)=/.test(raw)) return null
  const q = new URLSearchParams(raw)
  const flag = (k) => ['1', 'true', 'yes', ''].includes(q.get(k) ?? 'no')
  const int = (k) => (/^\d+$/.test(q.get(k) ?? '') ? Number(q.get(k)) : undefined)
  const out = { present: flag('present') || flag('autoplay') || flag('record'), autoplay: flag('autoplay') || flag('record'), record: flag('record') }
  if (q.get('tour')) ((out.tour = q.get('tour')), (out.slide = int('slide')))
  if (q.get('view')) ((out.view = q.get('view')), (out.step = int('step')))
  out.focus = (q.get('focus') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return out
}

/** The bus topics the viewer acts on — exactly these (registry.emit namespaces a plugin's emits
 *  to `<plugin>.<event>`; any other plugin's `x.atlas.show` is ignored). */
export const SHOW_TOPIC = 'atlas.show'
export const CLEAR_TOPIC = 'atlas.clear'

/** Explore-mode actions for a parsed `atlas.show` view request: the step to walk to (if any) and
 *  the highlight/callout to apply — AFTER the step settles when both are given. */
export function exploreShowPlan(req) {
  const hasHl = (req?.focus?.length ?? 0) > 0 || (req?.edges?.length ?? 0) > 0
  const highlight = hasHl ? { view: req.view, focus: [...req.focus], edges: [...req.edges], note: req.note } : null
  if (req?.step) return { step: req.step, highlight, fit: false }
  return { step: undefined, highlight, fit: !highlight }
}

// ---------------------------------------------------------------- legibility (present / record)
// LikeC4's base sizes (styles: --font-sizes-likec4-md, description × .74, edge label 14px)
export const LIKEC4_TITLE_PX = 19.2
export const LIKEC4_DESC_RATIO = 0.74
export const LIKEC4_EDGE_PX = 14
export const LEGIBLE = { title: 12, desc: 9, edge: 9, kMax: 1.6, keMax: 2 }

/**
 * How to frame a view so its text stays legible on screen (CSS px), for present / record:
 * `k` scales titles / compound titles / edge labels inside their (fixed) boxes, up to `kMax`;
 * when even that leaves titles under `title` px at the whole-view fit, the camera frames the
 * densest window at the minimum legible zoom instead of the whole view (present/record only).
 * → {k, zoom, box (flow coords to fit), cropped}
 */
export function legibleFrame(view, stage, pad = 56, t = LEGIBLE) {
  const b = view?.bounds
  if (!b || !(b.width > 0) || !(stage.width > 0)) return { k: 1, ke: 1, zoom: 1, box: b, cropped: false }
  const avail = { w: Math.max(1, stage.width - 2 * pad), h: Math.max(1, stage.height - 2 * pad) }
  const zFit = Math.min(avail.w / b.width, avail.h / b.height)
  const k = Math.min(t.kMax, Math.max(1, t.title / (LIKEC4_TITLE_PX * zFit)))
  const zMin = t.title / (LIKEC4_TITLE_PX * k)
  // edge labels get their own scale (they sit on the lines, not in fixed boxes)
  const keFor = (z) => Math.min(t.keMax, Math.max(1, t.edge / (LIKEC4_EDGE_PX * z)))
  if (zFit >= zMin - 1e-6) return { k, ke: keFor(zFit), zoom: zFit, box: b, cropped: false }
  // the densest window of the size that zMin can show, centred on a node, clamped into the view
  const ww = avail.w / zMin
  const wh = avail.h / zMin
  const leaves = (view.nodes ?? []).filter((n) => !(n.children?.length) && n.width > 0)
  const centres = leaves.map((n) => [n.x + n.width / 2, n.y + n.height / 2])
  // inside the view along an axis it overflows; centred on the view along an axis it fits
  const clampX = (x) => (ww >= b.width ? b.x + (b.width - ww) / 2 : Math.min(Math.max(x, b.x), b.x + b.width - ww))
  const clampY = (y) => (wh >= b.height ? b.y + (b.height - wh) / 2 : Math.min(Math.max(y, b.y), b.y + b.height - wh))
  const mid = [b.x + b.width / 2, b.y + b.height / 2]
  let best = null
  for (const [cx, cy] of centres.length ? centres : [mid]) {
    const x = clampX(cx - ww / 2)
    const y = clampY(cy - wh / 2)
    const count = centres.filter(([px, py]) => px >= x && px <= x + ww && py >= y && py <= y + wh).length
    const dist = Math.hypot(x + ww / 2 - mid[0], y + wh / 2 - mid[1])
    if (!best || count > best.count || (count === best.count && dist < best.dist)) best = { x, y, count, dist }
  }
  return { k, ke: keFor(zMin), zoom: zMin, box: { x: best.x, y: best.y, width: ww, height: wh }, cropped: true }
}

/** Per-zoom text flags (present / record): hide what would render below the target. */
export function legibleFlags(ke, zoom, t = LEGIBLE) {
  return {
    hideDesc: LIKEC4_TITLE_PX * LIKEC4_DESC_RATIO * zoom < t.desc - 0.05,
    hideEdgeLabels: LIKEC4_EDGE_PX * ke * zoom < t.edge - 0.05,
  }
}
