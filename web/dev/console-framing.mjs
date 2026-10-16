// In-console framing check of a RECORD take: drives the real console exactly as the record shot
// script does (Atlas rail → docks collapsed → Tour options → Record), then, while the take plays:
//  - every ~100 ms (mid-transition included): nothing visible draws under the top chrome or the
//    caption (element rect ∩ the stage's clip, against the measured breadcrumb / caption); the
//    breadcrumb shows the slide's target view within 300 ms of the slide change; wherever the
//    picture STOPS (≥ 150 ms without motion), in any layer, nothing is partial or clip-cut; and no
//    frame is (nearly) empty — mid-move, at least min(source, target) nodes are drawn;
//  - at each settled slide / step: every visible node, compound, edge and edge-label chip is wholly
//    inside the safe rect (or off canvas / faded out), the content is centred (±5 %), and the
//    slide's SUBJECT is complete (its focus / step ends, else every leaf of the view);
// and writes a contact sheet of the settled frames.
//   PLAYWRIGHT_FROM=<dir> node dev/console-framing.mjs [--host http://127.0.0.1:7953] [--token …]
//     [--size 1280x720] [--dark] [--sheet path] [--tour-title 'Framing test: cousin jumps']
// (the cousin-jump test tour is dev/jumps.tour.json — add it to the host model's atlas.tours.json)
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
const TOUR_TITLE = arg('--tour-title', '')
await frame.getByRole('menuitem', { name: TOUR_TITLE ? `Record — ${TOUR_TITLE}` : /^Record/, exact: !!TOUR_TITLE }).first().click()
await frame.waitForSelector('[data-atlas-state=presenting]', { timeout: 10000 })
// the tour as authored, for the highlight check
let AUTHORED = []
try {
  const m = await (await fetch(`${HOST}/api/plugins/atlas/model`, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} })).json()
  const list = Array.isArray(m.tours) ? m.tours : m.tours?.tours ?? []
  AUTHORED = (TOUR_TITLE ? list.find((t) => t.title === TOUR_TITLE) : list[0])?.slides ?? []
} catch (e) {
  console.log('(no authored tour: the highlight check is skipped)', e.message)
}

const sample = () => frame.evaluate((authored) => {
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
  const sig = []
  let nodesVisible = 0 // leaves drawn at all (any layer, partly too)
  const badAll = [] // any visible layer (an in-flight one too)
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
    // the CAMERA: each visible layer's viewport transform (not node boxes — LikeC4's dim / highlight
    // animates those without the camera moving)
    const vpEl = sr.querySelector('.react-flow__viewport')
    // (exact: a slow ease tail still counts as moving; whether a change after a stop is a real
    // RESUME — not a sub-pixel settle onto the framing — is judged from the numbers, below)
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(vpEl?.style.transform || '')
    if (m) sig.push(`${+m[1]},${+m[2]},${+m[3]}`)
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
      if (el.hasAttribute('data-atlas-out')) continue // decided at rest: fading out
      const b = { id: `${kind}:${id}`, x: r.left - root.left, y: r.top - root.top, x2: r.right - root.left, y2: r.bottom - root.top }
      // the part actually drawn: inside the canvas and the stage clip
      const vy = Math.max(b.y, clipTop, 0), vy2 = Math.min(b.y2, clipBottom, H)
      const vx = Math.max(b.x, 0), vx2 = Math.min(b.x2, W)
      if (vy2 <= vy || vx2 <= vx) continue
      if (kind === 'node') nodesVisible++
      if (vy < chromeBottom - 0.5 || vy2 > capTop + 0.5) under.push(`${b.id} ${Math.round(vy)}–${Math.round(vy2)}`)
      const inS = b.x >= S.x && b.y >= S.y && b.x2 <= S.x2 && b.y2 <= S.y2
      if (b.y < clipTop - 0.5 || b.y2 > clipBottom + 0.5 || !inS) badAll.push(`${layer.dataset.view} ${b.id}`)
      if (layer !== active) continue
      // drawn only in part (cut by the stage clip)?
      if (b.y < clipTop - 0.5 || b.y2 > clipBottom + 0.5) { bad.push(`${b.id} CUT BY CLIP ${Math.round(b.y)}–${Math.round(b.y2)} clip ${Math.round(clipTop)}–${Math.round(clipBottom)}`); continue }
      if (!inS) bad.push(`${b.id} ${Math.round(b.x)},${Math.round(b.y)}–${Math.round(b.x2)},${Math.round(b.y2)}${el.hasAttribute('data-atlas-out') ? ' (marked out, op ' + getComputedStyle(el).opacity + ')' : ''} S=${Math.round(S.x)},${Math.round(S.y)}–${Math.round(S.x2)},${Math.round(S.y2)}`)
      else if (kind === 'node' || kind === 'compound') { shown.push(b); visibleIds.add(id) }
    }
  }
  // a LIST focus (#5): exactly those nodes lit, every other leaf dimmed
  let litWrong = null
  // the AUTHORED focus (from the tours file the host serves — not the viewer's own reading of it)
  const focus = authored[P.slide]?.focus
  if (Array.isArray(focus) && focus.length > 1 && active && !P.walk) {
    const asr = active.querySelector('.likec4-view')?.shadowRoot
    const lit = [...(asr?.querySelectorAll('.react-flow__node') ?? [])]
      .filter((el) => !el.querySelector('.likec4-compound-node') && +getComputedStyle(el).opacity > 0.6)
      .map((el) => el.dataset.id)
      .sort()
    const want = [...focus].sort()
    if (lit.join() !== want.join()) litWrong = `lit ${lit.join(', ') || '—'} ≠ focus ${want.join(', ')}`
  }
  // the subject is what the TOUR FILE authors: a focus / step (→ the camera's aim), a walked step,
  // else EVERY leaf of the view — a narrowing the viewer chose on its own never passes
  const slideDoc = authored[P.slide] ?? {}
  const subject = P.walk || slideDoc.focus || slideDoc.step ? (P.aim ?? leaves) : leaves
  const missing = subject.filter((id) => !visibleIds.has(id))
  const cx = (Math.min(...shown.map((b) => b.x)) + Math.max(...shown.map((b) => b.x2))) / 2
  const cy = (Math.min(...shown.map((b) => b.y)) + Math.max(...shown.map((b) => b.y2))) / 2
  const sc = { x: (S.x + S.x2) / 2, y: (S.y + S.y2) / 2 }
  return {
    state: document.querySelector('[data-atlas-state]')?.getAttribute('data-atlas-state'),
    slide: P.slide + 1, walk: P.walk, view: P.view, busy: P.busy, under, bad, missing, shown: shown.length,
    crumb: P.crumb, target: P.target, nodesVisible, litWrong, sig: sig.join('|'), badAll, layers: document.querySelectorAll('.layer').length,
    off: { x: Math.round(cx - sc.x), y: Math.round(cy - sc.y), tolX: Math.round((S.x2 - S.x) * 0.05), tolY: Math.round((S.y2 - S.y) * 0.05) },
  }
}, AUTHORED)

const frames = []
let failures = 0
let underFails = 0
let samples = 0
let crumbFails = 0
let crumbChecked = 0
let pauseFails = 0
let moveKey = ''
let moveStarted = false
let lastSampleAt = 0
let slowSince = 0
let emptyFails = 0
let restCount = null
const inFlight = []
const flight = []
const FLIGHT = +arg('--flight-slide', '2')
const FLIGHT_MS = +arg('--flight-ms', '80')
let castStarted = 0
let cdp = null
const cast = []
let stopFails = 0
let still = 0
let prevSig = ''
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
  if (s.state === 'tour-done') { console.log(`take: presenting → tour-done ${((Date.now() - t0) / 1000).toFixed(1)} s`); break }
  const key = `${s.slide}.${s.walk}`
  if (key !== last) { last = key; since = Date.now() }
  const tl = `t=${((Date.now() - t0) / 1000).toFixed(1)}s slide ${s.slide}`
  // the breadcrumb follows the target view from the move's start
  if (s.target && s.crumb !== s.target && Date.now() - since > 300) {
    if (++crumbFails <= 6) console.log(`FAIL ${tl} stale breadcrumb: shows ${s.crumb}, going to ${s.target} (${Date.now() - since} ms after the change)`)
  }
  // a move never pauses part-way: once the picture has started moving for this slide / step, a
  // stationary spell > 150 ms followed by more motion is a mid-move stop (a level held in a dive)
  // (the stationary spell is measured conservatively: from the first to the last sample that saw
  // the same picture — samples are ~100 ms apart, so one repeat alone can't fail it)
  const now = Date.now()
  if (key !== moveKey) { moveKey = key; moveStarted = false; slowSince = 0 }
  // camera speed between samples: SLOW = every visible layer moved < 2 px (zoom < 0.5 %); a move
  // that goes fast, then slow for > 150 ms, then fast again PAUSED part-way (a level held between
  // two zooms — even when it never quite stops, the deceleration + re-acceleration reads as a stop)
  const nums = (g) => (g ? g.split('|').map((v) => v.split(',').map(Number)) : [])
  const slowStep = (a, b) => {
    const A = nums(a), B = nums(b)
    if (!A.length || A.length !== B.length) return false
    return A.every((v, i) => Math.abs(v[0] - B[i][0]) < 2 && Math.abs(v[1] - B[i][1]) < 2 && Math.abs(v[2] / B[i][2] - 1) < 0.005)
  }
  if (process.env.DEBUG_SIG && s.slide === +process.env.DEBUG_SIG) console.log(`SIG ${now - since} busy=${s.busy} ${s.sig.slice(0, 140)}`)
  if (prevSig) {
    if (!slowStep(s.sig, prevSig)) {
      if (moveStarted && slowSince && lastSampleAt - slowSince > 150) {
        pauseFails++
        if (pauseFails <= 6) console.log(`FAIL ${tl} the camera paused ≥ ${lastSampleAt - slowSince} ms mid-move`)
      }
      moveStarted = true // it has gone fast once
      slowSince = 0
    } else if (moveStarted && !slowSince) slowSince = lastSampleAt
  }
  lastSampleAt = now
  // the picture stopped (no motion for ≥ 150 ms — two equal samples): every visible layer obeys
  // the framing rules. In motion, partial is natural (things move through the edges).
  still = s.sig === prevSig ? still + 1 : 0
  prevSig = s.sig
  if (still === 2 && s.badAll.length) {
    stopFails++
    if (stopFails <= 6) console.log(`FAIL ${tl} the picture stopped with something partial / cut (${s.busy ? 'mid-move' : 'at rest'}, ${s.layers} layer(s)): ${s.badAll.slice(0, 4).join('; ')}`)
  }
  if (s.target) crumbChecked++
  // no empty frames: between two resting pictures every sample draws ≥ min(their node counts)
  if (!s.busy && still >= 2) {
    if (restCount != null) {
      const floor = Math.min(restCount, s.nodesVisible)
      // a view change (two layers: a zoom through a portal, a crossfade) has the parent's nodes
      // leave through the edges — natural; it may only never go blank. A same-view move (a step,
      // a focus) keeps at least the smaller of the two pictures on screen throughout.
      for (const m of inFlight) if (m.n < (m.layers > 1 ? 1 : floor)) { emptyFails++; if (emptyFails <= 6) console.log(`FAIL ${m.tl} near-empty frame: ${m.n} node(s) drawn, the pictures either side have ${restCount} / ${s.nodesVisible}`) }
    }
    restCount = s.nodesVisible
    inFlight.length = 0
  } else inFlight.push({ n: s.nodesVisible, tl, layers: s.layers })
  // a filmstrip of one move (the change INTO --flight-slide): the page's own screencast frames
  // over ~3.5 s, picked every --flight-ms (80) apart
  if (s.slide === FLIGHT && !castStarted) {
    castStarted = Date.now()
    cdp = await page.context().newCDPSession(page)
    cdp.on('Page.screencastFrame', (f) => {
      cast.push({ t: Date.now() - castStarted, data: f.data })
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, everyNthFrame: 1 })
  }
  if (castStarted && cdp && Date.now() - castStarted > 3500) {
    await cdp.send('Page.stopScreencast').catch(() => {})
    cdp = null
    let next = 0
    for (const f of cast) if (f.t >= next && flight.length < 48) (flight.push({ label: `t+${f.t} ms`, b64: f.data }), (next = f.t + FLIGHT_MS))
  }
  // settled: the slide's own camera has come to rest (≥ 500 ms still, the rest-cull's fade done)
  if (!s.busy && still >= 5 && !done.has(key) && Date.now() - since > 1500) {
    done.add(key)
    const centred = Math.abs(s.off.x) <= s.off.tolX && Math.abs(s.off.y) <= s.off.tolY
    const ok = !s.bad.length && !s.missing.length && centred && s.shown > 0 && !s.litWrong
    if (!ok) failures++
    const label = `slide ${s.slide}${s.walk ? ` · step ${s.walk}` : ''} · ${s.view}`
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} — ${s.shown} shown, off-centre ${s.off.x},${s.off.y}${s.missing.length ? ', SUBJECT MISSING: ' + s.missing.join(', ') : ''}${s.litWrong ? ', HIGHLIGHT: ' + s.litWrong : ''}${s.bad.length ? ', PARTIAL/OUTSIDE: ' + s.bad.join('; ') : ''}`)
    frames.push({ label: `${ok ? '✓' : '✗'} ${label}`, b64: (await page.screenshot({ type: 'jpeg', quality: 72 })).toString('base64') })
  }
  await page.waitForTimeout(100)
}
const sp = await browser.newPage({ viewport: { width: 2000, height: 1200 } })
await sp.setContent(`<body style="margin:0;background:#111;color:#ddd;font:15px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px">${frames.map((f) => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/jpeg;base64,${f.b64}"><figcaption style="padding:2px 0 6px">${f.label}</figcaption></figure>`).join('')}</body>`)
await sp.screenshot({ path: SHEET, fullPage: true })
if (flight.length) {
  await sp.setContent(`<body style="margin:0;background:#111;color:#ddd;font:15px system-ui;display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:6px">${flight.map((f) => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/jpeg;base64,${f.b64}"><figcaption style="padding:2px 0 6px">${f.label}</figcaption></figure>`).join('')}</body>`)
  await sp.screenshot({ path: SHEET.replace(/\.png$/, '-flight.png'), fullPage: true })
}
console.log(`${frames.length - failures}/${frames.length} settled frames pass · ${samples - underFails}/${samples} samples clear of chrome/caption · ${crumbFails} stale-breadcrumb samples (of ${crumbChecked}) · ${stopFails} cropped stops · ${emptyFails} near-empty frames · ${pauseFails} mid-move pauses${errs.length ? '\n' + errs.join('\n') : ''}`)
await browser.close()
process.exit(failures || underFails || crumbFails || stopFails || emptyFails || pauseFails ? 1 : 0)
