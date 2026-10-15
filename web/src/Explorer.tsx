// Explore mode: the shared Stage on the current view, so every view change — the node's
// drill-down button, the breadcrumb, the view picker, "Open drill-down", search, the bus —
// uses the same synced-camera zoom as the presenter. Commands (focus / walkthrough / fit)
// run once the stage has settled on their view.
import type { LikeC4Model } from '@likec4/core/model'
import { memo, useEffect, useRef, useState } from 'react'
import { applyHighlight, clearHighlight, type Highlight } from './highlight'
import { calloutPlacement, mdLight } from './logic.mjs'
import { Stage, type StageHandle } from './Stage'

export type ExploreCmd = {
  seq: number
  view: string
  focus?: string
  step?: number | 'start' | 'next' | 'prev' | 'stop'
  fit?: boolean
  highlight?: Highlight
  clear?: boolean
}

type Props = {
  model: LikeC4Model<any>
  data: any
  viewId: string
  scheme: 'light' | 'dark'
  themeCss: string
  cmd: ExploreCmd | null
  onNavigate: (view: string) => void
  onSelect: (fqn: string | null) => void
  onWalk: (step: number | null) => void
  onSettled?: (view: string) => void
  onNodeMenu?: (fqn: string, node: any, e: MouseEvent) => void
  /** the live callout (a highlight's note), anchored to its first focused node */
  callout?: { view: string; node: string; note: string } | null
  onDismissCallout?: () => void
  onCodeRefClick?: (e: React.MouseEvent | React.KeyboardEvent) => void
}

const stepId = (n: number) => `step-${String(n).padStart(2, '0')}` as any
const LAYER_PROPS = {
  controls: false,
  showNavigationButtons: false,
  enableSearch: false,
  enableElementDetails: false,
  enableFocusMode: true,
  enableDynamicViewWalkthrough: true,
  enableRelationshipDetails: true,
  enableRelationshipBrowser: true,
  enableNotations: false,
  maxZoom: 3,
}

function ExplorerImpl({ model, data, viewId, scheme, themeCss, cmd, onNavigate, onSelect, onWalk, onSettled, onNodeMenu, callout, onDismissCallout, onCodeRefClick }: Props) {
  const stage = useRef<StageHandle>(null)
  const initial = useRef(viewId)

  // the App's viewId is the source of truth → zoom there
  useEffect(() => {
    const s = stage.current
    if (!s) return
    void s.ready().then(() => s.go(viewId))
  }, [viewId])

  const done = useRef(0)
  useEffect(() => {
    if (!cmd || cmd.seq === done.current) return
    let live = true
    const s = stage.current
    if (!s) return
    const run = async () => {
      await s.ready()
      const t0 = performance.now()
      while (live && (s.busy() || s.current() !== cmd.view) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50))
      if (!live || s.current() !== cmd.view) return
      done.current = cmd.seq
      const d = s.diagram()
      if (!d) return
      const ctx = d.getContext() as any
      const st = cmd.step
      if (cmd.clear) {
        clearHighlight(d)
        return
      }
      if (cmd.highlight && !st) {
        clearHighlight(d)
        applyHighlight(d, s.xyflow(), data?.views?.[cmd.view], cmd.highlight)
        return
      }
      if (st === 'stop') {
        d.stopWalkthrough()
        d.fitDiagram(450)
      } else if (st === 'next' || st === 'prev') d.walkthroughStep(st)
      else if (st === 'start' || typeof st === 'number') {
        const id = typeof st === 'number' ? stepId(st) : undefined
        if (ctx.activeWalkthrough && id) d.walkthroughStep({ step: id })
        else d.startWalkthrough(id)
      } else if (cmd.focus) {
        if (ctx.activeWalkthrough) d.stopWalkthrough()
        d.focusNode(cmd.focus as any)
      } else if (cmd.fit) {
        if (ctx.activeWalkthrough) d.stopWalkthrough()
        d.send({ type: 'key.esc' } as any)
        d.fitDiagram(450)
      }
      setTimeout(() => {
        const w = (d.getContext() as any).activeWalkthrough
        onWalk(w ? Number(String(w.stepId ?? '').replace(/^step-0*/, '')) || 1 : null)
      }, 80)
    }
    void run()
    return () => {
      live = false
    }
  }, [cmd, onWalk, data])

  useEffect(() => {
    ;(window as any).__atlasStage = stage.current
  })

  return (
    <>
    <Stage
      ref={stage}
      model={model}
      data={data}
      initialView={initial.current}
      scheme={scheme}
      themeCss={themeCss}
      pad={48}
      layerProps={LAYER_PROPS}
      onNavigateTo={(to) => onNavigate(to)}
      onNodeClick={(n) => onSelect(n.modelRef ?? n.id)}
      onCanvasClick={() => onSelect(null)}
      onNodeContextMenu={onNodeMenu ? (n, e) => onNodeMenu(n.modelRef ?? n.id, n, e) : undefined}
      onSettled={onSettled}
    />
    {callout && callout.view === viewId && (
      <Callout stage={stage} node={data?.views?.[viewId]?.nodes?.find((n: any) => n.id === callout.node)} note={callout.note} onDismiss={onDismissCallout} onCodeRefClick={onCodeRefClick} />
    )}
    </>
  )
}

/** The on-canvas callout: follows its node through pans / zooms / transitions (rAF, only while shown). */
function Callout({ stage, node, note, onDismiss, onCodeRefClick }: { stage: React.RefObject<StageHandle | null>; node: any; note: string; onDismiss?: () => void; onCodeRefClick?: (e: any) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; side: string; arrowX: number } | null>(null)
  useEffect(() => {
    if (!node) return
    let raf = 0
    let last = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const s = stage.current
      const el = ref.current
      const host = el?.parentElement
      if (!s || !el || !host || s.busy()) return
      const vp = s.xyflow()?.getViewport?.()
      if (!vp) return
      const p = calloutPlacement(node, vp, { width: host.clientWidth, height: host.clientHeight }, { width: el.offsetWidth, height: el.offsetHeight }) as any
      const key = `${p.left},${p.top},${p.side},${p.arrowX}`
      if (key !== last) ((last = key), setPos(p))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [node, stage])
  if (!node) return null
  return (
    <div
      ref={ref}
      className={`callout callout--${pos?.side ?? 'above'}`}
      role="note"
      data-testid="callout"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, ['--arrow-x' as any]: `${pos?.arrowX ?? 20}px` }}
    >
      <div className="callout__body" onClick={onCodeRefClick} onKeyDown={onCodeRefClick} dangerouslySetInnerHTML={{ __html: mdLight(note, { codeRefs: true }) }} />
      <button className="pl-btn pl-btn--ghost pl-btn--xs callout__close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}

export const Explorer = memo(ExplorerImpl)
