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
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { fitBox, interpolateZoom, parentView, viewChain } from './logic.mjs'
import { FADE_MS, ZOOM_MS, easeInOutCubic, factor, patchCamera, reducedMotion } from './motion'

type Box = { x: number; y: number; width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }
type LayerHandle = { diagram: DiagramApi; xyflow: any; el: HTMLDivElement | null }
export type Via = { view: string; via?: string }[] // presenter tours: `via` portals

export type StageHandle = {
  /** Go to `view` (hopping levels); resolves when the camera has settled. Calls are queued. */
  go: (view: string) => Promise<void>
  current: () => string
  diagram: () => DiagramApi | undefined
  busy: () => boolean
  parentOf: (view: string) => string | null
  chain: (view: string) => string[]
  /** resolves once the first layer is initialised */
  ready: () => Promise<void>
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
  { model, data, initialView, scheme, themeCss, tour = [], pad = PAD_DEFAULT, layerProps, onNodeClick, onNavigateTo, onCanvasClick, onNodeContextMenu, onSettled },
  ref,
) {
  const views = useMemo(() => {
    const m = new Map<string, any>()
    for (const v of model.views()) m.set(v.id, v.$layouted)
    return m
  }, [model])

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
    async (target: string) => {
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
      if (parentOf(target) === srcView) ((kind = 'in'), (portal = portalFor(srcView, target)))
      else if (parentOf(srcView) === target) ((kind = 'out'), (portal = portalFor(target, srcView)))
      const still = reducedMotion()
      if (!portal || still) kind = 'fade'

      const elA = A.el!
      const elB = B.el!
      elB.style.opacity = '0'
      elB.style.zIndex = kind === 'out' ? '1' : '2'
      elA.style.zIndex = kind === 'out' ? '2' : '1'
      document.documentElement.dataset.atlasTransition = kind

      if (kind === 'fade') {
        const vpB = fitBox(views.get(target).bounds, full, pad)
        await animate(still ? 160 : FADE_MS * factor(), (t) => {
          if (!still) B.xyflow.setViewport({ ...vpB, zoom: vpB.zoom * lerp(0.94, 1, t), x: lerp(W / 2 - (W / 2 - vpB.x) * 0.94, vpB.x, t), y: lerp(H / 2 - (H / 2 - vpB.y) * 0.94, vpB.y, t) })
          elA.style.opacity = String(1 - t)
          elB.style.opacity = String(t)
        })
      } else {
        // roles: P = parent layer (camera flies into portal), C = child layer (emerges from it)
        const [P, C] = kind === 'in' ? [A, B] : [B, A]
        const parentId = kind === 'in' ? srcView : target
        const childId = kind === 'in' ? target : srcView
        const node = views.get(parentId).nodes.find((n: any) => n.id === portal) as Box
        const childBounds = views.get(childId).bounds as Box
        const vpP0 = kind === 'in' ? A.xyflow.getViewport() : fitBox(views.get(parentId).bounds, full, pad)
        const vpP1 = fitBox(node, full, Math.min(W, H) * 0.03, 12)
        const zi = interpolateZoom(1.0)(toView(vpP0, W, H), toView(vpP1, W, H))
        const frame = (t: number) => {
          const vp = viewToVp(zi(t), W, H)
          P.xyflow.setViewport(vp)
          const nodeRect: Box = { x: node.x * vp.zoom + vp.x, y: node.y * vp.zoom + vp.y, width: node.width * vp.zoom, height: node.height * vp.zoom }
          const k = t ** 2 // hand-off from "inside the node" to "the whole stage"
          const rect: Box = { x: lerp(nodeRect.x, 0, k), y: lerp(nodeRect.y, 0, k), width: lerp(nodeRect.width, W, k), height: lerp(nodeRect.height, H, k) }
          C.xyflow.setViewport(fitBox(childBounds, rect, lerp(nodeRect.width * 0.06, pad, k)))
          const a = smoothstep(0.4, 0.88, t)
          P.el!.style.opacity = String(1 - a)
          C.el!.style.opacity = String(a)
        }
        frame(kind === 'in' ? 0 : 1)
        await animate(ZOOM_MS * factor(), frame, kind === 'out')
      }

      elB.style.opacity = '1'
      delete document.documentElement.dataset.atlasTransition
      // sync the ref now: multi-hop jumps call transition() again before React re-renders
      st.current = { active: toKey, layers: [{ key: toKey, viewId: target }] }
      setActive(toKey)
      setLayers((ls) => ls.filter((l) => l.key === toKey))
      handles.current.delete(fromKey)
      ready.current.delete(fromKey)
    },
    [views, parentOf, portalFor, pad],
  )

  const goNow = useCallback(
    async (target: string) => {
      if (currentView() === target || !views.has(target)) return
      const from = chain(currentView())
      const to = chain(target)
      let common = 0
      while (common < from.length && common < to.length && from[common] === to[common]) common++
      const path = common > 0 ? [...from.slice(common - 1, -1).reverse(), ...to.slice(common)] : [target]
      for (const v of path) if (v !== currentView()) await transition(v)
    },
    [chain, transition],
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
      busy: () => busyN.current > 0,
      parentOf,
      chain,
      ready: () => firstReady.current.promise,
    }),
    [goNow, parentOf, chain, onSettled],
  )

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
            style={{ opacity: l.key === active ? 1 : 0, pointerEvents: l.key === active ? 'auto' : 'none' }}
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
                patchCamera(diagram)
                readyOf(l.key).resolve()
                firstReady.current.resolve()
              }}
            >
              <style>{themeCss}</style>
            </ReactLikeC4>
          </div>
        ))}
      </LikeC4ModelProvider>
    </div>
  )
})
