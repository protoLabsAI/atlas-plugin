// Atlas viewer shell: data (model polling with ETag), theme, bus, and the explore/present modes.
import { LikeC4Model } from '@likec4/core/model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Details } from './Details'
import { Explorer, type ExploreCmd } from './Explorer'
import { Presenter, type PresenterCmd, type Tour } from './Presenter'
import { BASE, currentScheme, embedded, fromParent, post, subscribeBus, type Kit } from './host'
import type { Highlight } from './highlight'
import { Button, Empty } from '@protolabsai/ui/primitives'
import { Input, Select } from '@protolabsai/ui/forms'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@protolabsai/ui/menu'
import { useToast } from '@protolabsai/ui/overlays'
import { setSpeed } from './motion'
import { themeFor } from './theme'
import {
  askPrompt, alreadyApplied, replayAction, keyOwner, CLEAR_TOPIC, codeOpenMessage, exploreShowPlan, parseDeepLink, SHOW_TOPIC, codeRoute, hostSupportsCompose, viewingPayload, displayFile, dynamicSteps, errorFileRel, keepView, keyCombo, nodeMenuItems, normaliseLinks,
  parseShow, resolveProject, scopedViewOf, searchModel, shouldForwardKey, slideForView, toursFor, viewChain, viewForElement, viewOptions,
} from './logic.mjs'

const POLL_MS = 2000
type Resp = { ok: boolean; errors: any[]; model: any; tours: any; hash: string; model_dir?: string; project_root?: string; project?: string; exists?: boolean; stale?: boolean }
type Status = { node?: { ok?: boolean; path?: string; version?: string; source?: string; error?: string }; exists?: boolean; model_dir?: string; engine_present?: boolean; project?: string; project_root?: string }

// ---------------------------------------------------------------- theme
function useScheme(kit: Kit) {
  const [state, setState] = useState<{ scheme: 'light' | 'dark'; css: string }>(() => {
    const scheme = currentScheme()
    return { scheme, css: themeFor(scheme) }
  })
  useEffect(() => {
    let mode: string | null = null // the console's `mode` (newer hosts send it with the theme)
    const apply = () => {
      const s = mode === 'light' || mode === 'dark' ? mode : currentScheme()
      const root = document.documentElement
      if (root.style.colorScheme !== s) root.style.colorScheme = s // form controls + scrollbars
      if (root.dataset.scheme !== s) root.dataset.scheme = s
      const css = themeFor(s)
      setState((prev) => (prev.scheme === s && prev.css === css ? prev : { scheme: s, css }))
    }
    apply()
    // the kit re-sets --pl-* on :root (inline style) on init + every live re-theme
    const mo = new MutationObserver(apply)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    kit.initPluginView((x: any) => {
      if (x?.theme && typeof x.theme.mode === 'string') mode = x.theme.mode
      apply()
    })
    // the kit stylesheet loads async: re-read once it lands
    const link = document.querySelector('link[href$="/_ds/plugin-kit.css"]')
    link?.addEventListener('load', apply)
    const mq = window.matchMedia?.('(prefers-color-scheme: light)')
    mq?.addEventListener?.('change', apply)
    return () => {
      mo.disconnect()
      link?.removeEventListener('load', apply)
      mq?.removeEventListener?.('change', apply)
    }
  }, [kit])
  return state
}

// ---------------------------------------------------------------- model polling
function useAtlasData(kit: Kit) {
  const [resp, setResp] = useState<Resp | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [net, setNet] = useState<string | null>(null)
  const [model, setModel] = useState<{ m: LikeC4Model<any>; data: any; key: string } | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const etag = useRef<string | null>(null)
  const inflight = useRef(false)
  const modelKey = useRef<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const r = await kit.apiFetch('/api/plugins/atlas/status', { cache: 'no-store' })
      if (r.ok) {
        const st = await r.json()
        setStatus(st)
        setSpeed(st?.transition_speed)
      }
    } catch {
      /* older backend: no status route */
    }
  }, [kit])

  const poll = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      const headers: Record<string, string> = {}
      if (etag.current) headers['If-None-Match'] = etag.current
      const r = await kit.apiFetch('/api/plugins/atlas/model', { headers, cache: 'no-store' })
      if (r.status === 304) {
        setNet(null)
        return
      }
      if (!r.ok) {
        setNet(r.status === 401 || r.status === 403 ? `Not authorised (HTTP ${r.status}) — open Atlas from the console.` : `Model request failed: HTTP ${r.status}`)
        return
      }
      const body: Resp = await r.json()
      etag.current = r.headers.get('ETag') ?? (body.hash ? `"${body.hash}"` : null)
      setNet(null)
      setResp(body)
      if (!body.model) {
        void loadStatus()
        return
      }
      // a stale payload re-serves the last good model we already render → keep it
      const key = body.stale && modelKey.current ? modelKey.current : String(body.hash ?? Date.now())
      if (key === modelKey.current) return
      try {
        const m = LikeC4Model.create(body.model)
        modelKey.current = key
        setModel({ m, data: body.model, key })
        setModelError(null)
      } catch (e) {
        console.error('[atlas] model', e)
        setModelError(String((e as Error)?.message ?? e))
      }
    } catch (e) {
      setNet(`Can't reach Atlas: ${String((e as Error)?.message ?? e)}`)
    } finally {
      inflight.current = false
    }
  }, [kit, loadStatus])

  useEffect(() => {
    void loadStatus()
    void poll()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void poll()
    }, POLL_MS)
    const onVis = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVis)
    // the handshake can land after the first try (bearer) → retry right away
    kit.initPluginView(() => {
      if (!modelKey.current) {
        etag.current = null
        void poll()
      }
    })
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [kit, poll, loadStatus])

  return { resp, status, net, model, modelError, refresh: poll }
}

// ---------------------------------------------------------------- app
type Mode = { kind: 'explore' } | { kind: 'present'; tour: string; start: number; nonce: number; autoplay?: boolean; record?: boolean; done?: boolean }

export function App({ kit }: { kit: Kit }) {
  const { scheme, css: themeCss } = useScheme(kit)
  const { resp, status, net, model, modelError } = useAtlasData(kit)
  const data = model?.data
  const tours: Tour[] = useMemo(() => (data ? toursFor(resp?.tours, data) : []), [data, resp?.tours])

  const [viewId, setViewIdRaw] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'explore' })
  const [ecmd, setEcmd] = useState<ExploreCmd | null>(null)
  const [pcmd, setPcmd] = useState<PresenterCmd | null>(null)
  const [walk, setWalk] = useState<number | null>(null)
  const [highlight, setHighlight] = useState<Highlight | null>(null)
  // the agent's narration, shown in a bar UNDER the diagram (never over it) until replaced or cleared
  const [caption, setCaption] = useState<{ text: string; seq: number } | null>(null)
  const captionSeq = useRef(0)
  const [presenting, setPresenting] = useState<{ view: string; slide: number; step: number | null } | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [errorsOpen, setErrorsOpen] = useState(false)
  const seq = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)

  // keep the current view across reloads when it still exists
  useEffect(() => {
    if (!data) return
    setViewIdRaw((v) => keepView(data, v))
    setSelected((s) => (s && data.elements?.[s] ? s : null))
  }, [data])

  const setViewId = useCallback((v: string) => {
    setViewIdRaw(v)
    setWalk(null)
  }, [])

  const command = useCallback((c: Omit<ExploreCmd, 'seq'>) => setEcmd({ ...c, seq: ++seq.current }), [])

  const openView = useCallback(
    (v: string, focus?: string) => {
      setViewId(v)
      if (focus) command({ view: v, focus })
    },
    [setViewId, command],
  )

  const toast = useToast()
  const showToast = useCallback((t: string) => void toast({ message: t, tone: 'info', duration: 3500 }), [toast])

  // ---- code links → core's code pane (click) or the operator's editor (⌘/Ctrl-click)
  // Pane availability: GET /api/runtime/status → code_pane.enabled (null = unknown/older host).
  const [paneOn, setPaneOn] = useState<boolean | null>(null)
  // "Ask about this" → protoagent:chat:compose (core ≥ 0.206.0; unknown version → shown)
  const [canCompose, setCanCompose] = useState(false) // hidden until /status proves the host can
  useEffect(() => {
    const check = async () => {
      try {
        const r = await kit.apiFetch('/api/runtime/status', { cache: 'no-store' })
        if (!r.ok) return setCanCompose(false)
        const st = await r.json()
        const v = st?.code_pane?.enabled
        setPaneOn(typeof v === 'boolean' ? v : null)
        setCanCompose(embedded && hostSupportsCompose(st?.version))
      } catch {
        setCanCompose(false) // older host / no status: keep the pane unknown, compose hidden
      }
    }
    void check()
    kit.initPluginView(() => void check())
    const onVis = () => document.visibilityState === 'visible' && void check()
    window.addEventListener('focus', onVis)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('focus', onVis)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [kit])

  const rootsRef = useRef<Record<string, string> | null | undefined>(undefined)
  const openCode = useCallback(
    async (link: any, note: string, mods?: { metaKey?: boolean; ctrlKey?: boolean } | 'pane' | 'editor') => {
      let roots = rootsRef.current
      if (!resp?.project && roots === undefined) {
        try {
          const r = await kit.apiFetch('/api/fs/roots')
          roots = r.ok ? ((await r.json())?.roots ?? null) : null
        } catch {
          roots = null
        }
        rootsRef.current = roots
      }
      const how = mods === 'pane' || mods === 'editor' ? (mods === 'pane' && paneOn === false ? 'editor' : mods) : codeRoute(mods, paneOn)
      const target = resolveProject(resp, roots, link.path)
      const msg = codeOpenMessage(target, link, note, how)
      const label = target ? `${target.project}/${target.path}${link.line ? `:${link.line}` : ''}` : link.path
      if (msg && post(msg)) return
      try {
        await navigator.clipboard.writeText(label)
        showToast(`Copied ${label}`)
      } catch {
        showToast(label)
      }
    },
    [kit, resp, paneOn, showToast],
  )
  /** Click on a `code` file reference rendered by mdLight({codeRefs}) (descriptions, notes). */
  const onCodeRefClick = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      const el = (e.target as HTMLElement).closest?.('.coderef') as HTMLElement | null
      if (!el) return
      if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      const line = Number(el.dataset.line) || undefined
      const end = Number(el.dataset.endLine) || undefined
      void openCode({ kind: 'code', path: el.dataset.path, line, endLine: end, title: el.dataset.path }, '', e as any)
    },
    [openCode],
  )

  // ---- presenter
  const present = useCallback(
    (tourId?: string, start?: number, opts: { autoplay?: boolean; record?: boolean } = {}) => {
      if (!tours.length) return
      const t = tours.find((x) => x.id === tourId) ?? tours[0]
      const s = typeof start === 'number' ? start : opts.autoplay ? 0 : slideForView(t.slides, viewId ?? 'index')
      setSelected(null)
      setMode({ kind: 'present', tour: t.id, start: s, nonce: ++seq.current, autoplay: !!opts.autoplay, record: !!opts.record })
    },
    [tours, viewId],
  )
  const exitPresent = useCallback(
    (v: string) => {
      setMode({ kind: 'explore' })
      if (v && data?.views?.[v]) setViewId(v)
    },
    [data, setViewId],
  )

  // ---- bus: atlas.show
  const showRef = useRef<(d: any) => void>(() => {})
  const pendingShow = useRef<any>(null)
  showRef.current = (d: any) => {
    if (!data) {
      pendingShow.current = d
      return
    }
    const req = parseShow(d, data, tours) as any
    if (!req) return
    if (req.kind === 'tour') {
      if (mode.kind === 'present' && mode.tour === req.tour) setPcmd({ seq: ++seq.current, slide: req.slide })
      else present(req.tour, req.slide)
      return
    }
    if (req.present) {
      const t = mode.kind === 'present' ? tours.find((x) => x.id === mode.tour) ?? tours[0] : tours[0]
      const live = req.focus.length > 1 || req.edges.length > 0 || !!req.note
      const exact = live ? -1 : t.slides.findIndex((s) => s.view === req.view && (s.step ?? 0) === (req.step ?? 0) && (s.focus ?? '') === (req.focus[0] ?? ''))
      const adhoc = { view: req.view, step: req.step, focus: req.focus.length > 1 ? req.focus : req.focus[0], edges: req.edges, note: req.note ?? data.views[req.view]?.title }
      if (mode.kind === 'present') setPcmd({ seq: ++seq.current, slide: exact >= 0 ? exact : undefined, adhoc: exact >= 0 ? undefined : adhoc })
      else if (exact >= 0) present(t.id, exact)
      else {
        present(t.id, slideForView(t.slides, req.view))
        setPcmd({ seq: ++seq.current, adhoc })
      }
      return
    }
    if (mode.kind === 'present') setMode({ kind: 'explore' })
    if (req.caption !== undefined) setCaption(req.caption ? { text: req.caption, seq: ++captionSeq.current } : null)
    setViewId(req.view)
    setSelected(null)
    const plan = exploreShowPlan(req) as any
    setHighlight(plan.highlight)
    // a step AND a highlight: walk to the step, then light the highlight + callout over it
    command({ view: req.view, step: plan.step, highlight: plan.highlight ?? undefined, fit: plan.fit })
  }
  const clearLive = useCallback(() => {
    setHighlight((h) => {
      if (h) command({ view: h.view, clear: true })
      return null
    })
  }, [command])
  useEffect(() => {
    if (data && pendingShow.current) {
      const d = pendingShow.current
      pendingShow.current = null
      showRef.current(d)
    }
  }, [data])
  // the latest show / clear, once the model is up: a request published just before this view
  // mounted (the console remounts an open view on navigate, protoAgent#4283) is replayed while
  // fresh; `show_seq` makes one that ALSO arrives on the bus apply once (#11)
  const appliedSeq = useRef(0)
  const replayed = useRef(false)
  useEffect(() => {
    if (!data || replayed.current) return
    replayed.current = true
    void (async () => {
      try {
        const r = await kit.apiFetch('/api/plugins/atlas/last-show', { cache: 'no-store' })
        if (!r.ok) return
        const last = (await r.json())?.last
        const act = replayAction(last, appliedSeq.current)
        if (!act) return
        appliedSeq.current = last.seq
        if (act === 'show') showRef.current(last.data ?? {})
        else (clearRef.current(), setCaption(null))
      } catch {
        /* an older backend: no replay */
      }
    })()
  }, [data, kit])
  useEffect(() => {
    let lastSeq = 0
    const onMsg = (e: MessageEvent) => {
      if (!fromParent(e)) return // only the console frame, at its origin
      const m = e.data
      if (m?.type === 'protoagent:contextmenu:action') return menuRef.current(String(m.itemId ?? '').split('.').pop() ?? '')
      if (!m || m.type !== 'protoagent:event') return
      if (typeof m.seq === 'number') {
        if (m.seq <= lastSeq) return
        lastSeq = m.seq
      }
      if (m.topic === SHOW_TOPIC || m.topic === CLEAR_TOPIC) {
        if (alreadyApplied(m.data, appliedSeq.current)) return // the replay (or a duplicate) had it
        if (typeof m.data?.show_seq === 'number') appliedSeq.current = m.data.show_seq
      }
      if (m.topic === SHOW_TOPIC) showRef.current(m.data ?? {})
      else if (m.topic === CLEAR_TOPIC) (clearRef.current(), setCaption(null))
    }
    window.addEventListener('message', onMsg)
    subscribeBus()
    kit.initPluginView(() => subscribeBus())
    return () => window.removeEventListener('message', onMsg)
  }, [kit])

  // ---- node context menu → the console's menu (protoagent:contextmenu:open / :action)
  const menuFor = useRef<string | null>(null)
  const menuRef = useRef<(id: string) => void>(() => {})
  menuRef.current = (id: string) => {
    const fqn = menuFor.current
    if (!fqn || !data?.elements?.[fqn]) return
    const el = data.elements[fqn]
    const code = normaliseLinks(el.links).find((l: any) => l.kind === 'code')
    if (id === 'view' && code) void openCode(code, el.title || fqn, 'pane')
    else if (id === 'editor' && code) void openCode(code, el.title || fqn, 'editor')
    else if (id === 'details') setSelected(fqn)
    else if (id === 'drill') {
      const node = data.views?.[viewId ?? '']?.nodes?.find((n: any) => n.id === fqn)
      const to = node?.navigateTo ?? scopedViewOf(data, fqn)
      if (to) setViewId(to)
    } else if (id === 'present') present(undefined, slideForView(tours[0]?.slides ?? [], viewId ?? 'index'))
    else if (id === 'copy') void copyText(fqn).then((ok) => showToast(ok ? `Copied ${fqn}` : fqn))
    else if (id === 'ask') ask(fqn)
  }
  const onNodeMenu = useCallback(
    (fqn: string, node: any, e: MouseEvent) => {
      if (!embedded) return // standalone: the browser's own menu
      e.preventDefault?.()
      const el = data?.elements?.[fqn]
      if (!el) return
      menuFor.current = fqn
      const items = nodeMenuItems({
        hasCode: normaliseLinks(el.links).some((l: any) => l.kind === 'code'),
        paneOn,
        canDrill: !!(node?.navigateTo ?? scopedViewOf(data, fqn)),
        canPresent: tours.length > 0,
        canAsk: canCompose,
      })
      post({ type: 'protoagent:contextmenu:open', x: e.clientX, y: e.clientY, items })
    },
    [data, paneOn, tours.length, canCompose],
  )

  // ---- host chords: forward ⌘/Ctrl/Alt keys Atlas didn't handle (⌘⇧K palette etc. keep working)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldForwardKey(e)) return
      const el = document.activeElement as HTMLElement | null
      const editable = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      post({ type: 'protoagent:keydown', combo: keyCombo(e), editable })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- atlas.clear from the bus
  const clearRef = useRef<() => void>(() => {})
  clearRef.current = clearLive

  // ---- "Ask about this" → the console's chat draft (protoagent:chat:compose; never sends)
  const lastAsk = useRef(0)
  const ask = useCallback(
    (fqn?: string | null) => {
      if (!data || !canCompose) return
      const now = Date.now()
      if (now - lastAsk.current < 1000) return // the host allows 1/s per view
      lastAsk.current = now
      const v = mode.kind === 'present' ? presenting?.view : viewId
      const text = askPrompt(data, { view: v, fqn: fqn ?? undefined, step: (mode.kind === 'present' ? presenting?.step : walk) ?? undefined })
      if (post({ type: 'protoagent:chat:compose', text })) showToast('Added to the chat box — edit and send')
    },
    [data, canCompose, mode.kind, presenting, viewId, walk, showToast],
  )

  // ---- what the operator sees → atlas.viewing (debounced) for atlas_describe(current=true)
  const viewing = useMemo(
    () =>
      data
        ? viewingPayload(
            mode.kind === 'present'
              ? { mode: 'present', view: presenting?.view ?? null, step: presenting?.step ?? null, tour: mode.tour, slide: presenting?.slide ?? mode.start }
              : { mode: 'explore', view: viewId, step: walk, selected, highlight },
          )
        : null,
    [data, mode, presenting, viewId, walk, selected, highlight],
  )
  const viewingKey = JSON.stringify(viewing)
  const instance = useMemo(() => Math.random().toString(36).slice(2, 10), [])
  const sendViewing = useCallback(
    (extra: Record<string, unknown> = {}) => viewing && post({ type: 'protoagent:publish', topic: 'atlas.viewing', data: { ...viewing, instance, ...extra } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewingKey, instance],
  )
  useEffect(() => {
    if (!viewing) return
    const t = window.setTimeout(() => sendViewing(), 400)
    return () => window.clearTimeout(t)
  }, [sendViewing, viewing])
  // heartbeat while visible (the backend marks a view stale after ~90 s of silence) + hidden / closed
  useEffect(() => {
    const beat = window.setInterval(() => document.visibilityState === 'visible' && sendViewing(), 30_000)
    const onVis = () => sendViewing(document.visibilityState === 'visible' ? {} : { hidden: true })
    const onHide = () => sendViewing({ closed: true })
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.clearInterval(beat)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onHide)
    }
  }, [sendViewing])

  // ---- keyboard (explore): "/" search, "p" present
  useEffect(() => {
    if (mode.kind !== 'explore') return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // only on the page / diagram — never while a button, link, menu or field has focus
      const owner = keyOwner(e.composedPath().map((n: any) => (n instanceof Element ? { tag: n.tagName, role: n.getAttribute('role'), editable: (n as HTMLElement).isContentEditable } : null)))
      if (owner !== 'surface') return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        present()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode.kind, present])

  // ---- stable hooks for recorders / tests: data-atlas-state | -slide | -view on <html>
  const atlasState = !data ? 'loading' : mode.kind === 'present' ? (mode.done ? 'tour-done' : 'presenting') : 'ready'
  useEffect(() => {
    const r = document.documentElement
    r.dataset.atlasState = atlasState
    const v = mode.kind === 'present' ? presenting?.view : viewId
    if (v) r.dataset.atlasView = v
    if (mode.kind === 'present' && presenting) r.dataset.atlasSlide = String(presenting.slide + 1)
    else delete r.dataset.atlasSlide
    r.classList.toggle('atlas-record', mode.kind === 'present' && !!mode.record)
  }, [atlasState, mode, presenting, viewId])

  // ---- deep link: #tour=<id>&slide=<n>&present=1&autoplay=1&record=1  |  #view=<id>&focus=<fqn>&step=<n>
  const linked = useRef(false)
  useEffect(() => {
    if (linked.current || !data || !tours.length) return
    const link = parseDeepLink(location.hash) as any
    if (!link) return
    linked.current = true
    if (link.tour) {
      const t = tours.find((x) => x.id === link.tour)
      if (!t) return showToast(`Unknown tour ${link.tour}`)
      const start = Math.min(Math.max((link.slide ?? 1) - 1, 0), t.slides.length - 1)
      if (link.present) present(t.id, start, { autoplay: link.autoplay, record: link.record })
      return
    }
    showRef.current({ view: link.view, focus: link.focus, step: link.step, present: link.present })
  }, [data, tours, present, showToast])

  // ---- test hook
  useEffect(() => {
    ;(window as any).__atlas = { view: viewId, mode: mode.kind, selected, walk, paneOn, highlight, viewing, canCompose, hash: resp?.hash, ok: resp?.ok, stale: resp?.stale, tours: tours.map((t) => [t.id, t.slides.length]), scheme, base: BASE, embedded }
  })

  // ---------------------------------------------------------------- render
  const errors = resp && !resp.ok ? resp.errors ?? [] : []
  const exists = resp?.exists ?? status?.exists
  const nodeBad = status?.node && status.node.ok === false
  const enginePresent = status?.engine_present !== false

  if (!data) {
    let body: JSX.Element
    if (!resp && !net) body = <Empty data-testid="loading" description="Loading the architecture model…" />
    else if (nodeBad || !enginePresent) body = <EngineMissing status={status!} />
    else if (exists === false) body = <EmptyState resp={resp} status={status} />
    else if (resp && errors.length) body = <BrokenState errors={errors} info={resp} onOpen={openErrorFile} />
    else body = <Empty description={net ?? modelError ?? 'No model yet.'} />
    return (
      <div className="app">
        {net && <div className="pl-banner pl-banner--error banner">{net}</div>}
        <div className="state">{body}</div>
      </div>
    )
  }

  function openErrorFile(e: any, mods?: { metaKey?: boolean; ctrlKey?: boolean }) {
    const path = errorFileRel(e.file, resp)
    if (path) void openCode({ kind: 'code', path, line: e.line, title: path }, e.message, mods)
  }

  const v = viewId ? data.views?.[viewId] : null
  const crumbs = viewId ? viewChain(data, viewId) : []
  const hits = searchOpen ? searchModel(data, query) : []
  const steps = v?._type === 'dynamic' ? dynamicSteps(v).length : 0

  if (mode.kind === 'present' && tours.length) {
    return (
      <div className="app present-mode">
        {errors.length > 0 && <ErrorBanner errors={errors} info={resp} stale={!!resp?.stale} open={errorsOpen} setOpen={setErrorsOpen} onOpen={openErrorFile} compact />}
        <Presenter
          key={`${mode.nonce}:${model!.key}`}
          model={model!.m}
          data={data}
          tours={tours}
          tourId={mode.tour}
          start={mode.start}
          cmd={pcmd}
          scheme={scheme}
          themeCss={themeCss}
          onTour={(id) => setMode({ kind: 'present', tour: id, start: 0, nonce: ++seq.current })}
          onExit={exitPresent}
          onNoteClick={onCodeRefClick}
          onState={setPresenting}
          autoplay={mode.autoplay}
          record={mode.record}
          onDone={() => setMode((m) => (m.kind === 'present' ? { ...m, done: true } : m))}
        />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="bar">
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={c} className="crumb">
              {i > 0 && <span className="sep">›</span>}
              <button className={i === crumbs.length - 1 ? 'here' : ''} onClick={() => setViewId(c)} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                {data.views[c]?.title || c}
              </button>
            </span>
          ))}
        </nav>
        <span className="sp" />
        <span className="viewpick">
        <Select aria-label="View" value={viewId ?? ''} onChange={(e) => setViewId(e.target.value)}>
          {viewOptions(data).map((o: any) => (
            <option key={o.id} value={o.id}>
              {' '.repeat(o.depth * 2)}
              {o.dynamic ? '▶ ' : ''}
              {o.title}
            </option>
          ))}
        </Select>
        </span>
        <div className="search">
          <Input
            ref={searchRef}
            type="search"
            placeholder="Search  /"
            aria-label="Search elements and views"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (e.currentTarget.blur(), setQuery(''))
              if (e.key === 'Enter' && hits[0]) pick(hits[0])
            }}
          />
          {searchOpen && query && (
            <ul className="hits" role="listbox">
              {hits.length === 0 && <li className="muted nohit">No matches</li>}
              {hits.map((h: any) => (
                <li key={h.type + h.id}>
                  <button onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
                    <span className="h-title">{h.title}</span>
                    <span className="h-sub">{h.sub}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="present-group">
          <Button size="sm" variant="primary" className="present-btn" onClick={() => present()} title="Present (P)">
            ▶ Present
          </Button>
          <Menu
            align="end"
            trigger={
              <Button size="sm" icon aria-label="Tour options">
                ▾
              </Button>
            }
          >
            {tours.map((t, i) => (
              <div key={t.id} role="group" aria-label={t.title}>
                {i > 0 && <MenuSeparator />}
                <MenuLabel>
                  {t.title} · {t.slides.length} slides
                </MenuLabel>
                <MenuItem onSelect={() => present(t.id, 0)}>{`Present — ${t.title}`}</MenuItem>
                <MenuItem onSelect={() => present(t.id, 0, { autoplay: true })}>{`Autoplay — ${t.title}`}</MenuItem>
                <MenuItem onSelect={() => present(t.id, 0, { autoplay: true, record: true })}>{`Record — ${t.title}`}</MenuItem>
              </div>
            ))}
          </Menu>
        </div>
      </header>
      {errors.length > 0 && <ErrorBanner errors={errors} info={resp} stale={!!resp?.stale} open={errorsOpen} setOpen={setErrorsOpen} onOpen={openErrorFile} />}
      {net && <div className="pl-banner pl-banner--warning banner">{net}</div>}
      <main className="main">
        <div className="canvas">
          {viewId && v ? (
            <Explorer model={model!.m} data={data} viewId={viewId} scheme={scheme} themeCss={themeCss} cmd={ecmd} onNavigate={(to) => (setViewId(to), setSelected(null), setHighlight(null))}
              onSelect={(f) => {
                setSelected(f)
                if (highlight) clearLive() // the operator took over — the agent's highlight yields
              }}
              onWalk={setWalk}
              onNodeMenu={onNodeMenu}
              callout={highlight?.note ? { view: highlight.view, node: highlight.focus[0] ?? '', note: highlight.note } : null}
              onDismissCallout={() => setHighlight((h) => (h ? { ...h, note: undefined } : h))}
              onCodeRefClick={onCodeRefClick}
            />
          ) : (
            <Empty title="This model has no views yet." />
          )}
          <div className="canvas-tools">
            {steps > 0 &&
              (walk == null ? (
                <Button size="sm" onClick={() => command({ view: viewId!, step: 'start' })}>
                  ▶ Walk through {steps} steps
                </Button>
              ) : (
                <>
                  <Button size="sm" icon aria-label="Previous step" onClick={() => command({ view: viewId!, step: 'prev' })}>
                    ‹
                  </Button>
                  <span className="walkpos">
                    step {walk} / {steps}
                  </span>
                  <Button size="sm" icon aria-label="Next step" onClick={() => command({ view: viewId!, step: 'next' })}>
                    ›
                  </Button>
                  <Button size="sm" onClick={() => command({ view: viewId!, step: 'stop' })}>
                    Stop
                  </Button>
                </>
              ))}
            <Button size="sm" icon title="Fit view" aria-label="Fit view" onClick={() => command({ view: viewId!, fit: true })}>
              ⤢
            </Button>
          </div>
          {v?.description && !selected && <div className="view-desc">{v.description.txt ?? v.description.md}</div>}
        </div>
        {selected && data.elements?.[selected] && (
          <Details data={data} fqn={selected} paneOn={paneOn} onClose={() => setSelected(null)} onOpenView={(vv, f) => openView(vv, f)} onCode={(l, note, how) => void openCode(l, note, how)} onCodeRefClick={onCodeRefClick} onAsk={canCompose ? () => ask(selected) : undefined} />
        )}
      </main>
      {caption && (
        <div className="caption-bar" role="status" aria-live="polite">
          <p key={caption.seq} className="caption-text">
            {caption.text}
          </p>
        </div>
      )}
    </div>
  )

  function pick(h: any) {
    setQuery('')
    setSearchOpen(false)
    searchRef.current?.blur()
    if (h.type === 'view') return setViewId(h.id)
    const where = viewForElement(data, h.id, viewId)
    if (!where) return
    setViewId(where.view)
    setSelected(h.id)
    if (where.focus) command({ view: where.view, focus: where.focus })
  }
}

// ---------------------------------------------------------------- states + banner
type OpenErr = (e: any, mods?: { metaKey?: boolean; ctrlKey?: boolean }) => void
function ErrorBanner({ errors, info, stale, open, setOpen, onOpen, compact }: { errors: any[]; info: any; stale: boolean; open: boolean; setOpen: (b: boolean) => void; onOpen: OpenErr; compact?: boolean }) {
  const first = errors[0]
  return (
    // TODO(protoContent#601): adopt the DS <Banner> once it takes a role override — it hardcodes
    // role="status", and model errors must keep their role="alert" announcement.
    <div className={`pl-banner pl-banner--error banner${compact ? ' compact' : ''}`} role="alert" data-testid="error-banner">
      <div className="b-row">
        <strong>
          {errors.length} model error{errors.length === 1 ? '' : 's'}
        </strong>
        <span className="b-sub">{stale ? 'showing the last good version' : ''}</span>
        <ErrorLine e={first} info={info} onOpen={onOpen} />
        {errors.length > 1 && (
          <button type="button" className="linkish" onClick={() => setOpen(!open)}>
            {open ? 'less' : `+${errors.length - 1} more`}
          </button>
        )}
      </div>
      {open && (
        <ul className="b-list">
          {errors.slice(1, 40).map((e, i) => (
            <li key={i}>
              <ErrorLine e={e} info={info} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ErrorLine({ e, info, onOpen }: { e: any; info: any; onOpen: OpenErr }) {
  if (!e) return null
  const loc = e.file ? `${displayFile(e.file, info)}${e.line ? `:${e.line}` : ''}` : ''
  const can = !!errorFileRel(e.file, info)
  return (
    <span className="b-err">
      {loc &&
        (can ? (
          <button type="button" className="b-loc linkish" onClick={(ev) => onOpen(e, ev)} title="View in the code pane (⌘/Ctrl-click: open in editor)">
            {loc}
          </button>
        ) : (
          <code className="b-loc">{loc}</code>
        ))}
      <span className="b-msg">{e.message}</span>
    </span>
  )
}

function EmptyState({ resp, status }: { resp: Resp | null; status: Status | null }) {
  const dir = resp?.model_dir ?? status?.model_dir
  return (
    <Empty
      className="state-card"
      data-testid="empty-state"
      icon="◇"
      title="No architecture map yet"
      description={
        <>
          Ask the agent to <strong>“map this project’s architecture”</strong> — the Atlas skill writes a LikeC4 model of the
          system, with drill-down views and code links, and this page picks it up live.
        </>
      }
    >
      {dir && (
        <p className="muted small">
          Looking for the model in <code>{dir}</code>
        </p>
      )}
    </Empty>
  )
}

function EngineMissing({ status }: { status: Status }) {
  const n = status?.node ?? {}
  return (
    <Empty
      className="state-card"
      data-testid="engine-state"
      icon="⚙"
      title="Atlas needs Node.js 20+"
      description={
        status?.engine_present === false ? (
          'The layout engine (vendor/atlas-engine.mjs) is missing from the plugin install — reinstall or update Atlas.'
        ) : (
          <>
            Atlas lays diagrams out with a small Node.js engine and couldn’t find a usable <code>node</code>. Install the
            managed Node runtime from the setup banner, or set <strong>Node.js path</strong> in Atlas’s settings.
          </>
        )
      }
    >
      {(n.error || n.version || n.path) && (
        <p className="muted small">
          {n.path ? <code>{n.path}</code> : null} {n.version ? `(${n.version})` : null} {n.error}
        </p>
      )}
    </Empty>
  )
}

function BrokenState({ errors, info, onOpen }: { errors: any[]; info: any; onOpen: OpenErr }) {
  return (
    <Empty className="state-card wide" data-testid="broken-state" title="The architecture model doesn’t compile yet" description="Fix these and the diagram appears here automatically.">
      <ul className="b-list">
        {errors.slice(0, 40).map((e, i) => (
          <li key={i}>
            <ErrorLine e={e} info={info} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </Empty>
  )
}

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = t
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
