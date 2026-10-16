/**
 * Stage — the layered, synced-camera view switcher shared by Explore and Present (ported
 * from the atlas spike's presenter). Every view renders in its own <ReactLikeC4> "layer".
 * Going to another view mounts it as a second layer, waits for it to initialise, then
 * drives BOTH layers' xyflow cameras from one rAF timeline:
 *   - parent layer: the camera flies into the portal node until it fills the stage
 *   - child layer:  its camera is fitted INTO the portal node's on-screen rect, which grows
 *     to the full stage, while the two layers crossfade.
 * Going up runs the same timeline backwards; unrelated views crossfade. Everything stays
 * vector (real viewport changes, no bitmap snapshot, no CSS scale). Multi-level jumps hop
 * through the intermediate levels so every level change is a zoom. Reduced motion → a
 * short fade.
 */
import { LikeC4ModelProvider, ReactLikeC4, type DiagramApi } from '@likec4/diagram'
import type { LikeC4Model } from '@likec4/core/model'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { frameSlide, safeRect } from './framing.mjs'
import { fitBox, interpolateZoom, rampedProgress, parentView, viewChain, visInit, visReduce } from './logic.mjs'
import { DIVE_LEVEL_FRACTION, FADE_MS, JUMP_MS, ZOOM_MS, easeInOutCubic, factor, patchCamera, reducedMotion } from './motion'

type Box = { x: number; y: number; width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }
type LayerHandle = { diagram: DiagramApi; xyflow: any; el: HTMLDivElement | null }
export type Via = { view: string; via?: string }[] // presenter tours: `via` portals

export type StageHandle = {
  /** Go to `view` (hopping levels); resolves when the camera has settled. Calls are queued. */
  go: (view: string) => Promise<void>
  current: () => string
  diagram: () => DiagramApi | undefined
  xyflow: () => any
  busy: () => boolean
  parentOf: (view: string) => string | null
  chain: (view: string) => string[]
  /** resolves once the first layer is initialised */
  ready: () => Promise<void>
  /** ease the active layer's camera to its (legible) framing */
  frame: (ms?: number) => void
  /** does the legible framing crop the current view (the whole view isn't on screen)? */
  cropped: () => boolean
  /** show the WHOLE current view, legibility aside (presenter "Fit all") */
  fitAll: (ms?: number) => void
  /** the subject of the next camera moves (a focus, a step's ends); null = the whole view */
  aim: (subject: string[] | null) => void
  /** present / record: re-apply the clip to the band between the chrome and the caption (it changed) */
  reclip: () => void
  /** a camera move (ours or LikeC4's) is under way */
  moving: () => boolean
  /** present / record: the leaves a slide too big to show whole narrowed to (caption-named), else null */
  subject: () => string[] | null
}

type Props = {
  model: LikeC4Model<any>
  data: any
  initialView: string
  scheme: 'light' | 'dark'
  themeCss: string
  tour?: Via
  pad?: number
  layerProps: Record<string, any>
  onNodeClick?: (node: any) => void
  onNavigateTo?: (to: string, node: any) => void
  onCanvasClick?: () => void
  onNodeContextMenu?: (node: any, e: MouseEvent) => void
  onSettled?: (view: string) => void
  /** a view change is under way and will end on `view` (the breadcrumb follows from the start) */
  onCommit?: (view: string) => void
  /** present / record: bigger titles + edge labels, hide text that would render illegibly, and
   *  frame the densest window when the whole view can't be shown legibly */
  legible?: boolean
  /** present / record: the measured top chrome + bottom caption panel (px) the framing keeps
   *  clear of — read at the moment of each camera move (so it's the TARGET slide's caption) */
  insets?: () => { top: number; bottom: number; clipBottom?: number }
  /** present / record: the node ids the current slide's caption names (a too-big view narrows to them) */
  named?: (viewId: string) => string[] | null
}

const PAD_DEFAULT = 56
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return x * x * (3 - 2 * x)
}
const toView = (vp: Viewport, W: number, H: number): [number, number, number] => [(W / 2 - vp.x) / vp.zoom, (H / 2 - vp.y) / vp.zoom, W / vp.zoom]
const viewToVp = ([cx, cy, w]: number[], W: number, H: number): Viewport => {
  const zoom = W / w
  return { zoom, x: W / 2 - cx * zoom, y: H / 2 - cy * zoom }
}
function animate(ms: number, frame: (t: number) => void, reverse = false) {
  return new Promise<void>((resolve) => {
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / Math.max(1, ms))
      frame(easeInOutCubic(reverse ? 1 - p : p))
      if (p < 1) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
}

export const Stage = forwardRef<StageHandle, Props>(function Stage(
  { model, data, initialView, scheme, themeCss, tour = [], pad = PAD_DEFAULT, layerProps, onNodeClick, onNavigateTo, onCanvasClick, onNodeContextMenu, onSettled, onCommit, legible, insets: insetsFn, named: namedFn },
  ref,
) {
  const views = useMemo(() => {
    const m = new Map<string, any>()
    for (const v of model.views()) m.set(v.id, v.$layouted)
    return m
  }, [model])

  // present / record framing (framing.mjs): fit the slide's subject into the SAFE RECT — the
  // canvas minus the measured top chrome + caption panel + side margins — centred, never cutting
  // through a node. Explore keeps the plain whole-view fit.
  const canvasSize = () => ({ width: stage.current?.clientWidth ?? 0, height: stage.current?.clientHeight ?? 0 })
  const fullRect = (): Box => ({ x: 0, y: 0, ...canvasSize() })
  const insets = () => insetsFn?.() ?? { top: 0, bottom: 0 }
  const aimRef = useRef<string[] | null>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const ownMove = useRef(false) // our own animated moves are already framed — don't re-aim them
  const framed = (viewId: string, key?: number, subject?: string[] | null) =>
    frameSlide(views.get(viewId), canvasSize(), insets(), { subject: subject ?? null, named: subject ? null : (namedFn?.(viewId) ?? null), kFixed: key != null ? layerScale.current.get(key)?.k : undefined, keFixed: key != null ? layerScale.current.get(key)?.ke : undefined }) as any
  /** the viewport (whole canvas) a view is shown with */
  const vpFor = (viewId: string, key?: number, subject?: string[] | null) =>
    legible ? framed(viewId, key, subject).vp : fitBox(views.get(viewId).bounds, fullRect(), pad)
  /** the flow box the whole canvas shows under a viewport (for the synced zoom hand-off) */
  const canvasBox = (vp: { x: number; y: number; zoom: number }): Box => {
    const c = canvasSize()
    return { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, width: c.width / vp.zoom, height: c.height / vp.zoom }
  }
  const kOf = (viewId: string) => (legible ? framed(viewId).k : 1)
  const keOf = (viewId: string) => (legible ? framed(viewId).ke : 1)
  // a layer's text scale is fixed when it mounts — a later stage/caption resize re-frames the
  // camera but never resizes the text under the viewer's eyes
  const layerScale = useRef(new Map<number, { k: number; ke: number }>())
  const scaleOf = (key: number, viewId: string) => {
    let v = layerScale.current.get(key)
    if (!v) layerScale.current.set(key, (v = { k: kOf(viewId), ke: keOf(viewId) }))
    return v
  }

  // present / record, AT REST (the camera still for ≥ 150 ms, the end of each move): nothing is
  // shown partly — every node, compound, edge and edge label not wholly inside the safe rect is
  // faded out (data-atlas-out). In motion nothing is hidden for that: things move through the
  // edges naturally (the clip keeps them off the chrome and caption).
  const culledAt = useRef(new Map<number, string>())
  const moveUntil = useRef(0)
  // … and the diagram is CLIPPED to the band between the top chrome and the caption, so nothing
  // (an edge mid-move, a container border) ever draws under them, even mid-transition
  const clip = () => {
    const el = stage.current
    if (!legible || !el) return
    const c = canvasSize()
    const ins = insets()
    const S = safeRect(c, ins)
    const bottom = Math.max(c.height - S.y - S.height, ins.clipBottom ?? 0)
    el.style.clipPath = `inset(${Math.max(0, S.y - 4)}px 0 ${Math.max(0, bottom - 4)}px 0)`
  }
  const unmark = (key: number) => {
    const sr = handles.current.get(key)?.el?.querySelector('.likec4-view')?.shadowRoot
    for (const el of sr?.querySelectorAll('[data-atlas-out]') ?? []) el.removeAttribute('data-atlas-out')
    culledAt.current.delete(key)
  }
  const unmarkRef = useRef(unmark)
  unmarkRef.current = unmark
  const cull = (key: number, vp: { x: number; y: number; zoom: number }) => {
    if (!legible) return
    clip()
    const h = handles.current.get(key)
    const sr = h?.el?.querySelector('.likec4-view')?.shadowRoot
    const cur = h?.xyflow?.getViewport?.()
    const st0 = stage.current?.getBoundingClientRect()
    if (!sr || !cur || !st0) return
    const v = views.get(h.el?.dataset.view ?? '')
    const S = safeRect(canvasSize(), insets())
    const R = { x: (S.x - vp.x) / vp.zoom, y: (S.y - vp.y) / vp.zoom, x2: (S.x + S.width - vp.x) / vp.zoom, y2: (S.y + S.height - vp.y) / vp.zoom }
    // screen rect now → flow box (the current viewport)
    const flow = (r: DOMRect) => ({ x: (r.left - st0.left - cur.x) / cur.zoom, y: (r.top - st0.top - cur.y) / cur.zoom, x2: (r.right - st0.left - cur.x) / cur.zoom, y2: (r.bottom - st0.top - cur.y) / cur.zoom })
    const whole = (b: any) => b.x >= R.x - 0.5 && b.y >= R.y - 0.5 && b.x2 <= R.x2 + 0.5 && b.y2 <= R.y2 + 0.5
    const mark = (el: Element, out: boolean) => (out ? el.setAttribute('data-atlas-out', '') : el.removeAttribute('data-atlas-out'))
    for (const el of sr.querySelectorAll('.react-flow__node')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0) mark(el, !whole(flow(r)))
    }
    const edgeOut = new Map<string, boolean>()
    for (const el of sr.querySelectorAll<SVGGraphicsElement>('.react-flow__edge')) {
      let out = true
      try {
        const b = el.getBBox() // the edges' svg sits in the viewport transform: user space = flow
        out = !whole({ x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height })
      } catch {
        /* not rendered */
      }
      edgeOut.set(el.getAttribute('data-id') ?? '', out)
      mark(el, out)
    }
    // a label goes with its edge (matched by its layout position), and on its own when it is cut
    const centres = (v?.edges ?? [])
      .filter((e: any) => e.labelBBox?.width > 0)
      .map((e: any) => ({ id: e.id, x: e.labelBBox.x + e.labelBBox.width / 2, y: e.labelBBox.y + e.labelBBox.height / 2 }))
    for (const el of sr.querySelectorAll('.likec4-edge-label-container')) {
      const lab = el.querySelector('.likec4-edge-label') ?? el
      const r = lab.getBoundingClientRect()
      if (!(r.width > 0)) continue
      const b = flow(r)
      const cx = (b.x + b.x2) / 2
      const cy = (b.y + b.y2) / 2
      const near = centres.sort((a: any, c: any) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(c.x - cx, c.y - cy))[0]
      const edgeGone = near && Math.hypot(near.x - cx, near.y - cy) < 48 && edgeOut.get(near.id) === true
      mark(el, edgeGone || !whole(b))
    }
    culledAt.current.set(key, `${Math.round(vp.x)},${Math.round(vp.y)},${vp.zoom.toFixed(4)}`)
  }

  // hierarchy: the view holding a node that drills into it → a tour `via` → the scope parent
  const parentOf = useCallback(
    (viewId: string): string | null => {
      for (const [id, v] of views) if (id !== viewId && v.nodes.some((n: any) => n.navigateTo === viewId)) return id
      const i = tour.findIndex((s) => s.view === viewId && s.via)
      if (i > 0) for (let j = i - 1; j >= 0; j--) if (tour[j].view !== viewId) return tour[j].view
      if (views.get(viewId)?.viewOf) {
        const p = parentView(data, viewId)
        if (p && p !== viewId) return p
      }
      return null
    },
    [views, tour, data],
  )
  const chain = useCallback((viewId: string): string[] => viewChain(data, viewId, parentOf), [data, parentOf])
  const portalFor = useCallback(
    (parent: string, child: string): string | null => {
      const pv = views.get(parent)
      const n = pv?.nodes.find((n: any) => n.navigateTo === child)
      if (n) return n.id
      const scope = views.get(child)?.viewOf
      if (scope && pv?.nodes.some((n: any) => n.id === scope)) return scope
      const via = tour.find((s) => s.view === child && s.via)?.via
      return via && pv?.nodes.some((n: any) => n.id === via) ? via : null
    },
    [views, tour],
  )

  const [layers, setLayers] = useState<{ key: number; viewId: string }[]>([{ key: 0, viewId: initialView }])
  const [active, setActive] = useState(0)
  const keySeq = useRef(0)
  const handles = useRef(new Map<number, LayerHandle>())
  const ready = useRef(new Map<number, { promise: Promise<void>; resolve: () => void }>())
  const stage = useRef<HTMLDivElement>(null)
  const st = useRef({ active, layers })
  st.current = { active, layers }
  const queue = useRef<Promise<void>>(Promise.resolve())
  const firstReady = useRef<{ promise: Promise<void>; resolve: () => void }>(null as any)
  if (!firstReady.current) {
    let resolve!: () => void
    firstReady.current = { promise: new Promise<void>((r) => (resolve = r)), resolve }
  }
  const busyN = useRef(0)

  const readyOf = (key: number) => {
    let r = ready.current.get(key)
    if (!r) {
      let resolve!: () => void
      const promise = new Promise<void>((res) => (resolve = res))
      r = { promise, resolve }
      ready.current.set(key, r)
    }
    return r
  }
  const currentView = () => st.current.layers.find((l) => l.key === st.current.active)?.viewId ?? initialView

  const transition = useCallback(
    async (target: string, jump = false) => {
      const fromKey = st.current.active
      const srcView = currentView()
      if (srcView === target || !views.has(target)) return
      const A = handles.current.get(fromKey)
      if (!A?.xyflow) return
      const toKey = ++keySeq.current
      st.current = { ...st.current, layers: [...st.current.layers, { key: toKey, viewId: target }] }
      setLayers((ls) => [...ls, { key: toKey, viewId: target }])
      await readyOf(toKey).promise
      await nextFrame()
      await sleep(80) // let the fresh diagram finish its own initial fit
      const B = handles.current.get(toKey)!
      const W = stage.current!.clientWidth
      const H = stage.current!.clientHeight
      const full: Box = { x: 0, y: 0, width: W, height: H }

      let kind: 'in' | 'out' | 'fade' = 'fade'
      let portal: string | null = null
      if (jump) kind = 'fade'
      else if (parentOf(target) === srcView) ((kind = 'in'), (portal = portalFor(srcView, target)))
      else if (parentOf(srcView) === target) ((kind = 'out'), (portal = portalFor(target, srcView)))
      const still = reducedMotion()
      if (!portal || still) kind = 'fade'

      const elA = A.el!
      const elB = B.el!
      elB.style.opacity = '0'
      elB.style.zIndex = kind === 'out' ? '1' : '2'
      elA.style.zIndex = kind === 'out' ? '2' : '1'
      document.documentElement.dataset.atlasTransition = kind
      // small-text visibility: the arriving layer decides from its DESTINATION zoom from frame 1,
      // the leaving one keeps what it shows — nothing pops mid-zoom
      visRef.current(fromKey, srcView, { type: 'freeze' })
      visRef.current(toKey, target, { type: 'target', zoom: vpFor(target, toKey).zoom, until: Infinity })
      elA.style.willChange = elB.style.willChange = 'opacity' // composited only while fading
      // the arriving layer is culled once it has arrived (in motion, partial is natural)
      const vpDest = legible ? vpFor(target, toKey) : null
      moveUntil.current = performance.now() + 10000 // released when the hand-off ends

      // the target view is committed now: the breadcrumb follows it from the move's start
      onCommitRef.current?.(target)
      if (kind === 'fade') {
        const vpB = vpFor(target, toKey)
        const vpA = A.xyflow.getViewport()
        // both scale about the safe rect's centre (a shrink keeps the source inside its frame)
        const S = legible ? safeRect(canvasSize(), insets()) : fullRect()
        const cx = S.x + S.width / 2
        const cy = S.y + S.height / 2
        const about = (vp: any, s: number) => ({ zoom: vp.zoom * s, x: cx - (cx - vp.x) * s, y: cy - (cy - vp.y) * s })
        // a jump (cousin / several levels) reads as a move: the source recedes while the target
        // arrives; an unrelated view just crossfades in
        const sA = jump ? 0.9 : 1
        await animate(still ? 160 : (jump ? JUMP_MS : FADE_MS) * factor(), (t) => {
          if (!still) {
            B.xyflow.setViewport(about(vpB, lerp(jump ? 1.08 : 0.94, 1, t)))
            if (sA !== 1) A.xyflow.setViewport(about(vpA, lerp(1, sA, t)))
          }
          elA.style.opacity = String(1 - smoothstep(0, 0.7, t))
          elB.style.opacity = String(smoothstep(0.3, 1, t))
        })
      } else {
        // roles: P = parent layer (camera flies into portal), C = child layer (emerges from it)
        const [P, C] = kind === 'in' ? [A, B] : [B, A]
        const parentId = kind === 'in' ? srcView : target
        const childId = kind === 'in' ? target : srcView
        const node = views.get(parentId).nodes.find((n: any) => n.id === portal) as Box
        // the child ends EXACTLY on its framing: fit the canvas box that framing shows
        const childBounds = canvasBox(vpFor(childId, kind === 'in' ? toKey : fromKey))
        const vpP0 = kind === 'in' ? A.xyflow.getViewport() : vpFor(parentId, toKey)
        const FR = fullRect()
        const vpP1 = fitBox(node, full, Math.min(W, H) * 0.03, 12)
        const zi = interpolateZoom(1.0)(toView(vpP0, W, H), toView(vpP1, W, H))
        const frame = (t: number) => {
          const vp = viewToVp(zi(t), W, H)
          P.xyflow.setViewport(vp)
          const nodeRect: Box = { x: node.x * vp.zoom + vp.x, y: node.y * vp.zoom + vp.y, width: node.width * vp.zoom, height: node.height * vp.zoom }
          const k = t ** 2 // hand-off from "inside the node" to "the whole stage"
          const rect: Box = { x: lerp(nodeRect.x, 0, k), y: lerp(nodeRect.y, 0, k), width: lerp(nodeRect.width, FR.width, k), height: lerp(nodeRect.height, FR.height, k) }
          C.xyflow.setViewport(fitBox(childBounds, rect, lerp(nodeRect.width * 0.06, 0, k)))
          const a = smoothstep(0.4, 0.88, t)
          P.el!.style.opacity = String(1 - a)
          C.el!.style.opacity = String(a)
        }
        frame(kind === 'in' ? 0 : 1)
        await animate(ZOOM_MS * factor(), frame, kind === 'out')
      }

      elB.style.opacity = '1'
      moveUntil.current = performance.now() + 150
      if (vpDest) cull(toKey, vpDest) // at rest: the no-partial rule
      visRef.current(toKey, target, { type: 'release', now: performance.now() })
      elA.style.willChange = elB.style.willChange = '' // at rest: no layer hint → text re-rasters crisp
      delete document.documentElement.dataset.atlasTransition
      // sync the ref now: multi-hop jumps call transition() again before React re-renders
      st.current = { active: toKey, layers: [{ key: toKey, viewId: target }] }
      setActive(toKey)
      setLayers((ls) => ls.filter((l) => l.key === toKey))
      handles.current.delete(fromKey)
      ready.current.delete(fromKey)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [views, parentOf, portalFor, pad, legible, insetsFn],
  )

  // several levels straight down (or up): ONE continuous dive — every level's zoom-through-the-portal
  // chained on a single timeline (~0.9 × a single drill per level). The intermediate views are mounted up front
  // and only ever seen in flight; the breadcrumb is on the destination from the start.
  const dive = useCallback(
    async (levels: string[], dir: 'in' | 'out') => {
      // levels: [current, …, target]; for 'in' each next is the previous one's child, for 'out' its parent
      const fromKey = st.current.active
      const A = handles.current.get(fromKey)
      if (!A?.xyflow || levels.length < 3) return
      const keys = [fromKey, ...levels.slice(1).map(() => ++keySeq.current)]
      const added = levels.slice(1).map((v, i) => ({ key: keys[i + 1], viewId: v }))
      st.current = { ...st.current, layers: [...st.current.layers, ...added] }
      setLayers((ls) => [...ls, ...added])
      onCommitRef.current?.(levels[levels.length - 1])
      for (const k of keys.slice(1)) await readyOf(k).promise
      await nextFrame()
      await sleep(80) // let the fresh diagrams finish their own initial fit
      const W = stage.current!.clientWidth
      const H = stage.current!.clientHeight
      const full: Box = { x: 0, y: 0, width: W, height: H }
      const FR = fullRect()
      // depth order, outermost first: parents[i] holds the portal into parents[i + 1]
      const order = dir === 'in' ? levels.map((v, i) => ({ v, key: keys[i] })) : levels.map((v, i) => ({ v, key: keys[i] })).reverse()
      const segs = order.slice(0, -1).map((P, i) => {
        const C = order[i + 1]
        const portal = portalFor(P.v, C.v)
        const node = views.get(P.v)?.nodes?.find((n: any) => n.id === portal) as Box | undefined
        const vpP0 = dir === 'in' && i === 0 ? A.xyflow.getViewport() : vpFor(P.v, P.key)
        const childBounds = canvasBox(dir === 'out' && i === order.length - 2 ? A.xyflow.getViewport() : vpFor(C.v, C.key))
        return { P: handles.current.get(P.key)!, C: handles.current.get(C.key)!, node, vpP0, childBounds }
      })
      if (segs.some((g) => !g.node || !g.P?.xyflow || !g.C?.xyflow)) {
        // a level without a portal: fall back to one crossfade-zoom to the target
        st.current = { ...st.current, layers: st.current.layers.filter((l) => !added.some((a) => a.key === l.key)) }
        setLayers((ls) => ls.filter((l) => !added.some((a) => a.key === l.key)))
        return transition(levels[levels.length - 1], true)
      }
      const zis = segs.map((g) => interpolateZoom(1.0)(toView(g.vpP0, W, H), toView(fitBox(g.node!, full, Math.min(W, H) * 0.03, 12), W, H)))
      order.forEach((o, i) => {
        const el = handles.current.get(o.key)!.el!
        el.style.zIndex = String(2 + i) // deeper on top
        el.style.willChange = 'opacity'
      })
      document.documentElement.dataset.atlasTransition = dir
      const target = levels[levels.length - 1]
      const toKey = keys[keys.length - 1]
      visRef.current(fromKey, levels[0], { type: 'freeze' })
      for (const o of order) if (o.key !== fromKey) visRef.current(o.key, o.v, { type: 'target', zoom: vpFor(o.v, o.key).zoom, until: Infinity })
      moveUntil.current = performance.now() + 10000
      const n = segs.length
      const segFrame = (i: number, t: number) => {
        const g = segs[i]
        const vp = viewToVp(zis[i](t), W, H)
        g.P.xyflow.setViewport(vp)
        const node = g.node!
        const nodeRect: Box = { x: node.x * vp.zoom + vp.x, y: node.y * vp.zoom + vp.y, width: node.width * vp.zoom, height: node.height * vp.zoom }
        const k = t ** 2
        const rect: Box = { x: lerp(nodeRect.x, 0, k), y: lerp(nodeRect.y, 0, k), width: lerp(nodeRect.width, FR.width, k), height: lerp(nodeRect.height, FR.height, k) }
        g.C.xyflow.setViewport(fitBox(g.childBounds, rect, lerp(nodeRect.width * 0.06, 0, k)))
        const a = smoothstep(0.4, 0.88, t)
        order.forEach((o, j) => {
          const el = handles.current.get(o.key)!.el!
          el.style.opacity = j === i ? String(1 - a) : j === i + 1 ? String(a) : '0'
        })
      }
      // ONE timeline over all the levels, ~0.9 × a single drill per level: ease in at the start,
      // constant speed through the intermediate levels, ease out at the end. Each level's share of
      // it is its van Wijk path length (log-zoom), so the zoom rate is even from level to level.
      const lens = zis.map((z: any) => Math.max(1e-6, z.S ?? 1))
      const total = lens.reduce((a, b) => a + b, 0)
      const ends = lens.map((_, i) => lens.slice(0, i + 1).reduce((a, b) => a + b, 0) / total)
      const ms = n * DIVE_LEVEL_FRACTION * ZOOM_MS * factor()
      await new Promise<void>((resolve) => {
        const t0 = performance.now()
        const tick = (now: number) => {
          const p = Math.min(1, (now - t0) / ms)
          const d = rampedProgress(dir === 'out' ? 1 - p : p) // the camera's depth, 0 → 1 (or back)
          let i = ends.findIndex((e) => d <= e + 1e-9)
          if (i < 0) i = n - 1
          const start = i ? ends[i - 1] : 0
          segFrame(i, Math.min(1, Math.max(0, (d - start) / Math.max(1e-9, ends[i] - start))))
          if (p < 1) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      const B = handles.current.get(toKey)!
      B.el!.style.opacity = '1'
      moveUntil.current = performance.now() + 150
      if (legible) cull(toKey, vpFor(target, toKey))
      visRef.current(toKey, target, { type: 'release', now: performance.now() })
      for (const o of order) handles.current.get(o.key)!.el!.style.willChange = ''
      delete document.documentElement.dataset.atlasTransition
      st.current = { active: toKey, layers: [{ key: toKey, viewId: target }] }
      setActive(toKey)
      setLayers((ls) => ls.filter((l) => l.key === toKey))
      for (const k of keys) if (k !== toKey) (handles.current.delete(k), ready.current.delete(k))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [views, parentOf, portalFor, pad, legible, insetsFn, transition],
  )

  const goNow = useCallback(
    async (target: string) => {
      if (currentView() === target || !views.has(target)) return
      const from = chain(currentView())
      const to = chain(target)
      let common = 0
      while (common < from.length && common < to.length && from[common] === to[common]) common++
      const path = common > 0 ? [...from.slice(common - 1, -1).reverse(), ...to.slice(common)] : [target]
      const hops = path.filter((v) => v !== currentView())
      // straight down (a grandchild) or straight up (a grandparent): ONE continuous dive through
      // every level's portal
      if (hops.length > 1 && !reducedMotion() && (common === from.length || common === to.length)) {
        await dive([currentView(), ...hops], common === from.length ? 'in' : 'out')
        return
      }
      // parent ↔ child: the zoom through the portal. Anything else further (a cousin, a jump up
      // several levels) is ONE continuous move — a crossfade-zoom straight to the target; no
      // intermediate view ever "arrives"
      await transition(target, hops.length > 1)
    },
    [chain, transition, dive],
  )

  useImperativeHandle(
    ref,
    () => ({
      go: (target: string) => {
        busyN.current++
        const p = queue.current.then(() => goNow(target)).catch((e) => console.warn('[atlas] transition', e))
        queue.current = p.finally(() => {
          busyN.current--
          onSettled?.(currentView())
        })
        return queue.current
      },
      current: currentView,
      diagram: () => handles.current.get(st.current.active)?.diagram,
      xyflow: () => handles.current.get(st.current.active)?.xyflow,
      busy: () => busyN.current > 0,
      parentOf,
      chain,
      ready: () => firstReady.current.promise,
      cropped: () => !!legible && !!framed(currentView(), st.current.active).cropped,
      reclip: () => clip(),
      moving: () => performance.now() < moveUntil.current,
      subject: () => {
        if (!legible) return null
        const f = framed(currentView(), st.current.active, aimRef.current)
        return f.cropped && !aimRef.current ? f.centred : null
      },
      aim: (subject: string[] | null) => {
        aimRef.current = subject && subject.length ? subject : null
      },
      fitAll: (ms = 450) => {
        const h = handles.current.get(st.current.active)
        const v = views.get(currentView())
        ownMove.current = !!ms
        if (!h?.xyflow || !v) return
        const vp = fitBox(v.bounds, legible ? safeRect(canvasSize(), insets()) : fullRect(), legible ? 0 : pad)
        void h.xyflow.setViewport(vp, ms ? { duration: ms } : undefined)
        if (!ms) cull(st.current.active, vp)
      },
      frame: (ms = 450) => {
        const h = handles.current.get(st.current.active)
        if (!h?.xyflow) return
        const vp = vpFor(currentView(), st.current.active, aimRef.current)
        ownMove.current = !!ms
        void h.xyflow.setViewport(vp, ms ? { duration: ms } : undefined)
        if (!ms) cull(st.current.active, vp)
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goNow, parentOf, chain, onSettled, legible, views, pad, insetsFn],
  )

  // legible: per-layer small-text visibility (logic.mjs visReduce): programmatic camera moves decide
  // from their TARGET zoom and freeze; only a settled user zoom is evaluated live (hysteresis + fade)
  const [vis, setVis] = useState<Record<number, any>>({})
  const visDispatch = (key: number, viewId: string, e: any) => {
    if (!legible) return
    const ke = scaleOf(key, viewId).ke
    setVis((m) => {
      const cur = m[key] ?? visInit(ke, e.zoom ?? 1)
      const next = visReduce(cur, { ke, ...e })
      return next === cur && m[key] ? m : { ...m, [key]: next }
    })
  }
  const visRef = useRef(visDispatch)
  visRef.current = visDispatch
  const cullRef = useRef(cull)
  cullRef.current = cull
  useEffect(() => {
    if (!legible) return
    let last = 0
    let lastVp = ''
    let still = 0
    const id = window.setInterval(() => {
      const key = st.current.active
      const z = handles.current.get(key)?.xyflow?.getViewport?.().zoom
      if (!z) return
      const settled = Math.abs(z - last) < 1e-4 // the gesture / move has come to rest
      last = z
      visRef.current(key, currentView(), { type: 'live', zoom: z, now: performance.now(), settled })
      // at rest (and no programmatic move under way): re-cull for where the camera actually is —
      // a user pan / zoom, an instant move, a re-render
      const vp = handles.current.get(key)?.xyflow?.getViewport?.()
      if (vp) {
        const sig = `${Math.round(vp.x)},${Math.round(vp.y)},${vp.zoom.toFixed(4)}`
        still = sig === lastVp ? still + 1 : 0
        lastVp = sig
        // still (two equal ticks, ~75–150 ms) and no programmatic move under way: cull for where the
        // camera is — through the first ~600 ms of each rest (late-rendered labels), then now and then
        if (still >= 1 && performance.now() > moveUntil.current && (still <= 8 || culledAt.current.get(key) !== sig || still % 12 === 0)) cullRef.current(key, vp)
      }
    }, 75)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legible])
  const fadeMs = reducedMotion() ? 0 : 180
  const dimMs = reducedMotion() ? 0 : 600
  const legibleCssFor = (key: number) => {
    const v = vis[key]
    const ms = v?.fade ? fadeMs : 0
    const hide = (on: boolean) => `opacity:${on ? 0 : 1} !important;transition:opacity ${ms}ms ease !important`
    // descriptions / technology COLLAPSE when hidden (so a lone title centres in its box) and
    // grow back with the same fade — never mid camera move (the visibility state is frozen then)
    const collapse = (on: boolean, max: string) =>
      `${hide(on)},max-height ${ms}ms ease !important;max-height:${on ? '0' : max} !important;${on ? 'margin-block:0 !important;padding-block:0 !important;overflow:hidden !important;' : ''}`
    return [
      legibleCss,
      // our state decides (LikeC4's own zoom-small hiding would pop on its own threshold)
      `.likec4-element-node-data [data-likec4-node-description]{display:-webkit-box !important;${collapse(!!v?.hideDesc, '8rem')}}`,
      `.likec4-element-node-data [data-likec4-node-technology]{display:block !important;${collapse(!!v?.hideDesc, '4em')}}`,
      `.likec4-edge-label-container{${hide(!!v?.hideEdgeLabels)}}`,
      // culled (wholly or partly outside the safe rect): faded out, same timing as the text
      // a step's dim <-> highlight crossfades over the move (never a flash)
      `.react-flow__node,.react-flow__edge{transition:opacity ${dimMs}ms ease,filter ${dimMs}ms ease !important}`,
      `.react-flow__node[data-atlas-out],.react-flow__edge[data-atlas-out],.likec4-edge-label-container.likec4-edge-label-container[data-atlas-out]{opacity:0 !important;pointer-events:none !important;transition:opacity ${fadeMs}ms ease !important}`,
      // hidden small text comes back on the node that has keyboard focus or is selected (and the
      // node's accessible name always carries its description)
      '.react-flow__node:focus-visible [data-likec4-node-description],.react-flow__node:focus-visible [data-likec4-node-technology],.react-flow__node.selected [data-likec4-node-description],.react-flow__node.selected [data-likec4-node-technology]{opacity:1 !important;max-height:8rem !important}',
    ].join('\n')
  }
  const legibleCss = legible
    ? [
        '.likec4-shadow-root{' +
          [['xs', 13.33], ['sm', 16], ['md', 19.2], ['lg', 23.04], ['xl', 27.65]].map(([n, px]) => `--font-sizes-likec4-${n}:calc(${px}px * var(--atlas-k,1)) !important`).join(';') +
          '}',
        // descriptions / technology keep their original size (the boxes were laid out for it)
        '.likec4-element-node-data [data-likec4-node-description]{font-size:calc(var(--likec4-text-size) * .74 / var(--atlas-k,1)) !important}',
        '.likec4-element-node-data [data-likec4-node-technology]{font-size:calc(var(--likec4-text-size) * .635 / var(--atlas-k,1)) !important}',
        '.likec4-edge-label .likec4-edge-label__text{font-size:calc(14px * var(--atlas-ke,1)) !important;white-space:nowrap !important;overflow-wrap:normal !important}',
        // the label's wrapper caps its width (the layout's label box); with the larger text let it
        // size to its one line instead — the chip background then matches the text exactly
        '.likec4-edge-label-container > div{max-width:none !important}',
        // the bigger label grows around its layout centre (not off to the right, over a node) …
        '.likec4-edge-label{transform:translate(calc((1 / var(--atlas-ke,1) - 1) * 50%), calc((1 / var(--atlas-ke,1) - 1) * 50%)) !important}',
        // … on an OPAQUE chip: a translucent one over a node read as a stray coloured square
        '.likec4-edge-label-container{--xy-edge-label-background-color:var(--likec4-palette-relation-label-bg) !important}',
        '.likec4-compound-node .likec4-compound-title{font-size:calc(15px * var(--atlas-k,1)) !important}',
      ].join('\n')
    : ''
  // an edge label's will-change:transform freezes its raster at the scale it was first painted
  // at → blurry after any zoom; let it re-raster with the viewport
  const crispCss = '.likec4-edge-label-container{will-change:auto !important}'

  const fontVar = { '--likec4-app-font': 'var(--pl-font-sans)' } as any
  return (
    <div className="stage" ref={stage} data-scheme={scheme}>
      <LikeC4ModelProvider likec4model={model}>
        {layers.map((l) => (
          <div
            key={l.key}
            className="layer"
            data-view={l.viewId}
            data-active={l.key === active ? '' : undefined}
            ref={(el) => {
              const h = handles.current.get(l.key)
              if (h) h.el = el
              else if (el) handles.current.set(l.key, { el } as any)
            }}
            style={{ opacity: l.key === active ? 1 : 0, pointerEvents: l.key === active ? 'auto' : 'none', ...(legible ? ({ '--atlas-k': scaleOf(l.key, l.viewId).k, '--atlas-ke': scaleOf(l.key, l.viewId).ke } as any) : {}) }}
          >
            <ReactLikeC4
              {...layerProps}
              viewId={l.viewId as any}
              style={{ width: '100%', height: '100%', ...fontVar }}
              colorScheme={scheme}
              injectFontCss={false}
              background="transparent"
              fitViewPadding={pad as any}
              onNavigateTo={onNavigateTo ? (to: any, _ev: any, el: any) => onNavigateTo(String(to), el) : undefined}
              onNodeClick={onNodeClick ? (n: any) => onNodeClick(n) : undefined}
              onCanvasClick={onCanvasClick ? () => onCanvasClick() : undefined}
              onNodeContextMenu={onNodeContextMenu ? (n: any, e: any) => onNodeContextMenu(n, e) : undefined}
              onInitialized={({ diagram, xyflow }: any) => {
                const h = handles.current.get(l.key) ?? ({} as LayerHandle)
                handles.current.set(l.key, { ...h, diagram, xyflow })
                patchCamera(
                  diagram,
                  (zoom: number, ms: number, vp?: any) => {
                    moveUntil.current = Math.max(moveUntil.current, performance.now() + ms + 80)
                    visRef.current(l.key, l.viewId, { type: 'target', zoom, until: performance.now() + ms + 80 })
                    // in motion nothing is hidden for being partial: it moves through the edges
                    // (the clip still keeps it off the chrome / caption); the rest cull decides
                    if (vp) unmarkRef.current(l.key)
                  },
                  legible
                    ? (vp: any) => {
                        if (ownMove.current) {
                          ownMove.current = false
                          return vp
                        }
                        // LikeC4's own moves (a fit after navigating, a walkthrough focus) are re-aimed at
                        // the slide's subject — the whole view when it has none — in the safe rect
                        return vpFor(l.viewId, l.key, aimRef.current)
                      }
                    : undefined,
                  !!legible, // present / record: LikeC4's moves fly (one eased van Wijk path)
                  (vp: any) => {
                    moveUntil.current = performance.now()
                    cullRef.current(l.key, vp)
                  },
                )
                if (legible && l.key === 0) {
                  // the first layer: LikeC4 fitted the WHOLE view; frame it legibly instead
                  const vp = vpFor(l.viewId, l.key)
                  void xyflow.setViewport(vp)
                  visRef.current(l.key, l.viewId, { type: 'target', zoom: vp.zoom, until: 0 })
                  requestAnimationFrame(() => cullRef.current(l.key, vp))
                }
                readyOf(l.key).resolve()
                firstReady.current.resolve()
              }}
            >
              <style>{themeCss + '\n' + crispCss + (legible ? '\n' + legibleCssFor(l.key) : '')}</style>
            </ReactLikeC4>
          </div>
        ))}
      </LikeC4ModelProvider>
    </div>
  )
})
