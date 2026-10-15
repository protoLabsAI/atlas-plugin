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
  assert.deepEqual(calloutPlacement({ x: 300, y: 200, width: 100, height: 50 }, vp, canvas, size), { left: 250, top: 128, side: 'above', arrowX: 100 })
  const top = calloutPlacement({ x: 300, y: 10, width: 100, height: 50 }, vp, canvas, size)
  assert.equal(top.side, 'below')
  assert.equal(top.top, 72)
  const edge = calloutPlacement({ x: 750, y: 200, width: 100, height: 50 }, vp, canvas, size)
  assert.equal(edge.left, 592, 'clamped inside the canvas')
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
