// Presenter: tours over the shared Stage (synced-camera zoom between levels). Keyboard:
// → ← slides (and the steps of a whole-dynamic-view slide) · Enter drill · Esc up/exit ·
// Tab focus · 1–9 jump · N notes · F fullscreen · [ ] slower/faster.
import type { LikeC4Model } from '@likec4/core/model'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BEAT_MS, CAPTION_FADE_MS, END_HOLD_MS, cycle, dynamicSteps, mdLight, presenterKey, slideDwellMs, stepDwellMs } from './logic.mjs'
import { applyHighlight, clearHighlight } from './highlight'
import { getSpeed, onSpeed, stepSpeed } from './motion'
import { Stage, type StageHandle } from './Stage'

export type Slide = { view: string; focus?: string | string[]; edges?: string[]; step?: number; via?: string; note?: string; hold_ms?: number }
export type Tour = { id: string; title: string; slides: Slide[]; auto?: boolean; end_hold_ms?: number }
export type PresenterCmd = { seq: number; slide?: number; adhoc?: Slide }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const stepId = (n: number) => `step-${String(n).padStart(2, '0')}` as any
const PAD = 56

const LAYER_PROPS = {
  controls: false,
  enableSearch: false,
  showNavigationButtons: false,
  enableElementDetails: false,
  enableRelationshipBrowser: false,
  enableFocusMode: true,
  enableDynamicViewWalkthrough: true,
  maxZoom: 12,
  minZoom: 0.02,
}

type Props = {
  model: LikeC4Model<any>
  data: any
  tours: Tour[]
  tourId: string
  start: number
  cmd: PresenterCmd | null
  scheme: 'light' | 'dark'
  themeCss: string
  onTour: (id: string) => void
  onExit: (view: string) => void
  onNoteClick?: (e: React.MouseEvent | React.KeyboardEvent) => void
  /** what's on screen (for atlas.viewing / Ask) */
  onState?: (s: { view: string; slide: number; step: number | null }) => void
  /** play the tour by itself (dwell per slide from hold_ms / the note), then onDone */
  autoplay?: boolean
  /** recording: caption-style notes, no chrome, no hover states */
  record?: boolean
  onDone?: () => void
}

export function Presenter({ model, data, tours, tourId, start, cmd, scheme, themeCss, onTour, onExit, onNoteClick, onState, autoplay, record, onDone }: Props) {
  const tour = (tours.find((t) => t.id === tourId) ?? tours[0]).slides
  const first = Math.min(Math.max(start, 0), tour.length - 1)
  const stage = useRef<StageHandle>(null)
  const [view, setView] = useState(tour[first].view)
  const [slide, setSlide] = useState(first)
  const [walk, setWalk] = useState(0)
  const [showNotes, setShowNotes] = useState(true)
  const [focused, setFocused] = useState<string | null>(null)
  const [adhoc, setAdhoc] = useState<Slide | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const busy = useRef(false)
  const manual = useRef(false)
  const [done, setDone] = useState(false)
  const [captionOut, setCaptionOut] = useState(false)
  const [noteSlide, setNoteSlide] = useState(first)
  const st = useRef({ slide, focused, walk })
  st.current = { slide, focused, walk }

  const S = () => stage.current!
  const currentView = () => stage.current?.current() ?? view
  const setWalkNow = (n: number) => {
    st.current = { ...st.current, walk: n }
    setWalk(n)
  }
  const goView = async (v: string) => {
    await S().go(v)
    setView(S().current())
    setFocused(null)
  }

  const applySlideDetail = useCallback(async (s: Slide, sameView: boolean) => {
    const d = stage.current?.diagram()
    if (!d) return
    const ctx = d.getContext() as any
    if (s.step) {
      if (ctx.activeWalkthrough && sameView) d.walkthroughStep({ step: stepId(s.step) })
      else d.startWalkthrough(stepId(s.step))
      setFocused(null)
      return
    }
    if (ctx.activeWalkthrough) d.stopWalkthrough()
    clearHighlight(d)
    const many = Array.isArray(s.focus) ? s.focus : s.focus ? [s.focus] : []
    if (many.length > 1 || s.edges?.length) {
      applyHighlight(d, stage.current?.xyflow(), data?.views?.[s.view], { view: s.view, focus: many, edges: s.edges ?? [] })
      setFocused(null)
    } else if (many.length === 1) {
      d.focusNode(many[0] as any)
      setFocused(many[0])
    } else if (sameView) {
      d.send({ type: 'key.esc' } as any)
      stage.current?.frame(450)
      setFocused(null)
    }
  }, [data])

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
      if (!same) await goView(s.view)
      await applySlideDetail(s, same)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applySlideDetail],
  )

  const gotoSlide = useCallback(
    (i: number) =>
      run(async () => {
        if (i < 0 || i >= tour.length) return
        st.current = { ...st.current, slide: i }
        setSlide(i)
        setAdhoc(null)
        await showSlide(tour[i])
        if (st.current.slide === i) setNoteSlide(i) // the caption changes when the camera arrives
      }),
    [run, tour, showSlide],
  )

  // first slide's focus/step once the first layer is up
  useEffect(() => {
    let live = true
    stage.current?.ready().then(async () => {
      await sleep(120)
      if (live && st.current.slide === first) await applySlideDetail(tour[first], true)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // external commands (bus atlas.show)
  const lastCmd = useRef(cmd?.seq ?? 0)
  useEffect(() => {
    if (!cmd || cmd.seq === lastCmd.current) return
    lastCmd.current = cmd.seq
    const go = async () => {
      await stage.current?.ready()
      while (busy.current) await sleep(50)
      if (cmd.adhoc) {
        const s = cmd.adhoc
        await run(async () => {
          if (typeof cmd.slide === 'number') ((st.current = { ...st.current, slide: cmd.slide }), setSlide(cmd.slide))
          setAdhoc(s)
          await showSlide(s)
        })
      } else if (typeof cmd.slide === 'number') await gotoSlide(cmd.slide)
    }
    void go()
  }, [cmd, run, showSlide, gotoSlide])

  // keep the tour cursor near free navigation: nearest slide showing `v`
  const syncSlide = (v: string, dir: 1 | -1 = 1) => {
    const cur = st.current.slide
    for (let d = 0; d < tour.length; d++)
      for (const i of [cur + d * dir, cur - d * dir])
        if (tour[i]?.view === v && !tour[i].step) {
          st.current = { ...st.current, slide: i }
          setNoteSlide(i)
          return setSlide(i)
        }
  }

  const nodeOf = (id: string) => data?.views?.[currentView()]?.nodes?.find((n: any) => n.id === id)

  const drill = useCallback(
    (nodeId?: string | null) =>
      run(async () => {
        const id = nodeId ?? st.current.focused
        if (!id) return
        const n = nodeOf(id)
        if (n?.navigateTo) {
          setWalkNow(0)
          setAdhoc(null)
          await goView(n.navigateTo)
          syncSlide(n.navigateTo)
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, data],
  )
  const up = useCallback(
    () =>
      run(async () => {
        const d = stage.current?.diagram()
        if ((d?.getContext() as any)?.activeWalkthrough) {
          d!.stopWalkthrough()
          stage.current?.frame(450)
          setWalkNow(0)
          return
        }
        if (st.current.focused) {
          d?.send({ type: 'key.esc' } as any)
          stage.current?.frame(450)
          setFocused(null)
          return
        }
        const p = S().parentOf(currentView())
        if (p) {
          setAdhoc(null)
          await goView(p)
          syncSlide(p, -1)
        } else onExit(currentView())
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, onExit],
  )
  const walkTo = (n: number) => {
    const d = stage.current?.diagram()
    if (!d) return
    if (n === 0) {
      d.stopWalkthrough()
      stage.current?.frame(450)
    } else if ((d.getContext() as any).activeWalkthrough) d.walkthroughStep({ step: stepId(n) })
    else d.startWalkthrough(stepId(n))
    setWalkNow(n)
  }
  const cycleFocus = (dir: 1 | -1) => {
    const nodes = (data?.views?.[currentView()]?.nodes ?? []).filter((n: any) => !n.children?.length).map((n: any) => n.id)
    const id = cycle(nodes, st.current.focused, dir)
    if (!id) return
    stage.current?.diagram()?.focusNode(id)
    setFocused(id)
  }
  const flash = (t: string) => {
    setToast(t)
    window.setTimeout(() => setToast((x) => (x === t ? null : x)), 1600)
  }
  useEffect(() => onSpeed((s) => flash(`Transitions: ${s}`)) as any, [])

  const shown = adhoc ?? tour[slide]
  const captioned = adhoc ?? tour[noteSlide] ?? shown // notes follow the camera, not the keypress
  const shownView = data?.views?.[shown.view]
  const wholeDynamic = !shown.step && shownView?._type === 'dynamic' ? dynamicSteps(shownView).length : 0

  // ------------------------------------------------------------ autoplay (record mode)
  useEffect(() => {
    if (!autoplay) return
    let live = true
    const idle = async () => {
      while (live && (busy.current || stage.current?.busy())) await sleep(50)
    }
    const dwell = async (ms: number) => {
      const t0 = performance.now()
      while (live && !manual.current && performance.now() - t0 < ms) await sleep(50)
    }
    const play = async () => {
      try {
        await (document as any).fonts?.ready
      } catch {
        /* no font loading API */
      }
      await stage.current?.ready()
      await sleep(600)
      for (let i = first; i < tour.length; i++) {
        if (!live || manual.current) return
        await idle()
        if (i !== st.current.slide) await gotoSlide(i)
        await idle()
        await dwell(slideDwellMs(tour[i]))
        const v = data?.views?.[tour[i].view]
        if (v?._type === 'dynamic' && !tour[i].step) {
          for (const [n, e] of dynamicSteps(v).entries()) {
            if (!live || manual.current) return
            walkTo(n + 1)
            await dwell(stepDwellMs(e.label))
          }
        }
      }
      if (!live || manual.current) return
      // the end: the last caption stays a little longer, fades, then a clean beat → tour-done
      const t = tours.find((x) => x.id === tourId) as any
      await dwell(Number.isInteger(t?.end_hold_ms) ? t.end_hold_ms : END_HOLD_MS)
      if (!live || manual.current) return
      if (record) setCaptionOut(true)
      await dwell(CAPTION_FADE_MS + BEAT_MS)
      if (live && !manual.current) {
        setDone(true)
        onDone?.()
      }
    }
    void play()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay])

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        stepSpeed(e.key === ']' ? 1 : -1)
        return
      }
      const a = presenterKey(e.key, e, { slide: st.current.slide, count: tour.length, steps: busy.current ? 0 : wholeDynamic, step: st.current.walk }) as any
      if (!a) return
      if (!record) manual.current = true // the presenter took over: autoplay yields
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

  const shownStep = (adhoc ?? tour[slide])?.step ?? (walk || null)
  useEffect(() => {
    onState?.({ view, slide, step: shownStep })
  }, [view, slide, shownStep, onState])

  // test hook
  useEffect(() => {
    ;(window as any).__present = {
      get slide() {
        return st.current.slide
      },
      get view() {
        return currentView()
      },
      get busy() {
        return busy.current || !!stage.current?.busy()
      },
      get walk() {
        return st.current.walk
      },
      get speed() {
        return getSpeed()
      },
    }
    return () => {
      delete (window as any).__present
    }
  })

  const crumbs = stage.current ? stage.current.chain(view) : [view]
  return (
    <div className={`presenter${record ? ' presenter--record' : ''}`} data-scheme={scheme} data-atlas-slide={slide + 1} data-atlas-done={done ? '' : undefined}>
      <Stage
        ref={stage}
        model={model}
        data={data}
        initialView={tour[first].view}
        scheme={scheme}
        themeCss={themeCss}
        tour={tour}
        pad={PAD}
        layerProps={LAYER_PROPS}
        legible
        reserveBottom={showNotes ? (record ? 0.24 : 150) : 0}
        onNavigateTo={(_to, el) => el && drill(el.id)}
        onNodeClick={(n) => setFocused(n.id)}
        onSettled={(v) => setView(v)}
      />
      <nav className="p-crumbs" aria-label="Level">
        {crumbs.map((v, i) => (
          <span key={v} className={i === crumbs.length - 1 ? 'here' : ''}>
            {data?.views?.[v]?.title || v}
          </span>
        ))}
        {focused && <em className="focus">· {data?.elements?.[focused]?.title ?? focused}</em>}
      </nav>
      {!record && (
      <div className="p-top">
        {tours.length > 1 && (
          <select className="p-tour pl-select" aria-label="Tour" value={tourId} onChange={(e) => onTour(e.target.value)}>
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
        <button className="pl-btn pl-btn--sm pl-btn--icon p-exit" title="Exit presenter (Esc at the top level)" aria-label="Exit presenter" onClick={() => onExit(currentView())}>
          ×
        </button>
      </div>
      )}
      {showNotes && (
        <aside className={`notes${captionOut ? ' notes--out' : ''}`} aria-live="polite" style={{ ['--caption-fade' as any]: `${CAPTION_FADE_MS}ms` }}>
          {!record && (
          <div className="notes-head">
            {tours.find((t) => t.id === tourId)?.title ?? 'Tour'} · slide {slide + 1}
            {shown.step ? ` · step ${shown.step}` : walk ? ` · step ${walk}/${wholeDynamic}` : ''}
          </div>
          )}
          {captioned.note ? (
            <div className="notes-body" onClick={onNoteClick} onKeyDown={onNoteClick} dangerouslySetInnerHTML={{ __html: mdLight(captioned.note, { codeRefs: true }) }} />
          ) : (
            <div className="notes-body muted">{data?.views?.[captioned.view]?.title ?? captioned.view}</div>
          )}
          {!record && <div className="keys">→ ← slides · Enter drill · Esc up · Tab focus · 1–9 jump · N notes · F fullscreen · [ ] speed</div>}
        </aside>
      )}
      {toast && !record && <div className="toast p-toast">{toast}</div>}
    </div>
  )
}
