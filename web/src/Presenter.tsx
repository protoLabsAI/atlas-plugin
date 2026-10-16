// Presenter: tours over the shared Stage (synced-camera zoom between levels). Keyboard:
// → ← slides (and the steps of a whole-dynamic-view slide) · Enter drill · Esc up/exit ·
// . , focus nodes · 1–9 jump · N notes · F fullscreen · [ ] slower/faster. Keys belong to the
// diagram surface only: on a button / link / field, Tab + Enter + Space stay native (logic.mjs keyOwner).
import type { LikeC4Model } from '@likec4/core/model'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPTION_AWAY_MS, CAPTION_FADE_MS, endBeatFor, endHoldFor, keyOwner, presenterOwns, cycle, dynamicSteps, mdLight, presenterKey, slideDwellMs, stepCaption, stepDwellMs } from './logic.mjs'
import { applyHighlight, clearHighlight } from './highlight'
import { Button, Kbd } from '@protolabsai/ui/primitives'
import { Select } from '@protolabsai/ui/forms'
import { useToast } from '@protolabsai/ui/overlays'
import { getSpeed, onSpeed, stepSpeed } from './motion'
import { Stage, type StageHandle } from './Stage'

export type Slide = { view: string; focus?: string | string[]; edges?: string[]; step?: number; via?: string; note?: string; hold_ms?: number }
export type Tour = { id: string; title: string; slides: Slide[]; auto?: boolean; end_hold_ms?: number; end_beat_ms?: number }
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
  const viewRef = useRef(view)
  viewRef.current = view
  const [slide, setSlide] = useState(first)
  const [walk, setWalk] = useState(0)
  const [showNotes, setShowNotes] = useState(true)
  const [focused, setFocused] = useState<string | null>(null)
  const [adhoc, setAdhoc] = useState<Slide | null>(null)
  const toast = useToast()
  const busy = useRef(false)
  const manual = useRef(false)
  const [done, setDone] = useState(false)
  const [captionOut, setCaptionOut] = useState(false)
  // a slide change: the outgoing caption fades out as the move starts, the incoming one fades in on
  // arrival (the breadcrumb follows the committed target view from the move's start)
  const [captionAway, setCaptionAway] = useState(false)
  const captionAwayRef = useRef(false)
  captionAwayRef.current = captionAway
  // the framing's safe area: the top chrome and the caption / notes panel, MEASURED. Every slide's
  // caption is laid out (hidden) up front, so a camera move already knows how tall the caption it
  // is arriving at will be.
  const notesRef = useRef<HTMLElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const chrome = useRef({ top: 56, bottoms: [] as number[], live: 0 })
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const r = root.getBoundingClientRect()
      let top = 0
      for (const el of root.querySelectorAll('.p-crumbs, .p-top')) {
        const b = (el as HTMLElement).getBoundingClientRect()
        if (b.height) top = Math.max(top, b.bottom - r.top)
      }
      chrome.current.top = Math.ceil(top + 8)
      const clones = measureRef.current ? [...measureRef.current.querySelectorAll('.notes')] : []
      // a slide's reserve: its caption, and every step caption it walks (the tallest — the camera
      // keeps one frame for the whole walk)
      const bottoms: number[] = []
      for (const c of clones) {
        const i = Number((c as HTMLElement).dataset.slide)
        bottoms[i] = Math.max(bottoms[i] ?? 0, Math.ceil(r.bottom - (c as HTMLElement).getBoundingClientRect().top + 12))
      }
      chrome.current.bottoms = bottoms
      const live = notesRef.current?.getBoundingClientRect()
      chrome.current.live = live?.height ? Math.ceil(r.bottom - live.top + 12) : 0
      stage.current?.reclip()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    if (notesRef.current) ro.observe(notesRef.current)
    return () => ro.disconnect()
  }, [showNotes, tour])
  const insets = useCallback(() => {
    const c = chrome.current
    const i = st.current.slide
    const bottom = !showNotes ? 0 : Math.max(c.bottoms[i] ?? 0, adhocRef.current ? c.live : 0) || c.live
    // the clip keeps clear of the caption ON SCREEN too (mid-move it is still the previous one)
    // (measured now: the caption element is swapped per slide, an observer can miss it)
    const r = rootRef.current?.getBoundingClientRect()
    const live = notesRef.current?.isConnected ? notesRef.current.getBoundingClientRect() : null
    const liveBottom = r && live?.height ? Math.ceil(r.bottom - live.top + 12) : 0
    // (once the outgoing caption has faded away, only the arriving slide's reserve matters)
    return { top: c.top, bottom, clipBottom: captionAwayRef.current ? bottom : Math.max(bottom, showNotes ? liveBottom : 0) }
  }, [showNotes])
  const adhocRef = useRef(false)
  const adhocNow = useRef<Slide | null>(null)
  adhocNow.current = adhoc
  // the elements a slide's caption names (by title or id) — what a slide too big to show legibly
  // whole narrows to (framing.mjs); never a density guess
  const named = useCallback(
    (viewId: string) => {
      const s = (adhocRef.current ? adhocNow.current : null) ?? tour[st.current.slide]
      if (!s || s.view !== viewId || !s.note) return null
      const text = s.note.replace(/[*_`]/g, '').toLowerCase()
      const esc = (w: string) => w.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')
      const words = (w: string) => new RegExp('(^|[^a-z0-9])' + esc(w) + '($|[^a-z0-9])').test(text)
      const nodes = (data?.views?.[viewId]?.nodes ?? []) as any[]
      const hit = nodes.filter((n) => {
        const title = String(n.title ?? '').toLowerCase().trim()
        const tail = String(n.id).split('.').pop()!.replace(/_/g, ' ').toLowerCase()
        return (title.length > 2 && words(title)) || (tail.length > 2 && words(tail))
      })
      return hit.length ? hit.map((n) => String(n.id)) : null
    },
    [tour, data],
  )
  const [cropped, setCropped] = useState(false)
  const [noteSlide, setNoteSlide] = useState(first)
  const [noteStep, setNoteStep] = useState(0) // the walked step whose caption is up (0 = the slide's)
  /** the captions a whole-dynamic-view slide walks through, one per step */
  const walkedCaptions = (t: Slide | null | undefined): string[] => {
    const v = t && !t.step ? data?.views?.[t.view] : null
    return v?._type === 'dynamic' ? dynamicSteps(v).map((e: any) => stepCaption(v, e)) : []
  }
  /** resolves once the camera (a focus ease, a walkthrough step) has landed */
  const settleCamera = async () => {
    await sleep(80)
    for (let i = 0; i < 100 && stage.current?.moving(); i++) await sleep(40)
  }
  // the caption on screen changed: the diagram's clip follows at once (not at the next rest)
  useEffect(() => {
    const id = requestAnimationFrame(() => stage.current?.reclip())
    // … and again once a fade-out has finished (the band may then grow)
    const t = window.setTimeout(() => stage.current?.reclip(), CAPTION_AWAY_MS + 20)
    return () => {
      cancelAnimationFrame(id)
      window.clearTimeout(t)
    }
  }, [noteSlide, captionOut, captionAway, showNotes, adhoc])
  const st = useRef({ slide, focused, walk })
  st.current = { slide, focused, walk }

  const S = () => stage.current!
  const currentView = () => stage.current?.current() ?? view
  const setWalkNow = (n: number) => {
    st.current = { ...st.current, walk: n }
    setWalk(n)
    if (n === 0) setNoteStep(0)
  }
  const goView = async (v: string) => {
    await S().go(v)
    setView(S().current())
    setFocused(null)
  }

  const lastAim = useRef<string[] | null>(null)
  const aim = (x: string[] | null) => {
    lastAim.current = x
    stage.current?.aim(x)
  }
  /** a walkthrough step's subject: its two ends */
  const stepEnds = (viewId: string, n: number) => {
    const e = (data?.views?.[viewId]?.edges ?? []).find((x: any) => String(x.id).startsWith(stepId(n)))
    return e ? [e.source, e.target] : null
  }
  const applySlideDetail = useCallback(async (s: Slide, sameView: boolean) => {
    const d = stage.current?.diagram()
    if (!d) return
    const ctx = d.getContext() as any
    if (s.step) {
      aim(stepEnds(s.view, s.step))
      if (ctx.activeWalkthrough && sameView) d.walkthroughStep({ step: stepId(s.step) })
      else d.startWalkthrough(stepId(s.step))
      setFocused(null)
      return
    }
    if (ctx.activeWalkthrough) d.stopWalkthrough()
    clearHighlight(d)
    const many = Array.isArray(s.focus) ? s.focus : s.focus ? [s.focus] : []
    // a single focus is shown with its direct neighbours (its context), when they fit legibly
    const view = data?.views?.[s.view]
    const ctxIds = many.length === 1 ? [many[0], ...(view?.edges ?? []).flatMap((e: any) => (e.source === many[0] ? [e.target] : e.target === many[0] ? [e.source] : []))] : many
    aim(ctxIds.length ? [...new Set(ctxIds)] : null)
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

  // a slide asked for mid-transition (End, a quick →) isn't dropped: the latest one runs next
  const pendingGoto = useRef<number | null>(null)
  const gotoRef = useRef<(i: number) => Promise<void>>(async () => {})
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
    const next = pendingGoto.current
    pendingGoto.current = null
    if (next != null) await gotoRef.current(next)
  }, [])

  const showSlide = useCallback(
    async (s: Slide) => {
      const same = currentView() === s.view
      setWalkNow(0)
      if (!same) await goView(s.view)
      await applySlideDetail(s, same)
      // the slide has ARRIVED when its camera (a focus ease, a walkthrough step) has landed — the
      // caption fades in then, and a recording's dwell starts then
      await settleCamera()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applySlideDetail],
  )

  const gotoSlide = useCallback(
    async (i: number) => {
      if (busy.current) {
        pendingGoto.current = i
        return
      }
      await run(async () => {
        if (i < 0 || i >= tour.length) return
        st.current = { ...st.current, slide: i }
        setSlide(i)
        adhocRef.current = false
        setAdhoc(null)
        setCaptionAway(true)
        try {
          await showSlide(tour[i])
        } finally {
          if (st.current.slide === i) {
            setNoteSlide(i) // the caption changes when the camera arrives
            setNoteStep(0)
          }
          setCaptionAway(false)
        }
      })
    },
    [run, tour, showSlide],
  )
  gotoRef.current = gotoSlide

  // first slide's focus/step once the first layer is up
  useEffect(() => {
    let live = true
    stage.current?.ready().then(async () => {
      await sleep(120)
      if (live && st.current.slide === first) await applySlideDetail(tour[first], true)
      if (live) setCropped(!!stage.current?.cropped())
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
          adhocRef.current = true
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
          setNoteStep(0)
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
          adhocRef.current = false
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
          adhocRef.current = false
          setAdhoc(null)
          await goView(p)
          syncSlide(p, -1)
        } else onExit(currentView())
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, onExit],
  )
  // walking a whole dynamic view: each step is captioned from its notes (else `From → To: label`);
  // the outgoing caption fades as the camera starts, the step's fades in when it lands
  const walkToken = useRef(0)
  const walkTo = async (n: number) => {
    const d = stage.current?.diagram()
    if (!d) return
    const token = ++walkToken.current
    aim(n ? stepEnds(currentView(), n) : null)
    setCaptionAway(true)
    if (n === 0) {
      d.stopWalkthrough()
      stage.current?.frame(450)
    } else if ((d.getContext() as any).activeWalkthrough) d.walkthroughStep({ step: stepId(n) })
    else d.startWalkthrough(stepId(n))
    setWalkNow(n)
    await settleCamera()
    if (token !== walkToken.current) return // a newer step took over
    setNoteStep(n)
    setCaptionAway(false)
  }
  const cycleFocus = (dir: 1 | -1) => {
    const nodes = (data?.views?.[currentView()]?.nodes ?? []).filter((n: any) => !n.children?.length).map((n: any) => n.id)
    const id = cycle(nodes, st.current.focused, dir)
    if (!id) return
    stage.current?.diagram()?.focusNode(id)
    setFocused(id)
  }
  // speed feedback through the DS toast — never in record mode (nothing but the diagram on camera)
  useEffect(() => onSpeed((s) => !record && void toast({ message: `Transitions: ${s}`, tone: 'info', duration: 1600 })) as any, [record, toast])

  const shown = adhoc ?? tour[slide]
  const slideCaptioned = adhoc ?? tour[noteSlide] ?? shown // notes follow the camera, not the keypress
  // a walked step's caption replaces the slide's (whole-dynamic-view slides only)
  const walkedNote = !adhoc && noteStep && !slideCaptioned.step ? walkedCaptions(slideCaptioned)[noteStep - 1] : null
  const captioned = walkedNote ? { ...slideCaptioned, note: walkedNote } : slideCaptioned
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
      let lastDwell = 0 // how long the last caption has been up when the end hold starts
      for (let i = first; i < tour.length; i++) {
        if (!live || manual.current) return
        await idle()
        if (i !== st.current.slide) await gotoSlide(i)
        await idle()
        lastDwell = slideDwellMs(tour[i])
        await dwell(slideDwellMs(tour[i]))
        const v = data?.views?.[tour[i].view]
        if (v?._type === 'dynamic' && !tour[i].step) {
          for (const [n, e] of dynamicSteps(v).entries()) {
            if (!live || manual.current) return
            await walkTo(n + 1) // resolves when the step has landed and its caption is up
            const ms = stepDwellMs(stepCaption(v, e))
            lastDwell = ms // the last caption on screen is the last step's
            await dwell(ms)
          }
        }
      }
      if (!live || manual.current) return
      // the end: the last caption stays a little longer, fades, then a clean beat → tour-done
      const t = tours.find((x) => x.id === tourId) as any
      await dwell(endHoldFor(t, lastDwell))
      if (!live || manual.current) return
      if (record) setCaptionOut(true)
      await dwell(CAPTION_FADE_MS + endBeatFor(t))
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
      const owner = keyOwner(
        e.composedPath().map((n: any) =>
          n instanceof Element
            ? { tag: n.tagName, role: n.getAttribute('role'), editable: (n as HTMLElement).isContentEditable, chrome: n.hasAttribute('data-presenter-chrome') }
            : null,
        ),
      )
      if (!presenterOwns(e.key, owner)) return
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
      get aim() {
        return lastAim.current
      },
      /** the view the breadcrumb shows / the view the current slide is going to */
      /** the current slide's focus (one id, a list, or null) */
      get focus() {
        const f = (adhocRef.current ? adhocNow.current : tour[st.current.slide])?.focus
        return f ?? null
      },
      get subject() {
        return stage.current?.subject() ?? null
      },
      get crumb() {
        return viewRef.current
      },
      get target() {
        return (adhocRef.current ? adhocNow.current : tour[st.current.slide])?.view ?? null
      },
      get insets() {
        return insets()
      },
    }
    return () => {
      delete (window as any).__present
    }
  })

  const crumbs = stage.current ? stage.current.chain(view) : [view]
  return (
    <div ref={rootRef} className={`presenter${record ? ' presenter--record' : ''}`} data-scheme={scheme} data-atlas-slide={slide + 1} data-atlas-done={done ? '' : undefined}>
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
        insets={insets}
        named={named}
        onNavigateTo={(_to, el) => el && drill(el.id)}
        onNodeClick={(n) => setFocused(n.id)}
        onCommit={(v) => setView(v)}
        onSettled={(v) => {
          setView(v)
          setCropped(!!stage.current?.cropped())
        }}
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
      <div className="p-top" data-presenter-chrome>
        {tours.length > 1 && (
          <span className="p-tour">
          <Select aria-label="Tour" value={tourId} onChange={(e) => onTour(e.target.value)}>
            {tours.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
          </span>
        )}
        {cropped && (
          <Button size="sm" title="This view is framed on its densest part so the text stays readable — show all of it" onClick={() => stage.current?.fitAll(450)}>
            Fit all
          </Button>
        )}
        <span className="p-counter" data-testid="counter">
          {slide + 1} / {tour.length}
        </span>
        <Button size="sm" icon title="Exit presenter (Esc at the top level)" aria-label="Exit presenter" onClick={() => onExit(currentView())}>
          ×
        </Button>
      </div>
      )}
      {showNotes && (
        <>
        <div ref={measureRef} className="notes-measure" aria-hidden>
          {tour.flatMap((t, i) =>
            [t.note ?? '', ...walkedCaptions(t)].map((note, j) => (
              <aside key={`${i}.${j}`} className="notes" data-slide={i}>
                {!record && <div className="notes-head">.</div>}
                {note ? <div className="notes-body" dangerouslySetInnerHTML={{ __html: mdLight(note, { codeRefs: true }) }} /> : <div className="notes-body">.</div>}
                {!record && <div className="keys">.</div>}
              </aside>
            )),
          )}
        </div>
        <aside ref={notesRef as any} data-presenter-chrome className={`notes${captionOut || captionAway ? ' notes--out' : ''}`} aria-live="polite" style={{ ['--caption-fade' as any]: `${captionAway && !captionOut ? CAPTION_AWAY_MS : CAPTION_FADE_MS}ms` }}>
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
          {!record && (
            <div className="keys">
              <Kbd>→</Kbd> <Kbd>←</Kbd> slides · <Kbd>Enter</Kbd> drill · <Kbd>Esc</Kbd> up · <Kbd>.</Kbd> <Kbd>,</Kbd> focus · <Kbd>1–9</Kbd> jump · <Kbd>N</Kbd> notes · <Kbd>F</Kbd> fullscreen ·{' '}
              <Kbd>[</Kbd> <Kbd>]</Kbd> speed
            </div>
          )}
        </aside>
        </>
      )}
    </div>
  )
}
