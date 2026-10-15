// Atlas viewer shell: data (model polling with ETag), theme, bus, and the explore/present modes.
import { LikeC4Model } from '@likec4/core/model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Details } from './Details'
import { Explorer, type ExploreCmd } from './Explorer'
import { Presenter, type PresenterCmd, type Tour } from './Presenter'
import { BASE, currentScheme, embedded, post, subscribeBus, type Kit } from './host'
import {
  codeOpenMessage, displayFile, dynamicSteps, errorFileRel, keepView, parseShow, resolveProject,
  searchModel, slideForView, toursFor, viewChain, viewForElement, viewOptions,
} from './logic.mjs'

const POLL_MS = 2000
type Resp = { ok: boolean; errors: any[]; model: any; tours: any; hash: string; model_dir?: string; project_root?: string; project?: string; exists?: boolean; stale?: boolean }
type Status = { node?: { ok?: boolean; path?: string; version?: string; source?: string; error?: string }; exists?: boolean; model_dir?: string; engine_present?: boolean; project?: string; project_root?: string }

// ---------------------------------------------------------------- theme
function useScheme(kit: Kit) {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => currentScheme())
  useEffect(() => {
    const apply = () => {
      const s = currentScheme()
      setScheme(s)
      const root = document.documentElement
      if (root.style.colorScheme !== s) root.style.colorScheme = s // form controls + scrollbars
      if (root.dataset.scheme !== s) root.dataset.scheme = s
    }
    apply()
    // the kit re-sets --pl-* on :root (inline style) on init + every live re-theme
    const mo = new MutationObserver(apply)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    kit.initPluginView(() => apply())
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
  return scheme
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
      if (r.ok) setStatus(await r.json())
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
type Mode = { kind: 'explore' } | { kind: 'present'; tour: string; start: number; nonce: number }

export function App({ kit }: { kit: Kit }) {
  const scheme = useScheme(kit)
  const { resp, status, net, model, modelError } = useAtlasData(kit)
  const data = model?.data
  const tours: Tour[] = useMemo(() => (data ? toursFor(resp?.tours, data) : []), [data, resp?.tours])

  const [viewId, setViewIdRaw] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'explore' })
  const [ecmd, setEcmd] = useState<ExploreCmd | null>(null)
  const [pcmd, setPcmd] = useState<PresenterCmd | null>(null)
  const [walk, setWalk] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
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

  const showToast = useCallback((t: string) => {
    setToast(t)
    window.setTimeout(() => setToast((x) => (x === t ? null : x)), 3500)
  }, [])

  // ---- code links → the console's code pane
  const rootsRef = useRef<Record<string, string> | null | undefined>(undefined)
  const openCode = useCallback(
    async (link: any, note: string) => {
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
      const target = resolveProject(resp, roots, link.path)
      const msg = codeOpenMessage(target, link, note)
      const label = target ? `${target.project}/${target.path}${link.line ? `:${link.line}` : ''}` : link.path
      if (msg && post(msg)) return
      try {
        await navigator.clipboard.writeText(label)
        showToast(`Copied ${label}`)
      } catch {
        showToast(label)
      }
    },
    [kit, resp, showToast],
  )

  // ---- presenter
  const present = useCallback(
    (tourId?: string, start?: number) => {
      if (!tours.length) return
      const t = tours.find((x) => x.id === tourId) ?? tours[0]
      const s = typeof start === 'number' ? start : slideForView(t.slides, viewId ?? 'index')
      setSelected(null)
      setMode({ kind: 'present', tour: t.id, start: s, nonce: ++seq.current })
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
      const exact = t.slides.findIndex((s) => s.view === req.view && (s.step ?? 0) === (req.step ?? 0) && (s.focus ?? '') === (req.focus ?? ''))
      const adhoc = { view: req.view, step: req.step, focus: req.focus, note: data.views[req.view]?.title }
      if (mode.kind === 'present') setPcmd({ seq: ++seq.current, slide: exact >= 0 ? exact : undefined, adhoc: exact >= 0 ? undefined : adhoc })
      else if (exact >= 0) present(t.id, exact)
      else {
        present(t.id, slideForView(t.slides, req.view))
        setPcmd({ seq: ++seq.current, adhoc })
      }
      return
    }
    if (mode.kind === 'present') setMode({ kind: 'explore' })
    setViewId(req.view)
    if (req.step) command({ view: req.view, step: req.step })
    else if (req.focus) {
      command({ view: req.view, focus: req.focus })
      setSelected(req.focus)
    } else command({ view: req.view, fit: true })
  }
  useEffect(() => {
    if (data && pendingShow.current) {
      const d = pendingShow.current
      pendingShow.current = null
      showRef.current(d)
    }
  }, [data])
  useEffect(() => {
    let lastSeq = 0
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      if (!m || m.type !== 'protoagent:event') return
      if (typeof m.seq === 'number') {
        if (m.seq <= lastSeq) return
        lastSeq = m.seq
      }
      if (m.topic === 'atlas.show' || String(m.topic).endsWith('.atlas.show')) showRef.current(m.data ?? {})
    }
    window.addEventListener('message', onMsg)
    subscribeBus()
    kit.initPluginView(() => subscribeBus())
    return () => window.removeEventListener('message', onMsg)
  }, [kit])

  // ---- keyboard (explore): "/" search, "p" present
  useEffect(() => {
    if (mode.kind !== 'explore') return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
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

  // ---- test hook
  useEffect(() => {
    ;(window as any).__atlas = { view: viewId, mode: mode.kind, selected, walk, hash: resp?.hash, ok: resp?.ok, stale: resp?.stale, tours: tours.map((t) => [t.id, t.slides.length]), scheme, base: BASE, embedded }
  })

  // ---------------------------------------------------------------- render
  const errors = resp && !resp.ok ? resp.errors ?? [] : []
  const exists = resp?.exists ?? status?.exists
  const nodeBad = status?.node && status.node.ok === false
  const enginePresent = status?.engine_present !== false

  if (!data) {
    let body: JSX.Element
    if (!resp && !net) body = <div className="state-card muted">Loading the architecture model…</div>
    else if (nodeBad || !enginePresent) body = <EngineMissing status={status!} />
    else if (exists === false) body = <EmptyState resp={resp} status={status} />
    else if (resp && errors.length) body = <BrokenState errors={errors} info={resp} onOpen={(e) => openErrorFile(e)} />
    else body = <div className="state-card">{net ?? modelError ?? 'No model yet.'}</div>
    return (
      <div className="app">
        {net && <div className="banner banner-error">{net}</div>}
        <div className="state">{body}</div>
      </div>
    )
  }

  function openErrorFile(e: any) {
    const path = errorFileRel(e.file, resp)
    if (path) void openCode({ kind: 'code', path, line: e.line, title: path }, e.message)
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
          onTour={(id) => setMode({ kind: 'present', tour: id, start: 0, nonce: ++seq.current })}
          onExit={exitPresent}
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
        <select className="viewpick" aria-label="View" value={viewId ?? ''} onChange={(e) => setViewId(e.target.value)}>
          {viewOptions(data).map((o: any) => (
            <option key={o.id} value={o.id}>
              {' '.repeat(o.depth * 2)}
              {o.dynamic ? '▶ ' : ''}
              {o.title}
            </option>
          ))}
        </select>
        <div className="search">
          <input
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
        <button className="pl-btn present-btn" onClick={() => present()} title="Present (P)">
          ▶ Present
        </button>
      </header>
      {errors.length > 0 && <ErrorBanner errors={errors} info={resp} stale={!!resp?.stale} open={errorsOpen} setOpen={setErrorsOpen} onOpen={openErrorFile} />}
      {net && <div className="banner banner-warn">{net}</div>}
      <main className="main">
        <div className="canvas">
          {viewId && v ? (
            <Explorer model={model!.m} viewId={viewId} scheme={scheme} cmd={ecmd} onNavigate={(to) => (setViewId(to), setSelected(null))} onSelect={setSelected} onWalk={setWalk} />
          ) : (
            <div className="state-card">This model has no views yet.</div>
          )}
          <div className="canvas-tools">
            {steps > 0 &&
              (walk == null ? (
                <button className="pl-btn" onClick={() => command({ view: viewId!, step: 'start' })}>
                  ▶ Walk through {steps} steps
                </button>
              ) : (
                <>
                  <button className="pl-btn" aria-label="Previous step" onClick={() => command({ view: viewId!, step: 'prev' })}>
                    ‹
                  </button>
                  <span className="walkpos">
                    step {walk} / {steps}
                  </span>
                  <button className="pl-btn" aria-label="Next step" onClick={() => command({ view: viewId!, step: 'next' })}>
                    ›
                  </button>
                  <button className="pl-btn" onClick={() => command({ view: viewId!, step: 'stop' })}>
                    Stop
                  </button>
                </>
              ))}
            <button className="pl-btn" title="Fit view" aria-label="Fit view" onClick={() => command({ view: viewId!, fit: true })}>
              ⤢
            </button>
          </div>
          {v?.description && !selected && <div className="view-desc">{v.description.txt ?? v.description.md}</div>}
        </div>
        {selected && data.elements?.[selected] && (
          <Details data={data} fqn={selected} onClose={() => setSelected(null)} onOpenView={(vv, f) => openView(vv, f)} onCode={(l, note) => void openCode(l, note)} />
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
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
function ErrorBanner({ errors, info, stale, open, setOpen, onOpen, compact }: { errors: any[]; info: any; stale: boolean; open: boolean; setOpen: (b: boolean) => void; onOpen: (e: any) => void; compact?: boolean }) {
  const first = errors[0]
  return (
    <div className={`banner banner-error${compact ? ' compact' : ''}`} role="alert" data-testid="error-banner">
      <div className="b-row">
        <strong>
          {errors.length} model error{errors.length === 1 ? '' : 's'}
        </strong>
        <span className="b-sub">{stale ? 'showing the last good version' : ''}</span>
        <ErrorLine e={first} info={info} onOpen={onOpen} />
        {errors.length > 1 && (
          <button className="linkish" onClick={() => setOpen(!open)}>
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

function ErrorLine({ e, info, onOpen }: { e: any; info: any; onOpen: (e: any) => void }) {
  if (!e) return null
  const loc = e.file ? `${displayFile(e.file, info)}${e.line ? `:${e.line}` : ''}` : ''
  const can = !!errorFileRel(e.file, info)
  return (
    <span className="b-err">
      {loc &&
        (can ? (
          <button className="b-loc linkish" onClick={() => onOpen(e)} title="Open in the code pane">
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
    <div className="state-card" data-testid="empty-state">
      <div className="state-icon" aria-hidden>
        ◇
      </div>
      <h1>No architecture map yet</h1>
      <p>
        Ask the agent to <strong>“map this project’s architecture”</strong> — the Atlas skill writes a LikeC4 model of the
        system, with drill-down views and code links, and this page picks it up live.
      </p>
      {dir && (
        <p className="muted small">
          Looking for the model in <code>{dir}</code>
        </p>
      )}
    </div>
  )
}

function EngineMissing({ status }: { status: Status }) {
  const n = status?.node ?? {}
  return (
    <div className="state-card" data-testid="engine-state">
      <div className="state-icon" aria-hidden>
        ⚙
      </div>
      <h1>Atlas needs Node.js 20+</h1>
      {status?.engine_present === false ? (
        <p>The layout engine (vendor/atlas-engine.mjs) is missing from the plugin install — reinstall or update Atlas.</p>
      ) : (
        <p>
          Atlas lays diagrams out with a small Node.js engine and couldn’t find a usable <code>node</code>. Install the
          managed Node runtime from the setup banner, or set <strong>Node.js path</strong> in Atlas’s settings.
        </p>
      )}
      {(n.error || n.version || n.path) && (
        <p className="muted small">
          {n.path ? <code>{n.path}</code> : null} {n.version ? `(${n.version})` : null} {n.error}
        </p>
      )}
    </div>
  )
}

function BrokenState({ errors, info, onOpen }: { errors: any[]; info: any; onOpen: (e: any) => void }) {
  return (
    <div className="state-card wide" data-testid="broken-state">
      <h1>The architecture model doesn’t compile yet</h1>
      <p className="muted">Fix these and the diagram appears here automatically.</p>
      <ul className="b-list">
        {errors.slice(0, 40).map((e, i) => (
          <li key={i}>
            <ErrorLine e={e} info={info} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  )
}
