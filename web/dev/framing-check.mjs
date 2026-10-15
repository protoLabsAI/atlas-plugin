// Record-mode framing check: steps through every slide (and every walkthrough step) of the
// example tour at 1280×720 CSS, dsf 2, and asserts from DOM geometry that every visible node is
// wholly inside the safe rect (below the top chrome, above the caption, inside the side margins),
// nothing is partially clipped, and the content is centred (±5 %). Writes a contact sheet.
//   PLAYWRIGHT_FROM=<dir> node dev/framing-check.mjs [--port 4720] [--sheet path] [--tour overview]
// Needs dev/server.mjs serving the example model (its default).
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = `http://localhost:${arg('--port', '4720')}`
const SHEET = arg('--sheet', join(tmpdir(), 'framing-sheet.png'))
const TOUR = arg('--tour', 'overview')
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(`${HOST}/plugins/atlas/view#tour=${TOUR}&slide=1&record=1&autoplay=0`)
await page.waitForFunction(() => window.__present, null, { timeout: 20000 })
const settle = async () => {
  await page.waitForTimeout(400)
  for (let i = 0; i < 80 && (await page.evaluate(() => window.__present?.busy)); i++) await page.waitForTimeout(100)
  await page.waitForTimeout(1900) // the slide's own camera ease (focus / step / fit)
}
const measure = () => page.evaluate(() => {
  const root = document.querySelector('.presenter').getBoundingClientRect()
  const W = root.width, H = root.height
  const top = Math.max(0, ...[...document.querySelectorAll('.p-crumbs, .p-top')].map((e) => e.getBoundingClientRect().bottom - root.top))
  const notes = document.querySelector('.notes:not(.notes-measure .notes)')
  const capTop = notes ? notes.getBoundingClientRect().top - root.top : H
  const side = W * 0.04
  const S = { x: side - 1, y: top - 1, x2: W - side + 1, y2: capTop + 1 }
  const layer = [...document.querySelectorAll('.layer')].find((l) => +getComputedStyle(l).opacity > 0.5)
  const sr = layer.querySelector('.likec4-view').shadowRoot
  const aim = window.__present.aim
  const bad = []
  const shown = []
  const centreOn = []
  for (const el of sr.querySelectorAll('.react-flow__node')) {
    const isCompound = el.classList.contains('react-flow__node-compound-element') || el.querySelector('.likec4-compound-node')
    const r = el.getBoundingClientRect()
    const b = { id: el.dataset.id, x: r.left - root.left, y: r.top - root.top, x2: r.right - root.left, y2: r.bottom - root.top }
    const off = b.x2 <= 0 || b.y2 <= 0 || b.x >= W || b.y >= H
    const inS = b.x >= S.x && b.y >= S.y && b.x2 <= S.x2 && b.y2 <= S.y2
    if (off) continue
    if (isCompound) { if (inS) shown.push(b); continue } // a container may frame the shot
    if (!inS) bad.push(b)
    else shown.push(b)
  }
  const set = centreOn.length ? centreOn : shown
  const cx = (Math.min(...set.map((b) => b.x)) + Math.max(...set.map((b) => b.x2))) / 2
  const cy = (Math.min(...set.map((b) => b.y)) + Math.max(...set.map((b) => b.y2))) / 2
  const sc = { x: (S.x + S.x2) / 2, y: (S.y + S.y2) / 2 }
  return { view: window.__present.view, slide: window.__present.slide + 1, walk: window.__present.walk, aim, bad, shown: shown.length,
    off: { x: Math.round(cx - sc.x), y: Math.round(cy - sc.y), tolX: Math.round((S.x2 - S.x) * 0.05), tolY: Math.round((S.y2 - S.y) * 0.05) } }
})
const frames = []
let failures = 0
const total = await page.evaluate(() => +document.querySelector('[data-atlas-slide]')?.closest('.presenter') && window.__atlas.tours.find((t) => t[0] === 'overview')?.[1])
for (let guard = 0; guard < 60; guard++) {
  await settle()
  const m = await measure()
  const centred = Math.abs(m.off.x) <= m.off.tolX && Math.abs(m.off.y) <= m.off.tolY
  const ok = m.bad.length === 0 && centred && m.shown > 0
  if (!ok) failures++
  const label = `slide ${m.slide}${m.walk ? ` · step ${m.walk}` : ''} · ${m.view}`
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${m.shown} shown, off-centre ${m.off.x},${m.off.y} (±${m.off.tolX},${m.off.tolY})${m.bad.length ? ', CLIPPED/OUTSIDE: ' + m.bad.map((b) => `${b.id} ${Math.round(b.x)},${Math.round(b.y)}–${Math.round(b.x2)},${Math.round(b.y2)}`).join('; ') : ''}`)
  frames.push({ label: `${ok ? '✓' : '✗'} ${label}`, b64: (await page.screenshot({ type: 'jpeg', quality: 72 })).toString('base64') })
  const before = await page.evaluate(() => [window.__present.slide, window.__present.walk])
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => [window.__present.slide, window.__present.walk])
  if (after[0] === before[0] && after[1] === before[1]) break // the end of the tour
}
const sp = await browser.newPage({ viewport: { width: 2000, height: 1200 } })
await sp.setContent(`<body style="margin:0;background:#111;color:#ddd;font:15px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px">${frames.map((f) => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/jpeg;base64,${f.b64}"><figcaption style="padding:2px 0 6px">${f.label}</figcaption></figure>`).join('')}</body>`)
await sp.screenshot({ path: SHEET, fullPage: true })
console.log(`${frames.length - failures}/${frames.length} frames pass${errs.length ? '\n' + errs.join('\n') : ''}`)
await browser.close()
process.exit(failures ? 1 : 0)
