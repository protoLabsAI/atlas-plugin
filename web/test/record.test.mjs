import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slideDwellMs, stepDwellMs, words, parseDeepLink, END_HOLD_MS, CAPTION_FADE_MS, BEAT_MS, outroMs, toursFor, cleanTitle } from '../src/logic.mjs'

test('dwell model (pinned to record.py — see tests/test_record.py)', () => {
  assert.equal(words('The **graph** owns `the` loop.'), 5)
  assert.equal(slideDwellMs({ note: '' }), 2500, 'minimum')
  assert.equal(slideDwellMs({ note: 'one two three four five six seven eight nine ten' }), 3800)
  assert.equal(slideDwellMs({ note: 'x', hold_ms: 7000 }), 7000)
  assert.equal(slideDwellMs({ note: 'w '.repeat(200) }), 15000, 'capped')
  assert.equal(stepDwellMs('POST chat'), 1800)
  assert.equal(stepDwellMs('one two three four five six'), 2560)
  assert.deepEqual([END_HOLD_MS, CAPTION_FADE_MS, BEAT_MS, outroMs(), outroMs(0)], [2500, 400, 2000, 4900, 2400])
})

test('parseDeepLink', () => {
  assert.deepEqual(parseDeepLink('#tour=overview&slide=2&present=1&autoplay=1&record=1'), { present: true, autoplay: true, record: true, tour: 'overview', slide: 2, focus: [] })
  assert.deepEqual(parseDeepLink('#view=index&focus=a,b&step=3'), { present: false, autoplay: false, record: false, view: 'index', step: 3, focus: ['a', 'b'] })
  assert.equal(parseDeepLink('#record=1'), null, 'needs a tour or a view')
  assert.equal(parseDeepLink(''), null)
  assert.equal(parseDeepLink('#section-2'), null, 'a plain anchor is not a deep link')
  assert.equal(parseDeepLink('#tour=auto&record=1').autoplay, true, 'record implies autoplay + present')
})

test('hold_ms survives toursFor (validated 500–60000) — the viewer dwells what record.py plans', () => {
  const data = { elements: {}, views: { index: { id: 'index', _type: 'element', nodes: [] } } }
  const [t] = toursFor({ tours: [{ id: 't', slides: [{ view: 'index', hold_ms: 20000 }, { view: 'index', hold_ms: 5 }, { view: 'index', hold_ms: '9000' }] }] }, data)
  assert.deepEqual(t.slides.map((s) => s.hold_ms), [20000, undefined, undefined])
  assert.equal(slideDwellMs(t.slides[0]), 20000)
})

test('cleanTitle (menu names the recorder matches exactly)', () => {
  assert.equal(cleanTitle('A\u2028walk\u0085 \n through'), 'A walk through')
  assert.equal(cleanTitle(''), 'Tour')
})

test('end_hold_ms survives toursFor (0–30000)', () => {
  const data = { elements: {}, views: { index: { id: 'index', _type: 'element', nodes: [] } } }
  const [t] = toursFor({ tours: [{ id: 't', end_hold_ms: 6000, slides: [{ view: 'index' }] }] }, data)
  assert.equal(t.end_hold_ms, 6000)
  assert.equal(toursFor({ tours: [{ id: 't', end_hold_ms: 99999, slides: [{ view: 'index' }] }] }, data)[0].end_hold_ms, undefined)
})
