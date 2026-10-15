// Explore mode: the shared Stage on the current view, so every view change — the node's
// drill-down button, the breadcrumb, the view picker, "Open drill-down", search, the bus —
// uses the same synced-camera zoom as the presenter. Commands (focus / walkthrough / fit)
// run once the stage has settled on their view.
import type { LikeC4Model } from '@likec4/core/model'
import { memo, useEffect, useRef } from 'react'
import { Stage, type StageHandle } from './Stage'

export type ExploreCmd = { seq: number; view: string; focus?: string; step?: number | 'start' | 'next' | 'prev' | 'stop'; fit?: boolean }

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

function ExplorerImpl({ model, data, viewId, scheme, themeCss, cmd, onNavigate, onSelect, onWalk, onSettled, onNodeMenu }: Props) {
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
  }, [cmd, onWalk])

  useEffect(() => {
    ;(window as any).__atlasStage = stage.current
  })

  return (
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
  )
}

export const Explorer = memo(ExplorerImpl)
