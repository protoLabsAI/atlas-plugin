// Explore mode canvas: one ReactLikeC4 on the current view. Click a node → details;
// drill-down via the node's navigate button (onNavigateTo). Commands (focus / walkthrough)
// arrive as `cmd` and run once the diagram shows the target view.
import { LikeC4ModelProvider, ReactLikeC4, type DiagramApi } from '@likec4/diagram'
import type { LikeC4Model } from '@likec4/core/model'
import { memo, useEffect, useRef } from 'react'

export type ExploreCmd = { seq: number; view: string; focus?: string; step?: number | 'start' | 'next' | 'prev' | 'stop'; fit?: boolean }

type Props = {
  model: LikeC4Model<any>
  viewId: string
  scheme: 'light' | 'dark'
  cmd: ExploreCmd | null
  onNavigate: (view: string) => void
  onSelect: (fqn: string | null) => void
  onWalk: (step: number | null) => void
}

const stepId = (n: number) => `step-${String(n).padStart(2, '0')}` as any
const fontVar = { '--likec4-app-font': 'var(--pl-font-sans)' } as any

function ExplorerImpl({ model, viewId, scheme, cmd, onNavigate, onSelect, onWalk }: Props) {
  const api = useRef<DiagramApi | null>(null)
  const done = useRef(0)

  useEffect(() => {
    if (!cmd || cmd.seq === done.current) return
    let live = true
    const t0 = performance.now()
    const tick = () => {
      if (!live) return
      const d = api.current
      const shown = (() => {
        try {
          return d?.currentView?.id
        } catch {
          return undefined
        }
      })()
      if (!d || shown !== cmd.view) {
        if (performance.now() - t0 < 4000) requestAnimationFrame(tick)
        return
      }
      done.current = cmd.seq
      // give the view-change animation a moment before steering the camera
      setTimeout(() => {
        if (!live) return
        const ctx = d.getContext() as any
        const s = cmd.step
        if (s === 'stop') {
          d.stopWalkthrough()
          onWalk(null)
        } else if (s === 'next' || s === 'prev') {
          d.walkthroughStep(s)
        } else if (s === 'start' || typeof s === 'number') {
          const id = typeof s === 'number' ? stepId(s) : undefined
          if (ctx.activeWalkthrough && id) d.walkthroughStep({ step: id })
          else d.startWalkthrough(id)
        } else if (cmd.focus) {
          if (ctx.activeWalkthrough) d.stopWalkthrough()
          d.focusNode(cmd.focus as any)
        } else if (cmd.fit) {
          if (ctx.activeWalkthrough) d.stopWalkthrough()
          d.send({ type: 'key.esc' } as any)
          d.fitDiagram(400)
        }
        // report the walkthrough position back to the toolbar
        setTimeout(() => {
          const w = (d.getContext() as any).activeWalkthrough
          onWalk(w ? Number(String(w.stepId ?? '').replace(/^step-0*/, '')) || 1 : null)
        }, 60)
      }, 260)
    }
    tick()
    return () => {
      live = false
    }
  }, [cmd, onWalk])

  return (
    <LikeC4ModelProvider likec4model={model}>
      <ReactLikeC4
        viewId={viewId as any}
        style={{ width: '100%', height: '100%', ...fontVar }}
        colorScheme={scheme}
        injectFontCss={false}
        background="transparent"
        controls={false}
        showNavigationButtons={false}
        enableSearch={false}
        enableElementDetails={false}
        enableFocusMode
        enableDynamicViewWalkthrough
        enableRelationshipDetails
        enableRelationshipBrowser
        enableNotations={false}
        fitViewPadding={48 as any}
        onNavigateTo={(to) => onNavigate(String(to))}
        onNodeClick={(n: any) => onSelect(n.modelRef ?? n.id)}
        onCanvasClick={() => onSelect(null)}
        onInitialized={({ diagram }) => {
          api.current = diagram
          ;(window as any).__atlasDiagram = diagram
        }}
      />
    </LikeC4ModelProvider>
  )
}

export const Explorer = memo(ExplorerImpl)
