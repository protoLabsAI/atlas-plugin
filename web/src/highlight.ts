// Live highlights on a LikeC4 diagram: LikeC4's own dim mechanics (node/edge `dimmed`, edge
// `active` = animated) driven per node/edge — its built-in highlight only takes ONE node or edge.
// The camera eases to the lit set through xyflow (the shared, slowed camera timing).
import type { DiagramApi } from '@likec4/diagram'
import { highlightPlan } from './logic.mjs'

export type Highlight = { view: string; focus: string[]; edges: string[]; note?: string }

export function applyHighlight(diagram: DiagramApi, xyflow: any, view: any, h: Highlight, opts: { keepWalkthrough?: boolean; fit?: boolean } = {}) {
  const p = highlightPlan(view, h.focus, h.edges) as any
  if (p.empty) return false
  try {
    const ctx = diagram.getContext() as any
    if (ctx.activeWalkthrough && !opts.keepWalkthrough) diagram.stopWalkthrough()
    if (ctx.focusedNode) diagram.send({ type: 'key.esc' } as any)
    for (const id of p.lit) diagram.updateNodeData(id, { dimmed: false } as any)
    for (const id of p.dimNodes) diagram.updateNodeData(id, { dimmed: true } as any)
    for (const id of p.active) diagram.updateEdgeData(id, { dimmed: false, active: true } as any)
    for (const id of p.dimEdges) diagram.updateEdgeData(id, { dimmed: true, active: false } as any)
  } catch (e) {
    console.warn('[atlas] highlight', e)
  }
  if (opts.fit !== false && p.bounds && xyflow?.fitBounds) {
    // 640 ms through the patched camera (× CAMERA_SCALE × speed) ≈ the shared zoom duration
    void xyflow.fitBounds(p.bounds, { padding: 0.25, duration: 640 })
  }
  return true
}

export function clearHighlight(diagram: DiagramApi | undefined) {
  if (!diagram) return
  try {
    diagram.unhighlightAll()
    const ctx = diagram.getContext() as any
    for (const e of ctx.xyedges ?? []) if (e.data?.active) diagram.updateEdgeData(e.id, { active: false } as any)
  } catch {
    /* gone */
  }
}
