// Atlas theming — pure. Maps the console's resolved DS tokens (--pl-*) onto LikeC4's
// per-color palette variables + its chrome variables, as one CSS text rendered INSIDE the
// diagram's shadow root (a <style> child of ReactLikeC4). LikeC4 emits its palette as
// `#<id> :is([data-likec4-color=x]) { --likec4-palette-*: <hex> }`; ours are `!important`,
// so they win without touching LikeC4, and a re-theme only re-renders this text (no remount,
// camera + view kept). Colours are computed (not var()) so every text/fill pair can be
// contrast-checked; chrome that needs no checking uses var(--pl-*) and re-themes by itself.

/** @typedef {[number, number, number]} RGB */

export const LIKEC4_COLORS = ['primary', 'secondary', 'muted', 'slate', 'gray', 'blue', 'indigo', 'sky', 'red', 'green', 'amber']

const clamp = (x) => Math.min(255, Math.max(0, Math.round(x)))
/** @returns {RGB} */
export const mix = (a, b, t) => [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t)]
export const hex = (c) => '#' + c.map((x) => clamp(x).toString(16).padStart(2, '0')).join('')
export function parseHex(s) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s ?? '').trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
export function luminance(c) {
  const lin = (v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]

/** The first candidate reaching `min` contrast on `bg`; else the best of candidates + black/white. */
export function readable(bg, candidates, min = 4.5) {
  for (const c of candidates) if (c && contrast(c, bg) >= min) return c
  return [...candidates.filter(Boolean), WHITE, BLACK].sort((p, q) => contrast(q, bg) - contrast(p, bg))[0]
}

/** Nudge `c` toward black/white (whichever separates it more from `bg`) until it reaches `min`. */
export function ensureContrast(c, bg, min = 4.5) {
  if (contrast(c, bg) >= min) return c
  const toward = contrast(WHITE, bg) > contrast(BLACK, bg) ? WHITE : BLACK
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const d = mix(c, toward, t)
    if (contrast(d, bg) >= min) return d
  }
  return toward
}

/**
 * Tokens (resolved RGB, any may be missing) → `{scheme, colors: {name: {elements, relationships}}}`.
 * `t` keys: bg, raised, subtle, fg, muted, accent, onAccent, error, success, warning, info, indigo, series[].
 */
export function buildPalette(t, scheme) {
  const dark = scheme !== 'light'
  const bg = t.bg ?? (dark ? [10, 10, 12] : [246, 247, 249])
  const fg = t.fg ?? (dark ? [237, 237, 237] : [24, 24, 27])
  const raised = t.raised ?? mix(bg, fg, 0.05)
  const muted = t.muted ?? mix(fg, bg, 0.35)
  const accent = t.accent ?? [155, 135, 242]
  const s = t.series ?? []
  /** base fill per LikeC4 colour — DS tokens where they exist, else derived from the accent */
  const base = {
    primary: accent,
    secondary: mix(raised, accent, dark ? 0.32 : 0.2), // a tinted raised surface
    muted: mix(raised, fg, dark ? 0.08 : 0.05), // a plain raised surface
    slate: mix(bg, mix(fg, accent, 0.2), dark ? 0.3 : 0.42),
    gray: mix(bg, fg, dark ? 0.34 : 0.45),
    blue: t.info ?? s[1] ?? mix(accent, [59, 130, 246], 0.6),
    indigo: t.indigo ?? mix(accent, [99, 102, 241], 0.5),
    sky: s[2] ?? mix(t.info ?? accent, WHITE, dark ? 0.2 : 0),
    red: t.error ?? mix(accent, [239, 68, 68], 0.75),
    green: t.success ?? mix(accent, [34, 197, 94], 0.75),
    amber: t.warning ?? mix(accent, [245, 158, 11], 0.75),
  }
  const surfaceLike = new Set(['secondary', 'muted'])
  const colors = {}
  for (const name of LIKEC4_COLORS) {
    const fill = base[name]
    const surface = surfaceLike.has(name)
    const stroke = surface ? mix(fill, fg, dark ? 0.18 : 0.14) : mix(fill, BLACK, dark ? 0.24 : 0.16)
    const hi = readable(fill, surface ? [fg] : [t.onAccent && name === 'primary' ? t.onAccent : null, fg, bg])
    const lo = ensureContrast(mix(hi, fill, 0.22), fill)
    // relationships: lines a muted take on the colour; label chips on the canvas surface
    const line = name === 'gray' || surface ? mix(bg, fg, dark ? 0.42 : 0.5) : mix(bg, fill, dark ? 0.8 : 0.85)
    const labelBg = raised
    const label = ensureContrast(muted, labelBg)
    colors[name] = { elements: { fill, stroke, hiContrast: hi, loContrast: lo }, relationships: { line, label, labelBg } }
  }
  return { scheme: dark ? 'dark' : 'light', bg, fg, raised, accent, colors }
}

/** Minimum text/fill contrast across the palette (hi + lo on fill, label on chip). */
export function paletteContrast(p) {
  let min = Infinity
  const where = []
  for (const [name, c] of Object.entries(p.colors)) {
    for (const [k, v] of [['hi', contrast(c.elements.hiContrast, c.elements.fill)], ['lo', contrast(c.elements.loContrast, c.elements.fill)], ['label', contrast(c.relationships.label, c.relationships.labelBg)]]) {
      where.push([name, k, Math.round(v * 100) / 100])
      min = Math.min(min, v)
    }
  }
  return { min: Math.round(min * 100) / 100, where }
}

/** The CSS text for inside the diagram shadow root. */
export function paletteCss(p) {
  const { colors, bg, fg } = p
  const out = []
  const decl = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}:${v} !important`)
      .join(';')
  const prim = colors.primary
  const vars = (c) => ({
    '--likec4-palette-fill': hex(c.elements.fill),
    '--likec4-palette-stroke': hex(c.elements.stroke),
    '--likec4-palette-hiContrast': hex(c.elements.hiContrast),
    '--likec4-palette-loContrast': hex(c.elements.loContrast),
    '--likec4-palette-relation-stroke': hex(c.relationships.line),
    '--likec4-palette-relation-label': hex(c.relationships.label),
    '--likec4-palette-relation-label-bg': hex(c.relationships.labelBg),
    '--likec4-palette-relation-stroke-selected': hex(mix(c.relationships.line, fg, 0.45)),
  })
  // chrome: LikeC4's panda tokens + Mantine's (overlays, walkthrough panel, popovers)
  out.push(
    `:host,.likec4-shadow-root,.likec4-root{${decl({
      ...vars(prim),
      '--colors-likec4-mix-color': hex(fg),
      '--colors-likec4-panel-bg': 'var(--pl-color-bg-raised)',
      '--colors-likec4-panel-border': 'var(--pl-color-border)',
      '--colors-likec4-panel-text': 'var(--pl-color-fg)',
      '--colors-likec4-panel-text-dimmed': 'var(--pl-color-fg-muted)',
      '--colors-likec4-panel-action': 'var(--pl-color-fg-muted)',
      '--colors-likec4-panel-action-hover': 'var(--pl-color-fg)',
      '--colors-likec4-panel-action-bg': 'color-mix(in srgb, var(--pl-color-fg) 6%, transparent)',
      '--colors-likec4-panel-action-bg-hover': 'color-mix(in srgb, var(--pl-color-fg) 12%, transparent)',
      '--colors-likec4-dropdown-bg': 'var(--pl-color-bg-raised)',
      '--colors-likec4-dropdown-border': 'var(--pl-color-border)',
      '--colors-likec4-overlay-body': 'var(--pl-color-bg-raised)',
      '--colors-likec4-overlay-border': 'var(--pl-color-border)',
      '--colors-likec4-overlay-backdrop': hex(bg),
      '--colors-likec4-walkthrough-parallel-frame': 'var(--pl-color-accent)',
      '--colors-likec4-tag-bg': 'color-mix(in srgb, var(--pl-color-accent) 22%, var(--pl-color-bg-raised))',
      '--colors-likec4-tag-bg-hover': 'color-mix(in srgb, var(--pl-color-accent) 32%, var(--pl-color-bg-raised))',
      '--colors-likec4-tag-border': 'var(--pl-color-border)',
      '--colors-likec4-tag-text': 'var(--pl-color-fg)',
      '--colors-surface-canvas': 'var(--pl-color-bg)',
      '--colors-surface-default': 'var(--pl-color-bg-raised)',
      '--colors-surface-sunken': 'var(--pl-color-bg-subtle, var(--pl-color-bg))',
      '--colors-surface-hover': 'color-mix(in srgb, var(--pl-color-fg) 7%, var(--pl-color-bg-raised))',
      '--colors-surface-selected': 'color-mix(in srgb, var(--pl-color-accent) 20%, var(--pl-color-bg-raised))',
      '--colors-surface-field': 'var(--pl-color-bg)',
      '--colors-diagram-background': 'var(--pl-color-bg)',
      '--colors-text': 'var(--pl-color-fg)',
      '--colors-text-default': 'var(--pl-color-fg)',
      '--colors-text-bright': 'var(--pl-color-fg)',
      '--colors-text-heading': 'var(--pl-color-fg)',
      '--colors-text-dimmed': 'var(--pl-color-fg-muted)',
      '--colors-text-link': 'var(--pl-color-accent)',
      '--colors-border-default': 'var(--pl-color-border)',
      '--colors-border-subtle': 'var(--pl-color-border)',
      '--colors-border-strong': 'var(--pl-color-border-strong, var(--pl-color-border))',
      '--colors-border-focus': 'var(--pl-color-focus, var(--pl-color-accent))',
      '--colors-primary-body': 'var(--pl-color-accent)',
      '--colors-primary-border': 'var(--pl-color-accent)',
      '--colors-primary-text': hex(colors.primary.elements.hiContrast),
      '--colors-likec4-accent': 'var(--pl-color-accent)',
      '--mantine-color-body': 'var(--pl-color-bg-raised)',
      '--mantine-color-text': 'var(--pl-color-fg)',
      '--mantine-color-bright': 'var(--pl-color-fg)',
      '--mantine-color-dimmed': 'var(--pl-color-fg-muted)',
      '--mantine-color-anchor': 'var(--pl-color-accent)',
      '--mantine-color-default': 'var(--pl-color-bg-raised)',
      '--mantine-color-default-hover': 'color-mix(in srgb, var(--pl-color-fg) 7%, var(--pl-color-bg-raised))',
      '--mantine-color-default-color': 'var(--pl-color-fg)',
      '--mantine-color-default-border': 'var(--pl-color-border)',
      '--mantine-primary-color-filled': 'var(--pl-color-accent)',
      '--mantine-primary-color-filled-hover': 'var(--pl-color-accent-hover, var(--pl-color-accent))',
      '--mantine-primary-color-light': 'color-mix(in srgb, var(--pl-color-accent) 18%, transparent)',
      '--mantine-primary-color-light-color': 'var(--pl-color-accent)',
      '--mantine-font-family': 'var(--pl-font-sans)',
      '--xy-background-color': 'transparent',
    })}}`,
  )
  for (const name of Object.keys(colors)) {
    const c = colors[name]
    out.push(`[data-likec4-color="${name}"]{${decl(vars(c))}}`)
    // compound (container) depths: a little closer to the canvas at each level
    for (let d = 1; d <= 5; d++) {
      const k = Math.min(0.12 * d, 0.5)
      const fillD = mix(c.elements.fill, bg, k)
      // compounds paint their fill at low opacity (LikeC4's 15% default) → title text sits on ~the canvas
      const seen = mix(bg, fillD, 0.15)
      const hiD = readable(seen, [ensureContrast(mix(fg, fillD, 0.25), seen), fg])
      out.push(`[data-likec4-color="${name}"][data-compound-depth="${d}"]{${decl({ '--likec4-palette-fill': hex(fillD), '--likec4-palette-stroke': hex(mix(c.elements.stroke, bg, k)), '--likec4-palette-hiContrast': hex(hiD), '--likec4-palette-loContrast': hex(ensureContrast(mix(hiD, seen, 0.2), seen)) })}}`)
    }
  }
  // selection / focus rings follow the DS focus colour
  out.push(`.react-flow__node.selected,.react-flow__node:focus-visible{--likec4-palette-outline:var(--pl-color-focus, var(--pl-color-accent)) !important}`)
  return out.join('\n')
}
