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
      slides.push(slide)
    }
    if (slides.length) out.push({ id: String(t.id ?? `tour${out.length + 1}`), title: String(t.title ?? t.id ?? 'Tour'), slides })
  }
  return out
}

/** API tours (validated) or the auto-tour, always ≥ 1 tour when the model has views. */
export function toursFor(apiTours, data) {
  const list = cleanTours(apiTours, data)
  if (list.length) return list
  const auto = autoTour(data)
  return auto.length ? [{ id: 'auto', title: 'Overview', slides: auto, auto: true }] : []
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
export function codeOpenMessage(target, link, note) {
  if (!target || !link || link.kind !== 'code') return null
  const msg = { type: 'protoagent:code:open', project: target.project, path: target.path }
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
  const focus = typeof d.focus === 'string' && v.nodes?.some((n) => n.id === d.focus) ? d.focus : undefined
  return { kind: 'view', view: d.view, step, focus, present }
}

// ---------------------------------------------------------------- text + theme

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])

/** Markdown-light → safe HTML: **bold**, *em*, `code`, [text](https://…), paragraphs + breaks. */
export function mdLight(src) {
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
      h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`)
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
