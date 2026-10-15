// Text legibility at the full-view fit in present mode: the on-screen CSS px of node titles,
// descriptions, technology, compound titles and edge labels (computed font-size × camera zoom),
// per view, at dsf 2 — plus a screenshot of each fit state.
//   PLAYWRIGHT_FROM=<dir> node dev/measure-text.mjs [--port 4720] [--out dir] [--tag before]
// Needs dev/server.mjs serving the example model (its default).
import { createRequire } from 'node:module'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = `http://localhost:${arg('--port', '4720')}`
const OUT = arg('--out', join(tmpdir(), 'atlas-viewer-shots'))
const TAG = arg('--tag', 'now')
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
// the console's content area with both docks collapsed at a 1280×800 window
const page = await browser.newPage({ viewport: { width: 1150, height: 712 }, deviceScaleFactor: 2 })
await page.goto(`${HOST}/harness.html?theme=dark&src=${encodeURIComponent('/plugins/atlas/view')}`)
const frame = await (await page.waitForSelector('#f')).contentFrame()
await page.waitForTimeout(2500)
const model = await (await fetch(`${HOST}/api/plugins/atlas/model`)).json()
const views = Object.keys(model.model.views)
const rows = []
for (const v of views) {
  await page.evaluate((v) => window.emit('atlas.show', { view: v, present: true }), v)
  await page.waitForTimeout(3500)
  for (let i = 0; i < 60 && (await frame.evaluate(() => !!window.__present?.busy)); i++) await page.waitForTimeout(100)
  await page.waitForTimeout(800)
  const m = await frame.evaluate(() => {
    const layer = [...document.querySelectorAll('.layer')].find((l) => l.style.opacity !== '0') ?? document.querySelector('.layer')
    const root = layer?.querySelector('.likec4-view')?.shadowRoot ?? layer
    const vp = root.querySelector('.react-flow__viewport')
    const zoom = vp ? new DOMMatrixReadOnly(getComputedStyle(vp).transform).a : 1
    const size = (sel) => {
      const all = [...root.querySelectorAll(sel)].filter((e) => e.textContent.trim())
      const shown = all.filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[style*="visibility: hidden"]'))
      if (!all.length) return null
      if (!shown.length) return 'hidden'
      return Math.round(Math.min(...shown.map((e) => parseFloat(getComputedStyle(e).fontSize) * zoom)) * 10) / 10
    }
    return {
      zoom: Math.round(zoom * 1000) / 1000,
      title: size('.likec4-element-title'),
      description: size('.likec4-element-description'),
      technology: size('.likec4-element-technology'),
      compound: size('.likec4-compound-title'),
      edge: size('.likec4-edge-label__text'),
    }
  })
  rows.push({ view: v, ...m })
  await page.screenshot({ path: join(OUT, `crisp-${TAG}-${v}.png`) })
}
console.table(rows)
writeFileSync(join(OUT, `crisp-${TAG}.json`), JSON.stringify(rows, null, 1))
await browser.close()
