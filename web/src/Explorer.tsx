// Explore mode: the shared Stage on the current view, so every view change — the node's
// drill-down button, the breadcrumb, the view picker, "Open drill-down", search, the bus —
// uses the same synced-camera zoom as the presenter. Commands (focus / walkthrough / fit)
// run once the stage has settled on their view.
import type { LikeC4Model } from '@likec4/core/model'
import { memo, useEffect, useRef, useState } from 'react'
import { applyHighlight, clearHighlight, type Highlight } from './highlight'
import { calloutPlacement, mdLight } from './logic.mjs'
import { Button } from '@protolabsai/ui/primitives'
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
      if (cmd.highlight && typeof st === 'number') {
        // walk to the step first; light the highlight over it once the walkthrough camera settles
        const id = stepId(st)
        if (ctx.activeWalkthrough) d.walkthroughStep({ step: id })
        else d.startWalkthrough(id)
        setTimeout(() => {
          if (!live) return
          applyHighlight(d, s.xyflow(), data?.views?.[cmd.view], cmd.highlight!, { keepWalkthrough: true, fit: false })
          onWalk(st)
        }, 900)
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

/** The on-canvas callout. Follows its node through pans / zooms / transitions: a cheap 8 Hz check
 *  of the camera, and per-frame updates only while the camera is actually moving (no idle rAF).
 *  Off-canvas anchor → hidden until it's back. Tall notes scroll inside a bounded box.
 *  TODO(protoContent#602): move to the DS Popover once it takes virtual anchors + an arrow. */
function Callout({ stage, node, note, onDismiss, onCodeRefClick }: { stage: React.RefObject<StageHandle | null>; node: any; note: string; onDismiss?: () => void; onCodeRefClick?: (e: any) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<any>(null)
  useEffect(() => {
    if (!node) return
    let raf = 0
    let last = ''
    let still = 0
    const measure = () => {
      const s = stage.current
      const el = ref.current
      const host = el?.parentElement
      if (!s || !el || !host || s.busy()) return true
      const vp = s.xyflow()?.getViewport?.()
      if (!vp) return true
      // the other lit (highlighted) nodes — kept clear of the callout where there's any room
      const xyn = ((s.diagram()?.getContext() as any)?.xynodes ?? []) as any[]
      const anyDim = xyn.some((n) => n.data?.dimmed)
      const litIds = new Set(xyn.filter((n) => n.id !== node.id && !n.data?.dimmed).map((n) => n.id))
      // their boxes from the DOM (screen → flow under the current camera; compound children's
      // positions are parent-relative in the store)
      const hr = host.getBoundingClientRect()
      const sr = host.querySelector('.layer[data-active] .likec4-view')?.shadowRoot ?? host.querySelector('.likec4-view')?.shadowRoot
      const lit = [...(sr?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
        .filter((el) => litIds.has(el.dataset.id ?? '') && !el.querySelector('.likec4-compound-node'))
        .map((el) => {
          const r = el.getBoundingClientRect()
          return { x: (r.left - hr.left - vp.x) / vp.zoom, y: (r.top - hr.top - vp.y) / vp.zoom, width: r.width / vp.zoom, height: r.height / vp.zoom }
        })
      const p = calloutPlacement(node, vp, { width: host.clientWidth, height: host.clientHeight }, { width: el.offsetWidth, height: el.scrollHeight }, 12, 8, anyDim ? lit : []) as any
      const key = JSON.stringify(p)
      if (key === last) return false
      last = key
      setPos(p)
      return true
    }
    const burst = () => {
      // follow the camera frame by frame until it has been still for ~10 frames
      cancelAnimationFrame(raf)
      const step = () => {
        still = measure() ? 0 : still + 1
        if (still < 10) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    burst()
    const id = window.setInterval(() => measure() && burst(), 125)
    const ro = new ResizeObserver(() => burst())
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(id)
      ro.disconnect()
    }
  }, [node, stage, note])
  if (!node) return null
  return (
    <div
      ref={ref}
      className={`callout callout--${pos?.side ?? 'above'}`}
      role="note"
      data-testid="callout"
      hidden={!!pos?.hidden}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight, ['--arrow-x' as any]: `${pos?.arrowX ?? 20}px` }}
    >
      <div className="callout__body" onClick={onCodeRefClick} onKeyDown={onCodeRefClick} dangerouslySetInnerHTML={{ __html: mdLight(note, { codeRefs: true }) }} />
      <Button variant="ghost" size="xs" icon className="callout__close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </Button>
    </div>
  )
}

export const Explorer = memo(ExplorerImpl)
