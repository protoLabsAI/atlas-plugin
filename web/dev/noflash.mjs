// Small text must never flash during camera moves: drives a drill-in (index → proto_agent_detail)
// and a walkthrough step move in present mode at dsf 2, samples every layer's description opacity
// on every animation frame, and writes a frame strip (~60 ms apart).
//   PLAYWRIGHT_FROM=<dir> node dev/noflash.mjs [--port 4720] [--out dir]   (dev/server.mjs, example model)
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = `http://localhost:${arg('--port', '4720')}`
const OUT = arg('--out', join(tmpdir(), 'atlas-viewer-shots'))
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const page = await browser.newPage({ viewport: { width: 1150, height: 712 }, deviceScaleFactor: 2 })
await page.goto(`${HOST}/harness.html?theme=dark&src=${encodeURIComponent('/plugins/atlas/view')}`)
const frame = await (await page.waitForSelector('#f')).contentFrame()
await page.waitForTimeout(2500)
const check = (n, ok, x = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`)

const sampler = () => frame.evaluate(() => {
  window.__samples = []
  const tick = () => {
    const per = [...document.querySelectorAll('.layer')].map((l) => {
      const root = l.querySelector('.likec4-view')?.shadowRoot
      const d = root?.querySelector('[data-likec4-node-description]')
      if (!d) return null
      const cs = getComputedStyle(d)
      return { view: l.dataset.view, layer: +l.style.opacity, shown: cs.display !== 'none' && +cs.opacity > 0.01 }
    })
    window.__samples.push({ t: performance.now(), per })
    if (window.__sampling) requestAnimationFrame(tick)
  }
  window.__sampling = true
  requestAnimationFrame(tick)
})
const stop = () => frame.evaluate(() => ((window.__sampling = false), window.__samples))
// a flash = a layer's description going shown→hidden or hidden→shown more than once while it's on screen
const flashes = (samples) => {
  const seq = new Map()
  for (const s of samples) s.per.forEach((p, i) => p && p.layer > 0.02 && (seq.get(p.view + i) ?? seq.set(p.view + i, []).get(p.view + i)).push(p.shown))
  let n = 0
  for (const xs of seq.values()) for (let i = 1; i < xs.length; i++) if (xs[i] !== xs[i - 1]) n++
  return n
}
async function strip(name, action, ms) {
  await sampler()
  const shots = []
  const t0 = Date.now()
  await action()
  while (Date.now() - t0 < ms) {
    shots.push({ t: Date.now() - t0, b64: (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64') })
    await page.waitForTimeout(25)
  }
  const samples = await stop()
  const sp = await browser.newPage({ viewport: { width: 1800, height: 1000 } })
  await sp.setContent(`<body style="margin:0;background:#111;color:#ddd;font:13px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px">${shots.map((s) => `<figure style="margin:0"><img style="width:100%" src="data:image/jpeg;base64,${s.b64}"><figcaption>${s.t} ms</figcaption></figure>`).join('')}</body>`)
  await sp.screenshot({ path: join(OUT, `noflash-${name}.png`), fullPage: true })
  await sp.close()
  return { frames: samples.length, shots: shots.length, flips: flashes(samples), samples }
}

// 1) a drill-in: index (descriptions shown) → proto_agent_detail (hidden at its fit)
await page.evaluate(() => window.emit('atlas.show', { view: 'index', present: true }))
await page.waitForTimeout(3000)
let r = await strip('drill-in', () => page.evaluate(() => window.emit('atlas.show', { view: 'proto_agent_detail', present: true })), 2200)
check('drill-in: descriptions never change on screen mid-zoom', r.flips === 0, `${r.frames} rAF samples, ${r.shots} shots, ${r.flips} flips`)
// 2) a flow step: chat_turn_flow full view (hidden) → step 3 (the camera zooms in)
await page.evaluate(() => window.emit('atlas.show', { view: 'chat_turn_flow', present: true }))
await page.waitForTimeout(3500)
r = await strip('flow-step', () => page.evaluate(() => window.emit('atlas.show', { view: 'chat_turn_flow', step: 3, present: true })), 1800)
// a decision at the START of the move is fine (one flip at t≈0); none after that
const firstFlip = (() => {
  let prev
  for (const s of r.samples) { const p = s.per.find((x) => x && x.layer > 0.02); if (!p) continue; if (prev !== undefined && p.shown !== prev) return s.t - r.samples[0].t; prev = p.shown }
  return null
})()
check('flow step: at most one change, at the start of the move', r.flips <= 1 && (firstFlip === null || firstFlip < 120), `${r.flips} flips, first at ${firstFlip?.toFixed?.(0)} ms`)
await browser.close()
