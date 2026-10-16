import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { frameSlide, safeRect, contentBox } from '../src/framing.mjs'

const n = (id, x, y, w = 320, h = 180) => ({ id, x, y, width: w, height: h })
const canvas = { width: 1280, height: 720 }
const insets = { top: 56, bottom: 150 }

// screen geometry of a node under a viewport
const scr = (nd, vp) => ({ x: nd.x * vp.zoom + vp.x, y: nd.y * vp.zoom + vp.y, x2: (nd.x + nd.width) * vp.zoom + vp.x, y2: (nd.y + nd.height) * vp.zoom + vp.y })
function assertFramed(view, f, label = '', centreOn = null) {
  const S = safeRect(canvas, insets)
  const S2 = { x2: S.x + S.width, y2: S.y + S.height }
  const shown = []
  for (const nd of view.nodes.filter((x) => !x.children?.length)) {
    const r = scr(nd, f.vp)
    const fullyIn = r.x >= S.x - 1 && r.y >= S.y - 1 && r.x2 <= S2.x2 + 1 && r.y2 <= S2.y2 + 1
    const fullyOut = r.x2 <= 0 || r.y2 <= 0 || r.x >= canvas.width || r.y >= canvas.height
    assert.ok(fullyIn || fullyOut, `${label}: ${nd.id} is partly visible ${JSON.stringify(r)}`)
    if (fullyIn && (!centreOn || centreOn.includes(nd.id))) shown.push(r)
  }
  assert.ok(shown.length > 0, `${label}: nothing shown`)
  // containers (compounds) that are wholly on screen are content too
  if (!centreOn)
    for (const nd of view.nodes.filter((x) => x.children?.length)) {
      const r = scr(nd, f.vp)
      if (r.x >= S.x - 1 && r.y >= S.y - 1 && r.x2 <= S2.x2 + 1 && r.y2 <= S2.y2 + 1) shown.push(r)
    }
  const cx = (Math.min(...shown.map((r) => r.x)) + Math.max(...shown.map((r) => r.x2))) / 2
  const cy = (Math.min(...shown.map((r) => r.y)) + Math.max(...shown.map((r) => r.y2))) / 2
  assert.ok(Math.abs(cx - (S.x + S.width / 2)) <= S.width * 0.05 + 1, `${label}: off-centre x ${cx}`)
  assert.ok(Math.abs(cy - (S.y + S.height / 2)) <= S.height * 0.05 + 1, `${label}: off-centre y ${cy}`)
}

test('safeRect: measured chrome + caption, 4 % sides', () => {
  assert.deepEqual(safeRect(canvas, insets), { x: 51, y: 56, width: 1178, height: 514 })
  assert.deepEqual(safeRect(canvas, {}).y, 29, 'at least 4 % top / bottom')
})

test('a small view: the whole view, centred in the safe rect', () => {
  const v = { bounds: { x: 0, y: 0, width: 1000, height: 400 }, nodes: [n('a', 0, 0), n('b', 680, 220)], edges: [] }
  const f = frameSlide(v, canvas, insets)
  assert.equal(f.cropped, false)
  assertFramed(v, f, 'small')
})

test('a view above the title floor: the WHOLE view, never a subset', () => {
  const nodes = [...Array(7)].map((_, i) => n(`s${i}`, i * 560, (i % 3) * 260))
  const v = { bounds: { x: 0, y: 0, width: 6 * 560 + 320, height: 700 }, nodes, edges: [] }
  const f = frameSlide(v, canvas, insets, { named: ['s0'] })
  assert.equal(f.cropped, false)
  assert.equal(f.visible.length, 7)
  assertFramed(v, f, 'whole')
})

test('below the title floor: the caption-named nodes (whole, centred); unnamed → still the whole view', () => {
  const nodes = [...Array(14)].map((_, i) => n(`s${i}`, i * 560, (i % 3) * 260))
  const edges = nodes.slice(1).map((m, i) => ({ id: `e${i}`, source: nodes[i].id, target: m.id }))
  const v = { bounds: { x: 0, y: 0, width: 13 * 560 + 320, height: 700 }, nodes, edges }
  const f = frameSlide(v, canvas, insets, { named: ['s3', 's4', 's5', 's6', 's7', 's8', 's9'] })
  assert.ok(f.cropped && f.partial.length === 0 && f.visible.includes('s6') && f.visible.includes('s7'), JSON.stringify(f))
  assertFramed(v, f, 'named')
  // naming one element (or under half the view) never narrows to it: the whole view, at the floor
  for (const named of [['s6'], ['s6', 's7']]) assert.equal(frameSlide(v, canvas, insets, { named }).visible.length, 14, named.join())
  const g = frameSlide(v, canvas, insets)
  assert.equal(g.visible.length, 14)
})

test('a subject (a step\'s two ends) with neighbours close by', () => {
  const nodes = [n('a', 0, 0), n('b', 500, 0), n('c', 1000, 0), n('d', -500, 0), n('e', 500, 300)]
  const edges = [{ id: 'step-01', source: 'a', target: 'b', labelBBox: { x: 340, y: 60, width: 120, height: 20 } }]
  const v = { bounds: { x: -500, y: 0, width: 1820, height: 480 }, nodes, edges }
  const f = frameSlide(v, canvas, insets, { subject: ['a', 'b'] })
  assert.ok(f.visible.includes('a') && f.visible.includes('b'))
  assert.equal(f.partial.length, 0, JSON.stringify(f))
  assert.deepEqual(contentBox(v, ['a', 'b']), { x: 0, y: 0, x2: 820, y2: 180 })
})

// every view of the shipped example, through the real engine's layout
test('the example model: every view frames with no partial node, centred', { timeout: 60000 }, () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const out = JSON.parse(execFileSync(process.execPath, [`${root}vendor/atlas-engine.mjs`, 'export', `${root}examples/protoagent`], { maxBuffer: 64 << 20 }))
  for (const [id, v] of Object.entries(out.model.views)) {
    const f = frameSlide(v, canvas, insets)
    assertFramed(v, f, id)
    // and each node as a focus subject
    for (const nd of v.nodes.filter((x) => !x.children?.length).slice(0, 3)) {
      const g = frameSlide(v, canvas, insets, { subject: [nd.id] })
      assert.ok(g.visible.includes(nd.id), `${id}/${nd.id} focus not shown`)
      assertFramed(v, g, `${id} focus ${nd.id}`)
    }
  }
})

test('the example model under many canvases / chrome sizes: never a partial node', { timeout: 120000 }, () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const out = JSON.parse(execFileSync(process.execPath, [`${root}vendor/atlas-engine.mjs`, 'export', `${root}examples/protoagent`], { maxBuffer: 64 << 20 }))
  for (const ins of [{ top: 30, bottom: 60 }, { top: 46, bottom: 127 }, { top: 70, bottom: 200 }])
    for (const c of [{ width: 1280, height: 720 }, { width: 1150, height: 712 }, { width: 900, height: 600 }])
      for (const [id, v] of Object.entries(out.model.views)) {
        const f = frameSlide(v, c, ins)
        assert.deepEqual(f.partial, [], `${id} ${JSON.stringify(ins)} ${JSON.stringify(c)}`)
        // no caption names → the subject is the whole view: every leaf shown
        assert.equal(f.visible.length, v.nodes.filter((x) => !x.children?.length && x.width > 0).length, `${id} incomplete ${JSON.stringify(c)}`)
        for (const nd of v.nodes.filter((x) => !x.children?.length))
          assert.deepEqual(frameSlide(v, c, ins, { subject: [nd.id] }).partial, [], `${id} focus ${nd.id} ${JSON.stringify(ins)} ${JSON.stringify(c)}`)
      }
})

test('below the floor, a caption-named CONTAINER is framed whole (border and title), with its leaves', () => {
  const leaves = [...Array(10)].map((_, i) => n(`p.s${i}`, 100, 100 + i * 400))
  const p = { id: 'p', x: 60, y: 40, width: 400, height: 10 * 400 + 40, children: leaves.map((x) => x.id) }
  const far = n('far', 100, -900)
  const v = { bounds: { x: 60, y: -900, width: 400, height: 4980 }, nodes: [p, ...leaves, far], edges: [] }
  const f = frameSlide(v, canvas, insets, { named: ['p'] })
  const S = safeRect(canvas, insets)
  const r = scr(p, f.vp)
  assert.ok(f.cropped)
  assert.ok(r.y >= S.y - 1 && r.y2 <= S.y + S.height + 1, `container cut: ${JSON.stringify(r)}`)
  assert.ok(leaves.every((x) => f.visible.includes(x.id)) && !f.visible.includes('far'))
})

test('a narrow panel (the 360 px right dock): a step / focus subject is never cut to make it legible', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const out = JSON.parse(execFileSync(process.execPath, [`${root}vendor/atlas-engine.mjs`, 'export', `${root}examples/protoagent`], { maxBuffer: 64 << 20 }))
  const v = out.model.views.chat_turn_flow
  for (const c of [{ width: 360, height: 700 }, { width: 520, height: 700 }])
    for (const e of v.edges.filter((x) => /^step-/.test(x.id))) {
      const f = frameSlide(v, c, { top: 40, bottom: 160 }, { subject: [e.source, e.target] })
      assert.ok(f.visible.includes(e.source) && f.visible.includes(e.target), `${c.width} ${e.id}: ${f.visible.join(',')}`)
    }
})
