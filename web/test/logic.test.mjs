import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keyOwner, presenterOwns,
  autoTour, toursFor, cleanTours, tourArray, normaliseLink, normaliseLinks, resolveProject, codeOpenMessage,
  presenterKey, cycle, slideForView, parseShow, parentView, viewChain, searchModel, viewForElement,
  keepView, viewOptions, mdLight, schemeForRgb, interpolateZoom, fitBox, errorFileRel, elementOrder, safeRelPath,
} from '../src/logic.mjs'

// A small layouted-model `$data` shaped like the engine's export.
const n = (id, extra = {}) => ({ id, x: 0, y: 0, width: 100, height: 60, ...extra })
const data = {
  elements: {
    user: { id: 'user', kind: 'actor', title: 'Operator' },
    app: { id: 'app', kind: 'system', title: 'protoAgent', summary: { txt: 'Agent runtime' } },
    'app.server': { id: 'app.server', kind: 'container', title: 'API Server', technology: 'FastAPI' },
    'app.server.chat': { id: 'app.server.chat', kind: 'component', title: 'Chat' },
    'app.graph': { id: 'app.graph', kind: 'container', title: 'Agent graph', technology: 'LangGraph' },
    gateway: { id: 'gateway', kind: 'system', title: 'LLM gateway' },
  },
  views: {
    index: { id: 'index', _type: 'element', title: 'Landscape', nodes: [n('user'), n('app', { navigateTo: 'app_detail' }), n('gateway')], edges: [] },
    // declared BEFORE app_detail on purpose: tree order must win over declaration order
    graph_detail: { id: 'graph_detail', _type: 'element', title: 'Graph', viewOf: 'app.graph', nodes: [n('app.graph')], edges: [] },
    app_detail: { id: 'app_detail', _type: 'element', title: 'Inside', viewOf: 'app', nodes: [n('app'), n('app.server', { navigateTo: 'server_detail' }), n('app.graph')], edges: [] },
    server_detail: { id: 'server_detail', _type: 'element', title: 'Server', viewOf: 'app.server', nodes: [n('app.server.chat')], edges: [] },
    turn: { id: 'turn', _type: 'dynamic', title: 'Chat turn', nodes: [n('user'), n('app.server.chat')], edges: [{ id: 'step-02', label: 'reply' }, { id: 'step-01', label: 'ask' }] },
  },
}

test('elementOrder is depth-first, parents before children', () => {
  assert.deepEqual([...elementOrder(data).keys()], ['user', 'app', 'app.server', 'app.server.chat', 'app.graph', 'gateway'])
})

test('autoTour: index, scoped views in tree order, then dynamic views (matches backend lint.auto_tour)', () => {
  const t = autoTour(data)
  assert.deepEqual(t.map((s) => s.view), ['index', 'app_detail', 'server_detail', 'graph_detail', 'turn'])
  assert.equal(t[4].step, undefined, 'dynamic slide is the whole view; the presenter walks its steps')
  assert.match(t[0].note, /Landscape/)
  // graph_detail has no drill-in node → it zooms through app.graph from the previous slide's view? (server_detail lacks it)
  assert.equal(t[3].via, undefined)
})

test('autoTour adds `via` when the previous view holds the scope element', () => {
  const d = structuredClone(data)
  delete d.views.server_detail
  d.views.app_detail.nodes[1].navigateTo = undefined
  const t = autoTour(d)
  assert.deepEqual(t.map((s) => s.view), ['index', 'app_detail', 'graph_detail', 'turn'])
  assert.equal(t[2].via, 'app.graph')
})

test('autoTour without index / empty', () => {
  const d = structuredClone(data)
  delete d.views.index
  assert.equal(autoTour(d)[0].view, 'app_detail')
  assert.deepEqual(autoTour({ views: {} }), [])
})

test('toursFor: API tours (doc or list) validated, else auto', () => {
  const doc = { tours: [{ id: 'o', title: 'Overview', slides: [{ view: 'index', focus: 'app', note: 'hi' }, { view: 'nope' }, { view: 'turn', step: 2 }, { view: 'turn', step: 9 }] }] }
  assert.equal(tourArray(doc).length, 1)
  const t = toursFor(doc, data)
  assert.deepEqual(t.map((x) => x.id), ['o', 'auto'], 'the auto tour always follows')
  assert.deepEqual(t[0].slides.map((s) => [s.view, s.step, s.focus]), [['index', undefined, 'app'], ['turn', 2, undefined], ['turn', undefined, undefined]])
  assert.equal(toursFor(doc.tours, data)[0].id, 'o')
  const auto = toursFor(null, data)
  assert.equal(auto[0].id, 'auto')
  assert.equal(auto[0].slides.length, 5)
  assert.deepEqual(cleanTours([{ id: 'x', slides: [{ view: 'nope' }] }], data), [])
})

test('normaliseLink: backend-normalised shapes', () => {
  assert.deepEqual(normaliseLink({ url: '/src/a.py#L3', title: 'Src', kind: 'code', path: 'src/a.py', line: 3, end_line: 9 }), { kind: 'code', title: 'Src', url: '/src/a.py#L3', path: 'src/a.py', line: 3, endLine: 9 })
  assert.equal(normaliseLink({ url: 'https://x.dev', kind: 'web' }).kind, 'web')
  // backend marks escapes `invalid` / other schemes `other` → never a code link
  assert.equal(normaliseLink({ url: '/../../etc/passwd', kind: 'invalid', error: 'outside' }).kind, 'other')
  assert.equal(normaliseLink({ url: 'vscode://file/x', kind: 'other' }).kind, 'other')
  assert.equal(normaliseLink({ url: '/looks/fine.py', kind: 'invalid', error: 'outside the project' }).kind, 'other', 'a symlink escape stays refused')
  assert.equal(normaliseLink({ kind: 'code', path: '../x', url: '' }), null)
  assert.equal(normaliseLink({ kind: 'code', path: '../x', url: '/x' }).kind, 'other')
})

test('normaliseLink: raw LikeC4 links (fallback)', () => {
  assert.deepEqual(normaliseLink({ url: '/src/graph/agent.py#L10-L20', title: 'Agent' }), { kind: 'code', title: 'Agent', url: '/src/graph/agent.py#L10-L20', path: 'src/graph/agent.py', line: 10, endLine: 20 })
  assert.deepEqual(normaliseLink('/README.md'), { kind: 'code', title: 'README.md', url: '/README.md', path: 'README.md', line: undefined, endLine: undefined })
  assert.equal(normaliseLink({ url: 'https://likec4.dev' }).kind, 'web')
  assert.equal(normaliseLink({ url: 'mailto:a@b' }).kind, 'other')
  assert.equal(normaliseLink({ url: '/a/../../etc' }).kind, 'other')
  assert.equal(normaliseLink({ url: '/x.py#L9-L3' }).endLine, undefined)
  assert.equal(normaliseLink(null), null)
  assert.equal(normaliseLinks([{ url: '/a' }, null, { title: 'no url' }]).length, 1)
  assert.equal(safeRelPath('~/x'), null)
  assert.equal(safeRelPath('./a//b'), 'a/b')
})

test('resolveProject: explicit project, fs roots match, nested root, basename fallback', () => {
  assert.deepEqual(resolveProject({ project: 'app', project_root: '/r' }, null, 'a.py'), { project: 'app', path: 'a.py' })
  const roots = { other: '/x', proto: '/home/op/protoAgent/' }
  assert.deepEqual(resolveProject({ project_root: '/home/op/protoAgent' }, roots, 'a.py'), { project: 'proto', path: 'a.py' })
  assert.deepEqual(resolveProject({ project_root: '/home/op/protoAgent/sub' }, roots, 'a.py'), { project: 'proto', path: 'sub/a.py' })
  assert.deepEqual(resolveProject({ project_root: '/srv/thing' }, roots, 'a.py'), { project: 'thing', path: 'a.py' })
  assert.equal(resolveProject({}, roots, 'a.py'), null)
})

test('codeOpenMessage shape matches the console parser', () => {
  const link = normaliseLink({ url: '/a.py#L4-L6' })
  assert.deepEqual(codeOpenMessage({ project: 'p', path: 'a.py' }, link, 'Server'), { type: 'protoagent:code:open', project: 'p', path: 'a.py', line: 4, end_line: 6, note: 'Server' })
  assert.deepEqual(codeOpenMessage({ project: 'p', path: 'a.py' }, normaliseLink('/a.py'), ''), { type: 'protoagent:code:open', project: 'p', path: 'a.py' })
  assert.equal(codeOpenMessage(null, link), null)
  assert.equal(codeOpenMessage({ project: 'p', path: 'x' }, normaliseLink('https://x.dev')), null)
})

test('errorFileRel', () => {
  assert.equal(errorFileRel('architecture/model.c4', {}), 'architecture/model.c4')
  assert.equal(errorFileRel('/r/arch/m.c4', { project_root: '/r' }), 'arch/m.c4')
  assert.equal(errorFileRel('/elsewhere/m.c4', { project_root: '/r' }), null)
})

test('presenterKey: the keyboard state machine', () => {
  const ctx = { slide: 2, count: 5 }
  assert.deepEqual(presenterKey('ArrowRight', {}, ctx), { type: 'goto', index: 3 })
  assert.deepEqual(presenterKey(' ', {}, ctx), { type: 'goto', index: 3 })
  assert.deepEqual(presenterKey('ArrowLeft', {}, ctx), { type: 'goto', index: 1 })
  assert.deepEqual(presenterKey('ArrowRight', {}, { slide: 4, count: 5 }), { type: 'noop' })
  assert.deepEqual(presenterKey('ArrowLeft', {}, { slide: 0, count: 5 }), { type: 'noop' })
  assert.deepEqual(presenterKey('Enter', {}, ctx), { type: 'drill' })
  assert.deepEqual(presenterKey('Escape', {}, ctx), { type: 'up' })
  assert.deepEqual(presenterKey('.', {}, ctx), { type: 'focus', dir: 1 })
  assert.deepEqual(presenterKey(',', {}, ctx), { type: 'focus', dir: -1 })
  assert.equal(presenterKey('Tab', {}, ctx), null, 'Tab is the browser\'s')
  assert.deepEqual(presenterKey('n', {}, ctx), { type: 'notes' })
  assert.deepEqual(presenterKey('F', {}, ctx), { type: 'fullscreen' })
  assert.deepEqual(presenterKey('1', {}, ctx), { type: 'goto', index: 0 })
  assert.deepEqual(presenterKey('5', {}, ctx), { type: 'goto', index: 4 })
  assert.deepEqual(presenterKey('9', {}, ctx), { type: 'noop' })
  assert.deepEqual(presenterKey('3', {}, ctx), { type: 'noop' }, 'already there')
  assert.equal(presenterKey('ArrowRight', { metaKey: true }, ctx), null, 'host chords fall through')
  assert.equal(presenterKey('x', {}, ctx), null)
})

test('presenterKey walks a whole-dynamic-view slide before leaving it', () => {
  let ctx = { slide: 1, count: 3, steps: 2, step: 0 }
  assert.deepEqual(presenterKey('ArrowRight', {}, ctx), { type: 'step', step: 1 })
  ctx = { ...ctx, step: 2 }
  assert.deepEqual(presenterKey('ArrowRight', {}, ctx), { type: 'goto', index: 2 })
  assert.deepEqual(presenterKey('ArrowLeft', {}, ctx), { type: 'step', step: 1 })
  assert.deepEqual(presenterKey('ArrowLeft', {}, { ...ctx, step: 0 }), { type: 'goto', index: 0 })
})

test('cycle + slideForView', () => {
  assert.equal(cycle(['a', 'b', 'c'], 'c', 1), 'a')
  assert.equal(cycle(['a', 'b', 'c'], null, -1), 'c')
  assert.equal(cycle([], 'a', 1), null)
  const slides = [{ view: 'index' }, { view: 'turn', step: 1 }, { view: 'turn' }]
  assert.equal(slideForView(slides, 'turn'), 2)
  assert.equal(slideForView(slides, 'zzz'), 0)
})

test('parseShow (atlas.show bus payloads)', () => {
  const tours = toursFor(null, data)
  assert.deepEqual(parseShow({ view: 'turn', step: 2 }, data, tours), { kind: 'view', view: 'turn', step: 2, focus: [], edges: [], note: undefined, present: false })
  assert.deepEqual(parseShow({ view: 'index', focus: 'app', present: true }, data, tours), { kind: 'view', view: 'index', step: undefined, focus: ['app'], edges: [], note: undefined, present: true })
  // live navigation: many foci, edges, a callout; unknown ids dropped; a note needs an anchor
  const live = parseShow({ view: 'index', focus: ['app', 'ghost', 'gateway'], edges: ['nope'], note: ' Hi ' }, data, tours)
  assert.deepEqual([live.focus, live.edges, live.note], [['app', 'gateway'], [], 'Hi'])
  assert.equal(parseShow({ view: 'index', note: 'x' }, data, tours).note, undefined)
  assert.equal(parseShow({ view: 'nope' }, data, tours), null)
  assert.equal(parseShow({ view: 'turn', step: 7 }, data, tours).step, undefined)
  // slides are 1-based on the wire (atlas_show validates 1..len)
  assert.deepEqual(parseShow({ tour: 'auto', slide: 3 }, data, tours), { kind: 'tour', tour: 'auto', slide: 2, present: true })
  assert.deepEqual(parseShow({ tour: 'auto', slide: 99 }, data, tours).slide, 4)
  assert.equal(parseShow({ tour: 'missing', view: 'index' }, data, tours).kind, 'view')
  assert.equal(parseShow(null, data, tours), null)
})

test('parentView / viewChain / viewOptions', () => {
  assert.equal(parentView(data, 'app_detail'), 'index')
  assert.equal(parentView(data, 'server_detail'), 'app_detail')
  assert.equal(parentView(data, 'graph_detail'), 'app_detail', 'scoped view nobody links to → nearest view holding its element')
  assert.equal(parentView(data, 'turn'), 'index')
  assert.equal(parentView(data, 'index'), null)
  assert.deepEqual(viewChain(data, 'server_detail'), ['index', 'app_detail', 'server_detail'])
  assert.deepEqual(viewOptions(data).map((o) => [o.id, o.depth]), [['index', 0], ['app_detail', 1], ['graph_detail', 2], ['server_detail', 2], ['turn', 0]])
  const ids = viewOptions(data).map((o) => o.id)
  assert.equal(ids[0], 'index')
  assert.equal(ids.at(-1), 'turn')
  assert.equal(new Set(ids).size, 5)
})

test('search + viewForElement + keepView', () => {
  const hits = searchModel(data, 'serv')
  assert.deepEqual(hits.slice(0, 2).map((h) => h.id).sort(), ['app.server', 'server_detail'])
  assert.ok(searchModel(data, 'langgraph').some((h) => h.id === 'app.graph'), 'matches technology')
  assert.ok(searchModel(data, 'chat turn').some((h) => h.type === 'view' && h.id === 'turn'))
  assert.deepEqual(searchModel(data, ''), [])
  assert.deepEqual(viewForElement(data, 'app.server'), { view: 'app_detail', focus: 'app.server' })
  assert.deepEqual(viewForElement(data, 'app.server.chat'), { view: 'server_detail', focus: 'app.server.chat' })
  assert.deepEqual(viewForElement(data, 'app', 'index'), { view: 'index', focus: 'app' })
  assert.equal(keepView(data, 'turn'), 'turn')
  assert.equal(keepView(data, 'gone'), 'index')
})

test('mdLight is escaped markdown-light', () => {
  assert.equal(mdLight('a **b** *c* `<d>`'), '<p>a <strong>b</strong> <em>c</em> <code>&lt;d&gt;</code></p>')
  assert.equal(mdLight('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>')
  assert.equal(mdLight('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>')
  assert.match(mdLight('[docs](https://x.dev)'), /href="https:\/\/x.dev"/)
  assert.doesNotMatch(mdLight('[x](javascript:alert(1))'), /href/)
})

test('schemeForRgb', () => {
  assert.equal(schemeForRgb([10, 10, 12]), 'dark')
  assert.equal(schemeForRgb([255, 255, 255]), 'light')
  assert.equal(schemeForRgb([244, 244, 245]), 'light')
  assert.equal(schemeForRgb(null), 'dark')
})

test('interpolateZoom endpoints + fitBox', () => {
  const i = interpolateZoom(1)([0, 0, 100], [50, 20, 10])
  assert.deepEqual(i(0).map((v) => +v.toFixed(6)), [0, 0, 100])
  assert.deepEqual(i(1).map((v) => +v.toFixed(6)), [50, 20, 10])
  const same = interpolateZoom(1)([5, 5, 100], [5, 5, 50])
  assert.equal(+same(1)[2].toFixed(6), 50)
  const vp = fitBox({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 300, height: 300 }, 50)
  assert.equal(vp.zoom, 2)
  assert.deepEqual([vp.x, vp.y], [50, 100])
})

test('keyboard ownership: graph shortcuts never steal Tab / Enter / Space from controls', () => {
  const el = (tag, extra = {}) => ({ tag, role: null, editable: false, chrome: false, ...extra })
  // a button in the presenter chrome (Exit): native activation + Tab order
  const onButton = keyOwner([el('BUTTON'), el('DIV', { chrome: true }), el('BODY')])
  assert.equal(onButton, 'control')
  for (const k of ['Enter', ' ', 'Tab', 'ArrowRight', '1', 'n']) assert.equal(presenterOwns(k, onButton), false, k)
  assert.equal(presenterOwns('Escape', onButton), true, 'Escape still leaves (WCAG 2.1.2)')
  // a link / code ref (role=button) inside the notes
  assert.equal(keyOwner([el('CODE', { role: 'button' }), el('DIV'), el('ASIDE', { chrome: true })]), 'control')
  assert.equal(keyOwner([el('A'), el('P')]), 'control')
  // the tour <select>, an input, contenteditable: hands off entirely
  for (const p of [[el('SELECT')], [el('INPUT')], [el('DIV', { editable: true })]]) {
    assert.equal(keyOwner(p), 'editable')
    assert.equal(presenterOwns('Escape', 'editable'), false)
  }
  // anywhere in the chrome, even a plain div
  assert.equal(keyOwner([el('SPAN'), el('DIV', { chrome: true })]), 'control')
  // the diagram (an xyflow node is role=group inside the shadow root) / the page body: ours
  const onGraph = keyOwner([el('DIV', { role: 'group' }), el('DIV'), null, el('DIV'), el('BODY'), el('HTML')])
  assert.equal(onGraph, 'surface')
  for (const k of ['Enter', 'ArrowRight', '.', 'Escape']) assert.equal(presenterOwns(k, onGraph), true, k)
  assert.equal(presenterOwns('Tab', onGraph), false)
})
