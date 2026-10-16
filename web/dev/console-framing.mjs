// In-console framing check of a RECORD take: drives the real console exactly as the record shot
// script does (Atlas rail → docks collapsed → Tour options → Record), then, while the take plays:
//  - every ~100 ms (mid-transition included): nothing visible draws under the top chrome or the
//    caption (element rect ∩ the stage's clip, against the measured breadcrumb / caption);
//  - at each settled slide / step: every visible node, compound, edge and edge-label chip is wholly
//    inside the safe rect (or off canvas / faded out), the content is centred (±5 %), and the
//    slide's SUBJECT is complete (its focus / step ends, else every leaf of the view);
// and writes a contact sheet of the settled frames.
//   PLAYWRIGHT_FROM=<dir> node dev/console-framing.mjs [--host http://127.0.0.1:7953] [--token …]
//     [--size 1280x720] [--dark] [--sheet path]
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = arg('--host', 'http://127.0.0.1:7953')
const TOKEN = arg('--token', process.env.ATLAS_TOKEN ?? '')
const [VW, VH] = arg('--size', '1280x720').split('x').map(Number)
const DARK = process.argv.includes('--dark')
const SHEET = arg('--sheet', join(tmpdir(), 'console-framing-sheet.png'))
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2, colorScheme: DARK ? 'dark' : 'light' })
if (TOKEN) await ctx.addInitScript((t) => localStorage.setItem('protoagent.authToken', t), TOKEN)
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(HOST + '/app/')
await page.getByRole('button', { name: 'Atlas', exact: true }).first().click({ timeout: 60000 })
let frame
for (let i = 0; i < 200 && !frame; i++) {
  frame = page.frames().find((f) => f.url().includes('/plugins/atlas/view'))
  if (!frame) await page.waitForTimeout(100)
}
await frame.waitForSelector('[data-atlas-state=ready]', { timeout: 60000 })
for (const name of ['Toggle side panel', 'Toggle bottom panel']) {
  const b = page.locator(`button[aria-label="${name}"][aria-pressed="true"]:not([disabled])`)
  if (await b.count()) await b.last().click()
}
await page.waitForTimeout(1000)
await frame.getByRole('button', { name: 'Tour options' }).click()
await frame.getByRole('menuitem', { name: /^Record/ }).first().click()
await frame.waitForSelector('[data-atlas-state=presenting]', { timeout: 10000 })

const sample = () => frame.evaluate(() => {
  const P = window.__present
  const root = document.querySelector('.presenter')?.getBoundingClientRect()
  if (!P || !root) return null
  const W = root.width, H = root.height
  const chromeBottom = Math.max(0, ...[...document.querySelectorAll('.p-crumbs, .p-top')].map((e) => { const r = e.getBoundingClientRect(); return r.height ? r.bottom - root.top : 0 }))
  const notes = [...document.querySelectorAll('.notes')].find((n) => !n.closest('.notes-measure') && n.getBoundingClientRect().height > 0 && +getComputedStyle(n).opacity > 0.05)
  const capTop = notes ? notes.getBoundingClientRect().top - root.top : H
  // the stage's clip (inset top / bottom), if any
  const stage = document.querySelector('.stage')
  const m = /inset\(([\d.]+)px\s+[\d.]+(?:px)?\s+([\d.]+)px/.exec(getComputedStyle(stage).clipPath || '')
  const clipTop = m ? +m[1] : 0
  const clipBottom = m ? H - +m[2] : H
  const side = W * 0.04
  const S = { x: side - 1, y: chromeBottom + 8 - 1, x2: W - side + 1, y2: capTop - 12 + 1 }
  const seen = (el, sr) => { for (let e = el; e && e !== sr; e = e.parentElement) if (+getComputedStyle(e).opacity < 0.05) return false; return true }
  const under = [] // mid-move rule: nothing visible under the chrome / caption
  const bad = []
  const shown = []
  const visibleIds = new Set()
  const leaves = []
  const active = [...document.querySelectorAll('.layer')].find((l) => l.hasAttribute('data-active')) ?? document.querySelector('.layer')
  for (const layer of document.querySelectorAll('.layer')) {
    if (+getComputedStyle(layer).opacity < 0.05) continue
    const sr = layer.querySelector('.likec4-view')?.shadowRoot
    if (!sr) continue
    const els = [
      ...[...sr.querySelectorAll('.react-flow__node')].map((el) => ({ el, r: el, kind: el.querySelector('.likec4-compound-node') ? 'compound' : 'node', id: el.dataset.id })),
      ...[...sr.querySelectorAll('.react-flow__edge')].map((el) => ({ el, r: el, kind: 'edge', id: el.dataset.id })),
      ...[...sr.querySelectorAll('.likec4-edge-label-container')].map((el) => ({ el, r: el.querySelector('.likec4-edge-label') ?? el, kind: 'label', id: el.textContent.trim().slice(0, 24) })),
    ]
    for (const { el, r: rel, kind, id } of els) {
      const r = rel.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      if (layer === active && kind === 'node') leaves.push(id)
      if (!seen(el, sr)) continue
      const b = { id: `${kind}:${id}`, x: r.left - root.left, y: r.top - root.top, x2: r.right - root.left, y2: r.bottom - root.top }
      // the part actually drawn: inside the canvas and the stage clip
      const vy = Math.max(b.y, clipTop, 0), vy2 = Math.min(b.y2, clipBottom, H)
      const vx = Math.max(b.x, 0), vx2 = Math.min(b.x2, W)
      if (vy2 <= vy || vx2 <= vx) continue
      if (vy < chromeBottom - 0.5 || vy2 > capTop + 0.5) under.push(`${b.id} ${Math.round(vy)}–${Math.round(vy2)}`)
      if (layer !== active) continue
      const inS = b.x >= S.x && b.y >= S.y && b.x2 <= S.x2 && b.y2 <= S.y2
      // drawn only in part (cut by the stage clip)?
      if (b.y < clipTop - 0.5 || b.y2 > clipBottom + 0.5) { bad.push(`${b.id} CUT BY CLIP ${Math.round(b.y)}–${Math.round(b.y2)} clip ${Math.round(clipTop)}–${Math.round(clipBottom)}`); continue }
      if (!inS) bad.push(`${b.id} ${Math.round(b.x)},${Math.round(b.y)}–${Math.round(b.x2)},${Math.round(b.y2)}${el.hasAttribute('data-atlas-out') ? ' (marked out, op ' + getComputedStyle(el).opacity + ')' : ''} S=${Math.round(S.x)},${Math.round(S.y)}–${Math.round(S.x2)},${Math.round(S.y2)}`)
      else if (kind === 'node' || kind === 'compound') { shown.push(b); visibleIds.add(id) }
    }
  }
  const subject = P.aim ?? leaves
  const missing = subject.filter((id) => !visibleIds.has(id))
  const cx = (Math.min(...shown.map((b) => b.x)) + Math.max(...shown.map((b) => b.x2))) / 2
  const cy = (Math.min(...shown.map((b) => b.y)) + Math.max(...shown.map((b) => b.y2))) / 2
  const sc = { x: (S.x + S.x2) / 2, y: (S.y + S.y2) / 2 }
  return {
    state: document.querySelector('[data-atlas-state]')?.getAttribute('data-atlas-state'),
    slide: P.slide + 1, walk: P.walk, view: P.view, busy: P.busy, under, bad, missing, shown: shown.length,
    off: { x: Math.round(cx - sc.x), y: Math.round(cy - sc.y), tolX: Math.round((S.x2 - S.x) * 0.05), tolY: Math.round((S.y2 - S.y) * 0.05) },
  }
})

const frames = []
let failures = 0
let underFails = 0
let samples = 0
let last = ''
let since = 0
const done = new Set()
const t0 = Date.now()
while (Date.now() - t0 < 180000) {
  const s = await sample().catch(() => null)
  if (!s) { await page.waitForTimeout(100); continue }
  samples++
  if (s.under.length) {
    underFails++
    if (underFails <= 8) console.log(`FAIL t=${((Date.now() - t0) / 1000).toFixed(1)}s slide ${s.slide}${s.walk ? '.' + s.walk : ''} under chrome/caption: ${s.under.slice(0, 4).join('; ')}`)
  }
  if (s.state === 'tour-done') break
  const key = `${s.slide}.${s.walk}`
  if (key !== last) { last = key; since = Date.now() }
  if (!s.busy && !done.has(key) && Date.now() - since > 1500) {
    done.add(key)
    const centred = Math.abs(s.off.x) <= s.off.tolX && Math.abs(s.off.y) <= s.off.tolY
    const ok = !s.bad.length && !s.missing.length && centred && s.shown > 0
    if (!ok) failures++
    const label = `slide ${s.slide}${s.walk ? ` · step ${s.walk}` : ''} · ${s.view}`
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${s.shown} shown, off-centre ${s.off.x},${s.off.y}${s.missing.length ? ', SUBJECT MISSING: ' + s.missing.join(', ') : ''}${s.bad.length ? ', PARTIAL/OUTSIDE: ' + s.bad.join('; ') : ''}`)
    frames.push({ label: `${ok ? '✓' : '✗'} ${label}`, b64: (await page.screenshot({ type: 'jpeg', quality: 72 })).toString('base64') })
  }
  await page.waitForTimeout(100)
}
const sp = await browser.newPage({ viewport: { width: 2000, height: 1200 } })
await sp.setContent(`<body style="margin:0;background:#111;color:#ddd;font:15px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px">${frames.map((f) => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/jpeg;base64,${f.b64}"><figcaption style="padding:2px 0 6px">${f.label}</figcaption></figure>`).join('')}</body>`)
await sp.screenshot({ path: SHEET, fullPage: true })
console.log(`${frames.length - failures}/${frames.length} settled frames pass · ${samples - underFails}/${samples} samples clear of chrome/caption${errs.length ? '\n' + errs.join('\n') : ''}`)
await browser.close()
process.exit(failures || underFails ? 1 : 0)
