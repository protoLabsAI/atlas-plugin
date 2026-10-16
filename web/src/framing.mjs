// Present / record framing — pure. The camera fits a slide's subject into a SAFE RECT (the canvas
// minus the measured top chrome, the measured caption / notes panel and side margins), centred,
// and never cuts through a node: every leaf node ends up either wholly inside the safe rect or
// wholly off the canvas. The slide's SUBJECT is always shown complete: its focus / step ends, else
// the whole view. Legibility comes from hiding secondary text and accepting smaller titles down
// to a hard floor (LEGIBLE.floor); only below that may a slide show a subset — the elements its
// caption names — never one picked by density.

import { LEGIBLE, LIKEC4_EDGE_PX, LIKEC4_TITLE_PX } from './logic.mjs'

/** The safe rect in canvas px: `insets` = {top, bottom} measured; sides default to 4 % of the width. */
export function safeRect(canvas, insets = {}) {
  const side = insets.side ?? Math.round(canvas.width * 0.04)
  const top = Math.max(insets.top ?? 0, Math.round(canvas.height * 0.04))
  const bottom = Math.max(insets.bottom ?? 0, Math.round(canvas.height * 0.04))
  return { x: side, y: top, width: Math.max(80, canvas.width - 2 * side), height: Math.max(80, canvas.height - top - bottom) }
}

const box = (n) => ({ x: n.x, y: n.y, x2: n.x + n.width, y2: n.y + n.height })
const union = (bs) =>
  bs.reduce((a, b) => (a ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) } : { ...b }), null)
const inside = (b, r) => b.x >= r.x - 0.5 && b.y >= r.y - 0.5 && b.x2 <= r.x2 + 0.5 && b.y2 <= r.y2 + 0.5
const apart = (b, r) => b.x2 <= r.x || b.x >= r.x2 || b.y2 <= r.y || b.y >= r.y2
const fitZoom = (b, S) => Math.min(S.width / Math.max(1, b.x2 - b.x), S.height / Math.max(1, b.y2 - b.y))

export const leavesOf = (view) => (view?.nodes ?? []).filter((n) => !(n.children?.length) && n.width > 0)

/** The flow box covering some nodes + the labels of the edges between them. */
export function contentBox(view, ids, ke = 1) {
  const set = new Set(ids)
  // a label is shown ke× its layout size, grown around its centre (Stage's legible CSS)
  const grow = (b) => ({ x: b.x - (b.width * (ke - 1)) / 2, y: b.y - (b.height * (ke - 1)) / 2, w: b.width * ke, h: b.height * ke })
  const nodes = (view?.nodes ?? []).filter((n) => set.has(n.id) && n.width > 0).map(box)
  const labels = (view?.edges ?? [])
    .filter((e) => set.has(e.source) && set.has(e.target) && e.labelBBox?.width > 0)
    .map((e) => grow(e.labelBBox))
    .map((b) => ({ x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h }))
  return union([...nodes, ...labels])
}

/**
 * The camera for a slide. `subject`: node ids the slide is about (a focus, a step's two ends),
 * or null for the whole view. → {vp: {x, y, zoom}, k, ke, cropped, visible: [ids], partial: [ids]}
 */
export function frameSlide(view, canvas, insets = {}, { subject = null, named = null, kFixed, keFixed = 1, zoomCap = 1.25, t = LEGIBLE } = {}) {
  const frameAlso = [] // containers framed whole with the subject (a caption-named one)
  const boxOf = (ids) => contentBox(view, [...ids, ...frameAlso], keFixed)
  const S0 = safeRect(canvas, insets)
  const S = { ...S0, x2: S0.x + S0.width, y2: S0.y + S0.height }
  const leaves = leavesOf(view)
  const b = view?.bounds
  const all = b ? { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height } : union(leaves.map(box))
  if (!all) return { vp: { x: 0, y: 0, zoom: 1 }, k: 1, ke: 1, cropped: false, visible: [], partial: [] }
  const zAll = fitZoom(all, S0)
  const k = kFixed ?? Math.min(t.kMax, Math.max(1, t.title / (LIKEC4_TITLE_PX * zAll)))
  // the hard floor: titles may shrink to t.floor CSS px on screen, no further
  const zMin = (t.floor ?? t.title) / (LIKEC4_TITLE_PX * k)
  const has = (id) => (view.nodes ?? []).some((n) => n.id === id)
  let ids = subject?.filter(has) ?? []
  let cropped = false
  if (!ids.length && zAll < zMin - 1e-9) {
    // below the hard floor: the elements the caption names (leaves; a named container → its leaves)
    const leafIds = new Set(leaves.map((n) => n.id))
    const pick = new Set()
    for (const id of named ?? []) {
      if (leafIds.has(id)) pick.add(id)
      else {
        for (const n of leaves) if (n.id.startsWith(id + '.')) pick.add(n.id)
        if (has(id)) frameAlso.push(id) // a named container is shown whole, border and title
      }
    }
    // a caption that names one element, or under half the view, is not a reason to drop the rest:
    // the whole view, at the floor
    if (pick.size >= 2 && pick.size >= leaves.length / 2) {
      ids = [...pick]
      cropped = true
    } else frameAlso.length = 0
  }
  const subjectFrame = ids.length > 0
  const core = new Set(ids) // a focus / step / named subject is never let go
  let B = ids.length ? boxOf(ids) : all
  // place: B inside the safe rect; then no leaf may straddle the canvas edge or the safe rect
  const C = { x: 0, y: 0, x2: canvas.width, y2: canvas.height }
  // a subject frame stops at zoomCap; the whole view just fits
  let zoom = Math.min(fitZoom(B, S0), ids.length ? zoomCap : Infinity)
  const evaluate = (z, cx, cy) => {
    // flow → screen: sx = fx * z + vx, with (cx, cy) landing on the safe rect's centre
    const vx = S.x + S0.width / 2 - cx * z
    const vy = S.y + S0.height / 2 - cy * z
    const toFlow = (r) => ({ x: (r.x - vx) / z, y: (r.y - vy) / z, x2: (r.x2 - vx) / z, y2: (r.y2 - vy) / z })
    const Rs = toFlow(S)
    const Rc = toFlow(C)
    const visible = []
    const partial = []
    for (const n of leaves) {
      const nb = box(n)
      if (inside(nb, Rs)) visible.push(n.id)
      else if (!apart(nb, Rc)) partial.push(n.id)
    }
    // centre what's ON SCREEN: the subject and every node shown with it
    const cb = union([B, ...leaves.filter((n) => visible.includes(n.id)).map(box)])
    const off = Math.hypot((cb.x + cb.x2) / 2 - (Rs.x + Rs.x2) / 2, (cb.y + cb.y2) / 2 - (Rs.y + Rs.y2) / 2) * z
    return { vp: { x: vx, y: vy, zoom: z }, visible, partial, off, ok: inside(B, Rs) }
  }
  const tol = 0.05 * Math.min(S0.width, S0.height)
  const placeBest = () => {
    // the best placement at this zoom: no straddling node first, then the most centred
    const w = S0.width / zoom
    const h = S0.height / zoom
    const span = (lo, hi, len) => {
      const [p, q] = [Math.min(hi - len / 2, lo + len / 2), Math.max(hi - len / 2, lo + len / 2)]
      return [...Array(13)].map((_, i) => p + ((q - p) * i) / 12)
    }
    let best = null
    for (const cx of [(B.x + B.x2) / 2, ...span(B.x, B.x2, w)])
      for (const cy of [(B.y + B.y2) / 2, ...span(B.y, B.y2, h)]) {
        const r = evaluate(zoom, cx, cy)
        if (!r.ok) continue
        const score = r.partial.length * 1e6 + (r.off > tol ? 1e3 : 0) + r.off
        if (!best || score < best.score) best = { ...r, score }
      }
    return best ?? evaluate(zoom, (B.x + B.x2) / 2, (B.y + B.y2) / 2)
  }
  let result = placeBest()
  if (subjectFrame && (result.partial.length || result.off > tol)) {
    // a focus / step frame: search the zoom (nearest the preferred one first) for a placement with
    // nothing straddling and the subject centred
    const zHi = fitZoom(B, S0)
    const zLo = Math.min(zHi, Math.max(zMin, zHi / 8))
    const zs = [...Array(24)].map((_, i) => zLo * (zHi / zLo) ** (i / 23)).sort((a, c) => Math.abs(Math.log(a / zoom)) - Math.abs(Math.log(c / zoom)))
    for (const z of zs) {
      zoom = z
      const r = placeBest()
      if (!r.partial.length && r.off <= tol) {
        result = r
        break
      }
      if (!r.partial.length && result.partial.length) result = r
    }
    // still nothing clean and centred: the neighbours in the way join the subject (whole), and
    // the group is centred — as long as it stays legible
    for (let round = 0; round < 6 && (result.partial.length || result.off > tol); round++) {
      zoom = Math.min(fitZoom(B, S0), zoomCap)
      const centred = evaluate(zoom, (B.x + B.x2) / 2, (B.y + B.y2) / 2)
      if (!centred.partial.length) {
        result = centred
        break
      }
      const grown = boxOf([...new Set([...ids, ...centred.partial])])
      if (!grown || fitZoom(grown, S0) < zMin - 1e-9) break
      ids = [...new Set([...ids, ...centred.partial])]
      B = grown
      zoom = Math.min(fitZoom(B, S0), zoomCap)
      const r = placeBest()
      if (!r.partial.length) result = r
    }
  }
  const dropped = new Set()
  for (let round = 0; !subjectFrame && round < 16 && (result.partial.length || result.off > tol); round++) {
    // what straddles when the subject is centred?
    const centred = evaluate(zoom, (B.x + B.x2) / 2, (B.y + B.y2) / 2)
    const straddling = centred.partial.length ? centred.partial : result.partial
    if (!straddling.length) break
    const takeable = straddling.filter((id) => !dropped.has(id))
    const grown = takeable.length ? boxOf([...new Set([...(ids.length ? ids : leaves.map((n) => n.id)), ...takeable])]) : null
    if (grown && fitZoom(grown, S0) >= zMin - 1e-9) {
      // take the straddling nodes in whole (zooming out, never below legible)
      // (a focus / step frame absorbs its straddling neighbours and centres the group)
      ids = [...new Set([...ids, ...takeable])]
      B = grown
      zoom = Math.min(zoom, fitZoom(grown, S0))
    } else if (zoom * 1.12 <= fitZoom(B, S0)) {
      zoom *= 1.12 // closer in, so the neighbours fall fully outside
    } else if ((cropped || subjectFrame) && ids.some((id) => !core.has(id))) {
      // can't take it in legibly: let go of the cluster member nearest to it instead
      const p = (view.nodes ?? []).find((n) => n.id === straddling[0])
      const pc = [p.x + p.width / 2, p.y + p.height / 2]
      const d = (id) => {
        const n = (view.nodes ?? []).find((x) => x.id === id)
        return Math.hypot(n.x + n.width / 2 - pc[0], n.y + n.height / 2 - pc[1])
      }
      const gone = ids.filter((id) => !core.has(id)).sort((a, c) => d(a) - d(c))[0]
      dropped.add(gone)
      ids = ids.filter((id) => id !== gone)
      B = boxOf(ids)
      zoom = Math.min(fitZoom(B, S0), zMin * 1.15)
    } else break
    result = placeBest()
  }
  // last resort for a crop: search the zoom for a clean placement, letting go of cluster members
  // (never the slide's own subject) until one exists — partially visible nodes are a bug
  const searchZoom = (lo, hi) => {
    let clean = null
    for (let i = 0; i < 24; i++) {
      zoom = lo * (hi / lo) ** (i / 23)
      const r = placeBest()
      if (!r.partial.length && r.off <= tol) return r
      if (!r.partial.length && !clean) clean = r
    }
    return clean
  }
  while (result.partial.length && (cropped || subjectFrame)) {
    const hi = fitZoom(B, S0)
    const found = searchZoom(Math.min(hi, zMin), Math.max(hi, zMin))
    if (found) {
      result = found
      break
    }
    const spare = ids.filter((id) => !core.has(id))
    if (!spare.length) break
    const p = (view.nodes ?? []).find((n) => n.id === result.partial[0])
    const pc = [p.x + p.width / 2, p.y + p.height / 2]
    const d = (id) => {
      const n = (view.nodes ?? []).find((x) => x.id === id)
      return Math.hypot(n.x + n.width / 2 - pc[0], n.y + n.height / 2 - pc[1])
    }
    const gone = spare.sort((a, c) => d(a) - d(c))[0]
    ids = ids.filter((id) => id !== gone)
    B = boxOf(ids)
    zoom = Math.min(fitZoom(B, S0), zMin * 1.15)
    result = placeBest()
  }
  const ke = Math.min(t.keMax, Math.max(1, t.edge / (LIKEC4_EDGE_PX * result.vp.zoom)))
  return { vp: result.vp, k, ke, cropped: cropped || result.visible.length < leaves.length, visible: result.visible, partial: result.partial, centred: ids.length ? ids : result.visible }
}
