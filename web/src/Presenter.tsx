/**
 * Presenter (ported from the atlas spike). Every view renders in its own <ReactLikeC4>
 * "layer". A transition mounts the target view as a second layer, waits for it to
 * initialise, then drives BOTH layers' xyflow cameras from one rAF timeline:
 *   - parent layer: the camera flies into the portal node until it fills the stage
 *   - child layer:  the camera is fitted INTO the portal node's on-screen rect, which
 *     grows to the full stage, while the two layers crossfade.
 * Going up runs the same timeline backwards. Everything stays vector (real xyflow
 * viewport changes, no bitmap snapshot, no CSS scale). Reduced motion → a short fade.
 */
import { LikeC4ModelProvider, ReactLikeC4, type DiagramApi } from '@likec4/diagram'
import type { LikeC4Model } from '@likec4/core/model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cycle, dynamicSteps, fitBox, interpolateZoom, mdLight, parentView, presenterKey, viewChain } from './logic.mjs'

export type Slide = { view: string; focus?: string; step?: number; via?: string; note?: string }
export type Tour = { id: string; title: string; slides: Slide[]; auto?: boolean }
export type PresenterCmd = { seq: number; slide?: number; adhoc?: Slide }

type Box = { x: number; y: number; width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }
type LayerHandle = { diagram: DiagramApi; xyflow: any; el: HTMLDivElement | null }

const PAD = 56 // resting fit padding (px), shared by our math and the diagram
const ZOOM_MS = 560
const FADE_MS = 380
const SLOW = Number(new URLSearchParams(location.search).get('slow') ?? 1) || 1

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const smoothstep = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return x * x * (3 - 2 * x)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const stepId = (n: number) => `step-${String(n).padStart(2, '0')}` as any

// viewport <-> zoom "view" [cx, cy, w] (flow-space centre + visible width)
const toView = (vp: Viewport, W: number, H: number): [number, number, number] => [(W / 2 - vp.x) / vp.zoom, (H / 2 - vp.y) / vp.zoom, W / vp.zoom]
const viewToVp = ([cx, cy, w]: number[], W: number, H: number): Viewport => {
  const zoom = W / w
  return { zoom, x: W / 2 - cx * zoom, y: H / 2 - cy * zoom }
}

function animate(ms: number, frame: (t: number) => void, reverse = false) {
  return new Promise<void>((resolve) => {
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / (ms * SLOW))
      frame(easeInOutCubic(reverse ? 1 - p : p))
      if (p < 1) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
}

type Props = {
  model: LikeC4Model<any>
  data: any
  tours: Tour[]
  tourId: string
  start: number
  cmd: PresenterCmd | null
  scheme: 'light' | 'dark'
  onTour: (id: string) => void
  onExit: (view: string) => void
}

export function Presenter({ model, data, tours, tourId, start, cmd, scheme, onTour, onExit }: Props) {
  const tour = (tours.find((t) => t.id === tourId) ?? tours[0]).slides
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

  const first = Math.min(Math.max(start, 0), tour.length - 1)
  const [layers, setLayers] = useState<{ key: number; viewId: string }[]>([{ key: 0, viewId: tour[first].view }])
  const [active, setActive] = useState(0)
  const [slide, setSlide] = useState(first)
  const [walk, setWalk] = useState(0) // walkthrough position on a whole-dynamic-view slide
  const [showNotes, setShowNotes] = useState(true)
  const [focused, setFocused] = useState<string | null>(null)
  const [adhoc, setAdhoc] = useState<Slide | null>(null)
  const keySeq = useRef(0)
  const handles = useRef(new Map<number, LayerHandle>())
  const ready = useRef(new Map<number, { promise: Promise<void>; resolve: () => void }>())
  const busy = useRef(false)
  const stage = useRef<HTMLDivElement>(null)
  const st = useRef({ active, layers, slide, focused, walk })
  st.current = { active, layers, slide, focused, walk }

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
  const currentView = () => st.current.layers.find((l) => l.key === st.current.active)!.viewId
  const currentHandle = () => handles.current.get(st.current.active)
  const setWalkNow = (n: number) => {
    st.current = { ...st.current, walk: n }
    setWalk(n)
  }

  // ------------------------------------------------------------ transitions
  const transition = useCallback(
    async (target: string) => {
      const fromKey = st.current.active
      const srcView = currentView()
      if (srcView === target || !views.has(target)) return
      const A = handles.current.get(fromKey)!
      const toKey = ++keySeq.current
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
      if (!portal || reducedMotion()) kind = 'fade'

      const elA = A.el!
      const elB = B.el!
      elB.style.opacity = '0'
      elB.style.zIndex = kind === 'out' ? '1' : '2'
      elA.style.zIndex = kind === 'out' ? '2' : '1'
      document.documentElement.dataset.atlasTransition = kind

      if (kind === 'fade') {
        const still = reducedMotion()
        const vpB = fitBox(views.get(target).bounds, full, PAD)
        await animate(still ? 160 : FADE_MS, (t) => {
          if (!still) B.xyflow.setViewport({ ...vpB, zoom: vpB.zoom * lerp(0.92, 1, t), x: lerp(W / 2 - (W / 2 - vpB.x) * 0.92, vpB.x, t), y: lerp(H / 2 - (H / 2 - vpB.y) * 0.92, vpB.y, t) })
          elA.style.opacity = String(1 - t)
          elB.style.opacity = String(t)
        })
      } else {
        // roles: P = parent layer (camera flies into portal), C = child layer (emerges from portal)
        const [P, C] = kind === 'in' ? [A, B] : [B, A]
        const parentId = kind === 'in' ? srcView : target
        const childId = kind === 'in' ? target : srcView
        const node = views.get(parentId).nodes.find((n: any) => n.id === portal) as Box
        const childBounds = views.get(childId).bounds as Box
        const vpP0 = kind === 'in' ? A.xyflow.getViewport() : fitBox(views.get(parentId).bounds, full, PAD)
        const vpP1 = fitBox(node, full, Math.min(W, H) * 0.03, 12)
        const zi = interpolateZoom(1.0)(toView(vpP0, W, H), toView(vpP1, W, H))
        const frame = (t: number) => {
          const vp = viewToVp(zi(t), W, H)
          P.xyflow.setViewport(vp)
          const nodeRect: Box = { x: node.x * vp.zoom + vp.x, y: node.y * vp.zoom + vp.y, width: node.width * vp.zoom, height: node.height * vp.zoom }
          const k = t ** 2 // hand-off from "inside the node" to "the whole stage"
          const rect: Box = { x: lerp(nodeRect.x, 0, k), y: lerp(nodeRect.y, 0, k), width: lerp(nodeRect.width, W, k), height: lerp(nodeRect.height, H, k) }
          C.xyflow.setViewport(fitBox(childBounds, rect, lerp(nodeRect.width * 0.06, PAD, k)))
          const a = smoothstep(0.4, 0.88, t)
          P.el!.style.opacity = String(1 - a)
          C.el!.style.opacity = String(a)
        }
        frame(kind === 'in' ? 0 : 1)
        await animate(ZOOM_MS, frame, kind === 'out')
      }

      elB.style.opacity = '1'
      delete document.documentElement.dataset.atlasTransition
      // sync the ref now: multi-hop tours call transition() again before React re-renders
      st.current = { ...st.current, active: toKey, layers: [{ key: toKey, viewId: target }] }
      setActive(toKey)
      setLayers((ls) => ls.filter((l) => l.key === toKey))
      handles.current.delete(fromKey)
      ready.current.delete(fromKey)
      setFocused(null)
    },
    [views, parentOf, portalFor],
  )

  // a slide's focus / step on the (now) active layer
  const applySlideDetail = useCallback(async (s: Slide, sameView: boolean) => {
    const h = currentHandle()
    if (!h?.diagram) return
    const ctx = h.diagram.getContext() as any
    if (s.step) {
      if (ctx.activeWalkthrough && sameView) h.diagram.walkthroughStep({ step: stepId(s.step) })
      else h.diagram.startWalkthrough(stepId(s.step))
      setFocused(null)
      return
    }
    if (ctx.activeWalkthrough) h.diagram.stopWalkthrough()
    if (s.focus) {
      h.diagram.focusNode(s.focus as any)
      setFocused(s.focus)
    } else if (sameView) {
      h.diagram.send({ type: 'key.esc' } as any)
      h.diagram.fitDiagram(450)
      setFocused(null)
    }
  }, [])

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true
    try {
      await fn()
    } catch (e) {
      console.warn('[atlas] presenter', e)
    } finally {
      busy.current = false
    }
  }, [])

  const showSlide = useCallback(
    async (s: Slide) => {
      const same = currentView() === s.view
      setWalkNow(0)
      if (!same) {
        // hop through intermediate levels so every level change is a zoom, not a cut
        const from = chain(currentView())
        const to = chain(s.view)
        let common = 0
        while (common < from.length && common < to.length && from[common] === to[common]) common++
        const path = common > 0 ? [...from.slice(common - 1, -1).reverse(), ...to.slice(common)] : [s.view]
        for (const v of path) if (v !== currentView()) await transition(v)
      }
      await applySlideDetail(s, same)
    },
    [chain, transition, applySlideDetail],
  )

  const gotoSlide = useCallback(
    (i: number) =>
      run(async () => {
        if (i < 0 || i >= tour.length) return
        st.current = { ...st.current, slide: i }
        setSlide(i)
        setAdhoc(null)
        await showSlide(tour[i])
      }),
    [run, tour, showSlide],
  )

  // first slide's focus/step once the first layer is up
  useEffect(() => {
    let live = true
    readyOf(0).promise.then(async () => {
      await sleep(120)
      if (live && st.current.slide === first) await applySlideDetail(tour[first], true)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // external commands (bus atlas.show, tour switch)
  const lastCmd = useRef(cmd?.seq ?? 0)
  useEffect(() => {
    if (!cmd || cmd.seq === lastCmd.current) return
    lastCmd.current = cmd.seq
    const go = async () => {
      await readyOf(0).promise.catch(() => {})
      while (busy.current) await sleep(50)
      if (cmd.adhoc) {
        const s = cmd.adhoc
        await run(async () => {
          if (typeof cmd.slide === 'number') (st.current = { ...st.current, slide: cmd.slide }), setSlide(cmd.slide)
          setAdhoc(s)
          await showSlide(s)
        })
      } else if (typeof cmd.slide === 'number') await gotoSlide(cmd.slide)
    }
    void go()
  }, [cmd, run, showSlide, gotoSlide])

  // keep the tour cursor near free navigation: nearest slide showing `view`
  const syncSlide = (view: string, dir: 1 | -1 = 1) => {
    const cur = st.current.slide
    for (let d = 0; d < tour.length; d++)
      for (const i of [cur + d * dir, cur - d * dir])
        if (tour[i]?.view === view && !tour[i].step) {
          st.current = { ...st.current, slide: i }
          return setSlide(i)
        }
  }

  const drill = useCallback(
    (nodeId?: string | null) =>
      run(async () => {
        const id = nodeId ?? st.current.focused
        if (!id) return
        const n = views.get(currentView())?.nodes.find((n: any) => n.id === id)
        if (n?.navigateTo) {
          setWalkNow(0)
          setAdhoc(null)
          await transition(n.navigateTo)
          syncSlide(n.navigateTo)
        }
      }),
    [run, views, transition],
  )
  const up = useCallback(
    () =>
      run(async () => {
        const h = currentHandle()
        if ((h?.diagram.getContext() as any)?.activeWalkthrough) {
          h!.diagram.stopWalkthrough()
          setWalkNow(0)
          return
        }
        if (st.current.focused) {
          h?.diagram.send({ type: 'key.esc' } as any)
          h?.diagram.fitDiagram(400)
          setFocused(null)
          return
        }
        const p = parentOf(currentView())
        if (p) {
          setAdhoc(null)
          await transition(p)
          syncSlide(p, -1)
        } else onExit(currentView())
      }),
    [run, parentOf, transition, onExit],
  )
  const walkTo = (n: number) => {
    const h = currentHandle()
    if (!h) return
    if (n === 0) {
      h.diagram.stopWalkthrough()
      h.diagram.fitDiagram(400)
    } else if ((h.diagram.getContext() as any).activeWalkthrough) h.diagram.walkthroughStep({ step: stepId(n) })
    else h.diagram.startWalkthrough(stepId(n))
    setWalkNow(n)
  }
  const cycleFocus = (dir: 1 | -1) => {
    const nodes = views.get(currentView())?.nodes.filter((n: any) => !n.children?.length).map((n: any) => n.id) ?? []
    const id = cycle(nodes, st.current.focused, dir)
    if (!id) return
    currentHandle()?.diagram.focusNode(id)
    setFocused(id)
  }

  const shown = adhoc ?? tour[slide]
  const wholeDynamic = !shown.step && views.get(shown.view)?._type === 'dynamic' ? dynamicSteps(views.get(shown.view)).length : 0

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const a = presenterKey(e.key, e, { slide: st.current.slide, count: tour.length, steps: busy.current ? 0 : wholeDynamic, step: st.current.walk }) as any
      if (!a) return
      // capture phase on window: keeps LikeC4's own hotkeys (arrows in walkthrough, Esc) from double-firing
      e.preventDefault()
      e.stopImmediatePropagation()
      if (a.type === 'goto') gotoSlide(a.index)
      else if (a.type === 'step') walkTo(a.step)
      else if (a.type === 'drill') drill()
      else if (a.type === 'up') up()
      else if (a.type === 'focus') cycleFocus(a.dir)
      else if (a.type === 'notes') setShowNotes((v) => !v)
      else if (a.type === 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen()
        else document.documentElement.requestFullscreen?.().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  // test hook
  useEffect(() => {
    ;(window as any).__present = {
      get slide() {
        return st.current.slide
      },
      get view() {
        return currentView()
      },
      get layers() {
        return st.current.layers.length
      },
      get busy() {
        return busy.current
      },
      get walk() {
        return st.current.walk
      },
    }
    return () => {
      delete (window as any).__present
    }
  })

  const viewId = layers.find((l) => l.key === active)!.viewId
  const crumbs = chain(viewId)
  const fontVar = { '--likec4-app-font': 'var(--pl-font-sans)' } as any

  return (
    <div className="presenter" data-scheme={scheme}>
      <div className="stage" ref={stage}>
        <LikeC4ModelProvider likec4model={model}>
          {layers.map((l) => (
            <div
              key={l.key}
              className="layer"
              data-view={l.viewId}
              ref={(el) => {
                const h = handles.current.get(l.key)
                if (h) h.el = el
                else if (el) handles.current.set(l.key, { el } as any)
              }}
              style={{ opacity: l.key === active ? 1 : 0, pointerEvents: l.key === active ? 'auto' : 'none' }}
            >
              <ReactLikeC4
                viewId={l.viewId as any}
                style={{ width: '100%', height: '100%', ...fontVar }}
                colorScheme={scheme}
                injectFontCss={false}
                controls={false}
                enableSearch={false}
                showNavigationButtons={false}
                enableElementDetails={false}
                enableRelationshipBrowser={false}
                enableFocusMode
                enableDynamicViewWalkthrough
                background="transparent"
                fitViewPadding={PAD as any}
                maxZoom={12}
                minZoom={0.02}
                onNavigateTo={(_to, _ev, el) => el && drill(el.id)}
                onNodeClick={(n) => setFocused(n.id)}
                onInitialized={({ diagram, xyflow }) => {
                  const h = handles.current.get(l.key) ?? ({} as LayerHandle)
                  handles.current.set(l.key, { ...h, diagram, xyflow })
                  readyOf(l.key).resolve()
                }}
              />
            </div>
          ))}
        </LikeC4ModelProvider>
      </div>

      <nav className="p-crumbs" aria-label="Level">
        {crumbs.map((v, i) => (
          <span key={v} className={i === crumbs.length - 1 ? 'here' : ''}>
            {views.get(v)?.title ?? v}
          </span>
        ))}
        {focused && <em className="focus">· {data?.elements?.[focused]?.title ?? focused}</em>}
      </nav>
      <div className="p-top">
        {tours.length > 1 && (
          <select className="p-tour" aria-label="Tour" value={tourId} onChange={(e) => onTour(e.target.value)}>
            {tours.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
        <span className="p-counter" data-testid="counter">
          {slide + 1} / {tour.length}
        </span>
        <button className="p-exit" title="Exit presenter (Esc at the top level)" aria-label="Exit presenter" onClick={() => onExit(currentView())}>
          ×
        </button>
      </div>
      {showNotes && (
        <aside className="notes" aria-live="polite">
          <div className="notes-head">
            {tours.find((t) => t.id === tourId)?.title ?? 'Tour'} · slide {slide + 1}
            {shown.step ? ` · step ${shown.step}` : walk ? ` · step ${walk}/${wholeDynamic}` : ''}
          </div>
          {shown.note ? <div className="notes-body" dangerouslySetInnerHTML={{ __html: mdLight(shown.note) }} /> : <div className="notes-body muted">{views.get(shown.view)?.title ?? shown.view}</div>}
          <div className="keys">→ ← slides · Enter drill · Esc up · Tab focus · 1–9 jump · N notes · F fullscreen</div>
        </aside>
      )}
    </div>
  )
}
