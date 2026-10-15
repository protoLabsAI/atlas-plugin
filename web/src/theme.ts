// The console's live DS theme → LikeC4: resolve the --pl-* tokens (canvas probe handles
// hex/rgb/oklch/color-mix), build the palette + CSS (palette.mjs), re-run on every re-theme.
import { buildPalette, paletteContrast, paletteCss } from './palette.mjs'

type RGB = [number, number, number]
const probe = (() => {
  try {
    return document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  } catch {
    return null
  }
})()

export function tokenRGB(name: string): RGB | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw || !probe) return null
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = '#010203'
  probe.fillStyle = raw
  if (probe.fillStyle === '#010203' && !/^#?010203$/i.test(raw)) return null // unparseable
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  return a === 0 ? null : [r, g, b]
}

export function readTokens() {
  const t = (n: string) => tokenRGB(`--pl-color-${n}`) ?? undefined
  const series: RGB[] = []
  for (let i = 1; i <= 8; i++) {
    const c = t(`chart-series${i}`)
    if (c) series.push(c)
  }
  return {
    bg: t('bg'), raised: t('bg-raised'), subtle: t('bg-subtle'), fg: t('fg'), muted: t('fg-muted'), accent: t('accent'), onAccent: t('fg-on-accent'),
    error: t('status-error'), success: t('status-success'), warning: t('status-warning'), info: t('status-info'), indigo: t('brand-indigo'), series,
  }
}

export function themeFor(scheme: 'light' | 'dark') {
  const p = buildPalette(readTokens(), scheme)
  const css = paletteCss(p)
  ;(window as any).__atlasContrast = paletteContrast(p)
  return css
}
