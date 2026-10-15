import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPalette, paletteContrast, paletteCss, contrast, readable, ensureContrast, mix, hex, parseHex, LIKEC4_COLORS } from '../src/palette.mjs'

const P = (h) => parseHex(h)
// the DS defaults (plugin-kit.css dark) and the console's [data-theme=light] block
const DARK = { bg: P('#0a0a0c'), raised: P('#131316'), fg: P('#ededed'), muted: P('#a1a1aa'), accent: P('#9b87f2'), onAccent: P('#0a0a0c'), error: P('#f87171'), success: P('#4ade80'), warning: P('#fbbf24'), info: P('#60a5fa'), indigo: P('#6366f1') }
const LIGHT = { bg: P('#f6f7f9'), raised: P('#ffffff'), fg: P('#18181b'), muted: P('#52525b'), accent: P('#6164ef'), onAccent: P('#ffffff'), error: P('#dc2626'), success: P('#16a34a'), warning: P('#d97706'), info: P('#2563eb'), indigo: P('#4f46e5') }

test('colour math', () => {
  assert.equal(hex(mix([0, 0, 0], [255, 255, 255], 0.5)), '#808080')
  assert.deepEqual(parseHex('#abc'), [170, 187, 204])
  assert.equal(parseHex('nope'), null)
  assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21)
  assert.deepEqual(readable([255, 255, 255], [[250, 250, 250]]), [0, 0, 0], 'falls back to black/white')
  assert.ok(contrast(ensureContrast([120, 120, 120], [128, 128, 128]), [128, 128, 128]) >= 4.5)
})

for (const [name, tokens, scheme] of [['dark', DARK, 'dark'], ['light', LIGHT, 'light']]) {
  test(`every LikeC4 colour is mapped with text ≥ 4.5:1 (${name})`, () => {
    const p = buildPalette(tokens, scheme)
    assert.deepEqual(Object.keys(p.colors), LIKEC4_COLORS)
    assert.deepEqual(p.colors.primary.elements.fill, tokens.accent, 'primary = the DS accent')
    assert.deepEqual(p.colors.red.elements.fill, tokens.error, 'red = status-error')
    const c = paletteContrast(p)
    assert.ok(c.min >= 4.5, JSON.stringify(c.where.filter((w) => w[2] < 4.5)))
  })
}

test('custom brand accents stay readable (very light, very dark, mid)', () => {
  for (const accent of ['#fde047', '#1e1b4b', '#e11d48', '#22d3ee', '#808080']) {
    for (const [base, scheme] of [[DARK, 'dark'], [LIGHT, 'light']]) {
      const p = buildPalette({ ...base, accent: P(accent), onAccent: undefined }, scheme)
      assert.ok(paletteContrast(p).min >= 4.5, `${accent} ${scheme}`)
    }
  }
})

test('missing tokens fall back, never throw', () => {
  const p = buildPalette({}, 'dark')
  assert.ok(paletteContrast(p).min >= 4.5)
})

test('css: !important palette per colour + compounds + chrome from --pl-* vars', () => {
  const css = paletteCss(buildPalette(DARK, 'dark'))
  assert.match(css, /\[data-likec4-color="primary"\]\{--likec4-palette-fill:#9b87f2 !important/)
  assert.match(css, /\[data-likec4-color="red"\]\[data-compound-depth="1"\]/)
  assert.match(css, /--mantine-color-body:var\(--pl-color-bg-raised\) !important/)
  assert.doesNotMatch(css, /#3b82f6/, 'no LikeC4 default blue left')
})
