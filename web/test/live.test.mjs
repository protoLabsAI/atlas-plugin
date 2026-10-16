import { test } from 'node:test'
import assert from 'node:assert/strict'
import { highlightPlan, calloutPlacement, viewingPayload, askPrompt, hostSupportsCompose, exploreShowPlan, toursFor, SHOW_TOPIC, CLEAR_TOPIC } from '../src/logic.mjs'

const n = (id, x, y, parent = null) => ({ id, x, y, width: 100, height: 50, parent })
const view = {
  id: 'inside', _type: 'element', title: 'Inside',
  nodes: [n('app', 0, 0), n('app.api', 20, 20, 'app'), n('app.graph', 200, 20, 'app'), n('gw', 400, 300), n('user', -300, 0)],
  edges: [{ id: 'c1', source: 'user', target: 'app.api' }, { id: 'c2', source: 'app.api', target: 'app.graph' }, { id: 'c3', source: 'app.graph', target: 'gw' }],
}

test('highlightPlan: focus + edge endpoints lit, containers kept, rest dimmed, bounds', () => {
  const p = highlightPlan(view, ['gw'], ['c2'])
  assert.deepEqual([...p.lit].sort(), ['app', 'app.api', 'app.graph', 'gw'])
  assert.deepEqual([...p.active], ['c2'])
  assert.deepEqual(p.dimNodes, ['user'])
  assert.deepEqual(p.dimEdges, ['c1', 'c3'])
  assert.deepEqual(p.bounds, { x: 20, y: 20, width: 480, height: 330 }, 'containers are lit, not fitted')
  assert.equal(highlightPlan(view, ['nope'], ['zz']).empty, true)
  assert.equal(highlightPlan(view, ['nope']).bounds, null)
})

test('calloutPlacement: above, clamped, flips below near the top', () => {
  const vp = { x: 0, y: 0, zoom: 1 }
  const canvas = { width: 800, height: 600 }
  const size = { width: 200, height: 60 }
  assert.deepEqual(calloutPlacement({ x: 300, y: 200, width: 100, height: 50 }, vp, canvas, size), { hidden: false, left: 250, top: 128, side: 'above', arrowX: 100, maxHeight: 584 })
  const top = calloutPlacement({ x: 300, y: 10, width: 100, height: 50 }, vp, canvas, size)
  assert.equal(top.side, 'below')
  assert.equal(top.top, 72)
  const edge = calloutPlacement({ x: 750, y: 200, width: 100, height: 50 }, vp, canvas, size)
  assert.equal(edge.left, 592, 'clamped inside the canvas')
  // a note taller than the canvas: bounded (it scrolls inside), top stays on the canvas
  const tall = calloutPlacement({ x: 300, y: 100, width: 100, height: 50 }, vp, canvas, { width: 200, height: 2000 })
  assert.equal(tall.maxHeight, 584)
  assert.ok(tall.top >= 8 && tall.top + Math.min(2000, tall.maxHeight) <= 600 - 8 + 1e-6, JSON.stringify(tall))
  // the anchor left the canvas → hidden (restored when it's back)
  assert.equal(calloutPlacement({ x: 900, y: 200, width: 100, height: 50 }, vp, canvas, size).hidden, true)
  assert.equal(calloutPlacement({ x: 300, y: -80, width: 100, height: 50 }, vp, canvas, size).hidden, true)
  assert.equal(calloutPlacement({ x: 760, y: 200, width: 100, height: 50 }, vp, canvas, size).hidden, false, 'partly visible stays')
  const zoomed = calloutPlacement({ x: 100, y: 100, width: 100, height: 50 }, { x: 10, y: 20, zoom: 2 }, canvas, size)
  assert.deepEqual([zoomed.left, zoomed.top], [210, 148])
})

test('viewingPayload', () => {
  assert.deepEqual(viewingPayload({ mode: 'explore', view: 'turn', step: 2, selected: 'app', highlight: { focus: ['gw'], edges: [], note: 'n' } }), { mode: 'explore', view: 'turn', step: 2, selected: 'app', focus: ['gw'], edges: [], note: 'n' })
  assert.deepEqual(viewingPayload({ mode: 'present', view: 'index', step: 0, tour: 'auto', slide: 0 }), { mode: 'present', view: 'index', step: null, selected: null, focus: [], edges: [], note: null, tour: 'auto', slide: 1 })
})

test('askPrompt: element + code links, dynamic step, view only', () => {
  const data = {
    elements: { 'app.graph': { id: 'app.graph', title: 'Agent graph', links: [{ url: '/src/graph/agent.py', kind: 'code', path: 'src/graph/agent.py', line: 12 }, { url: 'https://x.dev', kind: 'web' }] }, user: { title: 'Operator' }, 'app.api': { title: 'API' } },
    views: { inside: view, turn: { id: 'turn', _type: 'dynamic', title: 'Chat turn', nodes: [], edges: [{ id: 'step-01', source: 'user', target: 'app.api', label: 'send' }] } },
  }
  assert.equal(askPrompt(data, { view: 'inside', fqn: 'app.graph' }), 'In the Atlas view "Inside", tell me about Agent graph (app.graph) — how it works and where it lives in the code. Code links: src/graph/agent.py:12.')
  assert.equal(askPrompt(data, { view: 'turn', fqn: 'user', step: 1 }), 'In the Atlas view "Chat turn", tell me about Operator (user) — how it works and where it lives in the code. We\'re at step 1: Operator → API "send".')
  assert.match(askPrompt(data, { view: 'turn' }), /walk me through what this view shows/)
  assert.ok(new TextEncoder().encode(askPrompt(data, { view: 'inside', fqn: 'app.graph' })).length <= 4096)
})

test('hostSupportsCompose', () => {
  assert.equal(hostSupportsCompose('0.205.0'), false)
  assert.equal(hostSupportsCompose('0.206.0'), true)
  assert.equal(hostSupportsCompose('1.0.0'), true)
  assert.equal(hostSupportsCompose(undefined), false, 'unknown version → hidden')
  assert.equal(hostSupportsCompose('dev'), false)
})

test('exploreShowPlan: a step AND a highlight/callout — the highlight is kept for after the step', () => {
  const both = exploreShowPlan({ view: 'turn', step: 2, focus: ['app.api'], edges: [], note: 'Here.' })
  assert.deepEqual(both, { step: 2, highlight: { view: 'turn', focus: ['app.api'], edges: [], note: 'Here.' }, fit: false })
  assert.deepEqual(exploreShowPlan({ view: 'turn', step: 3, focus: [], edges: [] }), { step: 3, highlight: null, fit: false })
  assert.deepEqual(exploreShowPlan({ view: 'index', focus: [], edges: [] }), { step: undefined, highlight: null, fit: true })
  assert.equal(exploreShowPlan({ view: 'index', focus: ['a'], edges: [] }).fit, false)
})

test('exact bus topics', () => {
  assert.equal(SHOW_TOPIC, 'atlas.show')
  assert.equal(CLEAR_TOPIC, 'atlas.clear')
})

test('toursFor always offers the auto tour, even next to file tours', () => {
  const ids = toursFor({ tours: [{ id: 'mine', slides: [{ view: 'inside' }] }] }, { elements: {}, views: { index: { id: 'index', _type: 'element', nodes: [] }, inside: view } }).map((t) => t.id)
  assert.deepEqual(ids, ['mine', 'auto'])
})

import { legibleFrame, legibleFlags, LEGIBLE } from '../src/logic.mjs'

test('legibleFrame: scale text first, then crop to the densest window', () => {
  const stage = { width: 1150, height: 712 }
  const small = { bounds: { x: 0, y: 0, width: 800, height: 500 }, nodes: [] }
  assert.deepEqual(legibleFrame(small, stage, 56).cropped, false)
  assert.equal(legibleFrame(small, stage, 56).k, 1, 'already legible → untouched')
  const mid = { bounds: { x: 0, y: 0, width: 2200, height: 1200 }, nodes: [] } // zFit ≈ 0.47
  const m = legibleFrame(mid, stage, 56)
  assert.ok(m.k > 1 && m.k <= LEGIBLE.kMax && !m.cropped)
  assert.ok(19.2 * m.k * m.zoom >= 12 - 1e-6)
  assert.ok(14 * m.ke * m.zoom >= 9 - 1e-6, 'edge labels reach 9 px')
  // a wide flow: 10 nodes in a row, plus 3 stacked near x = 3000 (the densest region)
  const nodes = [...Array(10)].map((_, i) => ({ id: `n${i}`, x: i * 600, y: 0, width: 320, height: 180 }))
  nodes.push(...[1, 2, 3].map((j) => ({ id: `d${j}`, x: 3000, y: j * 250, width: 320, height: 180 })))
  const wide = { bounds: { x: 0, y: 0, width: 5720, height: 930 }, nodes }
  const w = legibleFrame(wide, stage, 56)
  assert.ok(w.cropped && 19.2 * w.k * w.zoom >= 11.99, JSON.stringify(w))
  assert.ok(w.box.x >= 0 && w.box.x + w.box.width <= 5720 + 1e-6)
  assert.ok(w.box.x <= 3000 && w.box.x + w.box.width >= 3320, 'the densest column is in frame')
  // the window is taller than the view → centred vertically on it, not pushed off one edge
  assert.ok(Math.abs(w.box.y + w.box.height / 2 - 465) < 1, JSON.stringify(w.box))
})

test('legibleFlags', () => {
  assert.deepEqual(legibleFlags(1.6, 0.4), { hideDesc: true, hideEdgeLabels: false }) // 14 × 1.6 × .4 = 8.96 ≈ 9
  assert.deepEqual(legibleFlags(1, 0.4), { hideDesc: true, hideEdgeLabels: true })
  assert.deepEqual(legibleFlags(1.6, 0.9), { hideDesc: false, hideEdgeLabels: false })
})

import { textVisFor, visInit, visReduce } from '../src/logic.mjs'

test('text visibility: decided from the TARGET zoom, frozen during the move, hysteresis for live zoom', () => {
  const ke = 1.6
  // the destination decides, before the move — a zoom-in to 1.0 shows descriptions from frame 1
  let s = visInit(ke, 0.4)
  assert.deepEqual([s.hideDesc, s.hideEdgeLabels], [true, false])
  s = visReduce(s, { type: 'target', ke, zoom: 1.0, until: Infinity })
  assert.deepEqual([s.hideDesc, s.fade], [false, false])
  // mid-move the camera passes through small zooms: nothing changes while frozen
  for (const z of [0.45, 0.5, 0.7, 0.9]) assert.equal(visReduce(s, { type: 'live', ke, zoom: z, now: 1, settled: true }), s)
  s = visReduce(s, { type: 'release', now: 10 })
  assert.equal(s.frozenUntil, 10)
  // a zoom-OUT move decides "hidden" up front — descriptions never flash on the way out either
  const out = visReduce(s, { type: 'target', ke, zoom: 0.4, until: 500 })
  assert.equal(out.hideDesc, true)
  assert.equal(visReduce(out, { type: 'live', ke, zoom: 0.9, now: 100, settled: true }), out, 'frozen until 500')
  // a parent layer of a synced transition just keeps what it had
  const parent = visReduce(visInit(ke, 0.4), { type: 'freeze' })
  assert.equal(visReduce(parent, { type: 'live', ke, zoom: 2, now: 1e9, settled: true }), parent)
})

test('live (user) zoom: settled only, hysteresis, fades', () => {
  const ke = 1
  let s = visInit(ke, 0.5) // desc 7.1 px → hidden
  assert.equal(s.hideDesc, true)
  assert.equal(visReduce(s, { type: 'live', ke, zoom: 0.7, now: 1, settled: false }), s, 'mid-gesture: no change')
  // 9 px needs zoom ≥ .633 to hide→show… plus 10 % hysteresis → ≥ .697
  assert.equal(visReduce(s, { type: 'live', ke, zoom: 0.66, now: 1, settled: true }).hideDesc, true)
  s = visReduce(s, { type: 'live', ke, zoom: 0.72, now: 1, settled: true })
  assert.deepEqual([s.hideDesc, s.fade], [false, true])
  // shown → hides only below the plain threshold (.633)
  assert.equal(visReduce(s, { type: 'live', ke, zoom: 0.65, now: 2, settled: true }), s)
  assert.equal(visReduce(s, { type: 'live', ke, zoom: 0.6, now: 2, settled: true }).hideDesc, true)
})

test('textVisFor at the exact legible threshold stays shown (float noise)', () => {
  assert.equal(textVisFor(9 / (14 * 0.39), 0.39).hideEdgeLabels, false)
})

test('calloutPlacement keeps the other lit nodes clear: below the anchor, else a canvas edge', () => {
  const vp = { x: 0, y: 0, zoom: 1 }
  const canvas = { width: 360, height: 800 }
  const size = { width: 340, height: 80 }
  const anchor = { x: 40, y: 400, width: 100, height: 60 }
  // a lit node right above the anchor: the callout goes below instead
  const above = { x: 200, y: 320, width: 100, height: 60 }
  const p = calloutPlacement(anchor, vp, canvas, size, 12, 8, [above])
  assert.equal(p.side, 'below')
  assert.ok(p.top >= 472)
  // lit nodes above AND below: the canvas edge that covers none of them
  const below = { x: 200, y: 480, width: 100, height: 60 }
  const q = calloutPlacement(anchor, vp, canvas, size, 12, 8, [above, below])
  assert.equal(q.side, 'edge')
  assert.ok(q.top === 8 || q.top === 800 - 80 - 8)
  // nothing to avoid: unchanged
  assert.equal(calloutPlacement(anchor, vp, canvas, size).side, 'above')
})

test('show replay on mount (#11): fresh + newer only; the bus dedupes by show_seq', async () => {
  const { replayAction, alreadyApplied, SHOW_REPLAY_MS } = await import('../src/logic.mjs')
  const show = { seq: 3, kind: 'show', data: { view: 'index', show_seq: 3 }, age_ms: 900, fresh_ms: 15000 }
  assert.equal(replayAction(show, 0), 'show') // a show published just before this view mounted
  assert.equal(replayAction({ ...show, kind: 'clear' }, 0), 'clear')
  assert.equal(replayAction(show, 3), null) // already applied (it came on the bus first)
  assert.equal(replayAction({ ...show, age_ms: 15001 }, 0), null) // stale: never resurrect an old show
  assert.equal(replayAction({ ...show, fresh_ms: undefined, age_ms: SHOW_REPLAY_MS + 1 }, 0), null)
  assert.equal(replayAction(null, 0), null)
  assert.equal(replayAction({ ...show, kind: 'nope' }, 0), null)
  // the bus: a frame whose show_seq the replay already applied is dropped; older backends (no seq) pass
  assert.equal(alreadyApplied({ show_seq: 3 }, 3), true)
  assert.equal(alreadyApplied({ show_seq: 4 }, 3), false)
  assert.equal(alreadyApplied({ view: 'index' }, 3), false)
})
