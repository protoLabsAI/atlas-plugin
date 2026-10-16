// Drives the built viewer through the dev server (dev/server.mjs) with Playwright and writes
// screenshots. Playwright isn't a dependency of this package: it's resolved from
// $PLAYWRIGHT_FROM (a dir with node_modules/playwright; required).
//   node dev/drive.mjs [--port 4720] [--out <dir>] [--model <dir to mutate for the error test>]
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const PORT = arg('--port', '4720')
const OUT = arg('--out', join(tmpdir(), 'atlas-viewer-shots'))
const MODEL = arg('--model', '')
const HOST = `http://localhost:${PORT}`
mkdirSync(OUT, { recursive: true })
if (!process.env.PLAYWRIGHT_FROM) { console.error('set PLAYWRIGHT_FROM to a dir whose node_modules has playwright'); process.exit(2) }
const req = createRequire(join(process.env.PLAYWRIGHT_FROM, 'package.json'))
const { chromium } = req('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })

const results = []
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)) }
const mock = (q) => fetch(`${HOST}/__mock?${q}`, { method: 'POST' })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(theme = 'dark', src = '/agents/foo/plugins/atlas/view', extra = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const logs = []
  page.on('console', (m) => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)))
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message.slice(0, 200)))
  page.on('requestfailed', (r) => !/ERR_ABORTED/.test(r.failure()?.errorText ?? '') && logs.push('REQFAIL ' + r.url() + ' ' + r.failure()?.errorText))
  await page.goto(`${HOST}/harness.html?theme=${theme}&src=${encodeURIComponent(src + extra)}`)
  const frame = page.frames().find((f) => f.url().includes('/plugins/atlas/view')) ?? (await (await page.waitForSelector('#f')).contentFrame())
  return { page, frame, logs }
}
const state = (frame) => frame.evaluate(() => window.__atlas)
const shot = (page, name) => page.screenshot({ path: join(OUT, name + '.png') })
async function waitFor(frame, fn, arg, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await frame.evaluate(fn, arg)) return true } catch {} await wait(100) }
  return false
}

// ---------------------------------------------------------------- explore (fleet prefix, dark)
await mock('scenario=normal&token=dev-token&tours=1')
{
  const { page, frame, logs } = await open('dark')
  const nodes = await waitFor(frame, () => !!document.querySelector('.likec4-view')?.shadowRoot?.querySelector('.react-flow__node') || document.querySelectorAll('.react-flow__node').length > 0)
  await wait(900)
  check('explore renders under /agents/foo prefix', nodes, JSON.stringify(await state(frame)))
  await shot(page, '01-explore-index-dark')

  // drill-down: the protoAgent node's navigate button
  const node = frame.locator('.react-flow__node', { hasText: 'protoAgent' }).first()
  await node.hover(); await wait(300)
  const btns = node.locator('button, [role=button]')
  for (let i = 0; i < (await btns.count()); i++) {
    await btns.nth(i).click({ force: true }).catch(() => {})
    await wait(400)
    if ((await state(frame)).view !== 'index') break
  }
  const s1 = await state(frame)
  check('drill-down via node navigate button', s1.view === 'proto_agent_detail', s1.view)
  await wait(2000)
  await shot(page, '02-drilldown-containers')

  // details panel
  await frame.locator('.react-flow__node', { hasText: /^Server/ }).first().click({ position: { x: 30, y: 20 } })
  const det = await waitFor(frame, () => !!document.querySelector('.details'))
  check('details panel opens on node click', det, await frame.evaluate(() => document.querySelector('.details h2')?.textContent))
  await wait(300)
  await shot(page, '03-details-panel')

  // code link → protoagent:code:open to the parent
  await frame.locator('[data-testid=code-link]').first().click()
  await wait(500)
  const msgs = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'protoagent:code:open'))
  check('code link click → code pane (open_in: pane)', msgs.length === 1 && msgs[0].project === 'protoAgent' && msgs[0].path === 'src/server/__init__.py' && msgs[0].open_in === 'pane', JSON.stringify(msgs[0]))
  await frame.locator('[data-testid=code-link]').first().click({ modifiers: ['Meta'] })
  await frame.locator('[data-testid=code-editor]').first().click()
  await wait(300)
  const ed = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'protoagent:code:open').slice(1).map((m) => m.open_in))
  check('⌘-click and "Open in editor" → open_in: editor', ed.join() === 'editor,editor', ed.join())
  // a node's context menu goes to the console, its action comes back
  await frame.locator('.react-flow__node', { hasText: /^Agent graph/ }).first().click({ button: 'right', position: { x: 30, y: 20 } })
  await wait(300)
  const menu = await page.evaluate(() => window.__menu)
  check('right-click → protoagent:contextmenu:open', !!menu && menu.items.some((i) => i.id === 'view') && menu.items.some((i) => i.id === 'drill'), (menu?.items ?? []).map((i) => i.id ?? '-').join(','))
  await page.evaluate(() => window.menuAction('details')); await wait(300)
  check('contextmenu:action details opens the panel', (await state(frame)).selected === 'proto_agent.graph')
  await page.keyboard.press('Meta+Shift+K'); await wait(200)
  const kd = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'protoagent:keydown').map((m) => m.combo))
  check('host chords forwarded (protoagent:keydown)', kd.includes('mod+shift+k'), kd.join())
  const subs = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'protoagent:subscribe'))
  check('subscribes to atlas.# on the bus', subs.some((m) => m.patterns?.includes('atlas.#')))

  // search → element in another view
  await frame.locator('.search input').fill('llm')
  await wait(300)
  await shot(page, '04-search')
  await frame.locator('.hits button').first().click()
  await wait(2500)
  const s2 = await state(frame)
  check('search result navigates + selects', s2.selected === 'gateway', `${s2.view} ${s2.selected}`)
  await shot(page, '05-search-picked')

  // breadcrumb back to the root
  await frame.locator('.crumb button').first().click()
  await wait(2200)
  check('breadcrumb navigates up', (await state(frame)).view === 'index')

  // live theme switch → light
  await page.evaluate(() => window.setTheme('light'))
  const light = await waitFor(frame, () => window.__atlas.scheme === 'light')
  await wait(700)
  check('live re-theme to light', light)
  await shot(page, '06-explore-light')

  // dynamic view walkthrough (explore)
  await frame.locator('.viewpick select').selectOption('chat_turn_flow')
  await wait(2200)
  await frame.getByRole('button', { name: /Walk through/ }).click()
  await wait(1400)
  await frame.getByRole('button', { name: 'Next step' }).click()
  await wait(1400)
  const s3 = await state(frame)
  check('explore walkthrough steps', s3.walk === 2, 'walk=' + s3.walk)
  await shot(page, '07-dynamic-walkthrough-light')
  console.log(logs.join('\n'))
  await page.close()
}

// ---------------------------------------------------------------- code pane OFF → hint + editor primary
await mock('pane=0')
{
  const { page, frame } = await open('dark')
  await waitFor(frame, () => window.__atlas?.view === 'index' && window.__atlas?.paneOn === false)
  await wait(1200)
  await frame.locator('.search input').fill('agent graph'); await wait(200)
  await frame.locator('.hits button').first().click(); await wait(2600)
  const hint = await frame.locator('[data-testid=pane-hint]').count()
  const view = await frame.locator('[data-testid=code-view]').count()
  await frame.locator('[data-testid=code-link]').first().click(); await wait(300)
  const m = await page.evaluate(() => window.__msgs.filter((x) => x.type === 'protoagent:code:open').pop())
  check('pane off: hint, no View button, click → editor', hint === 1 && view === 0 && m?.open_in === 'editor', JSON.stringify(m))
  await shot(page, '08-pane-off-hint')
  await page.close()
}
await mock('pane=1')

// ---------------------------------------------------------------- presenter (dark, slowed to catch frames)
{
  const { page, frame, logs } = await open('dark', '/agents/foo/plugins/atlas/view', '?slow=3')
  await waitFor(frame, () => window.__atlas?.view === 'index')
  await wait(800)
  await frame.locator('.present-btn').click()
  await waitFor(frame, () => window.__present?.slide === 0)
  await wait(800)
  check('presenter opens on the API tour', (await state(frame)).mode === 'present')
  await shot(page, '10-present-slide1')
  await page.keyboard.press('ArrowRight'); await wait(1600)
  await shot(page, '11-present-slide2-focus')
  // slide 3 = drill into proto_agent_detail: capture the zoom mid-flight
  await page.keyboard.press('ArrowRight')
  for (const [i, ms] of [[0, 900], [1, 900], [2, 900]]) { await wait(ms); await shot(page, `12-present-zoom-in-f${i}`) }
  await waitFor(frame, () => !window.__present.busy)
  await wait(400)
  const p3 = await frame.evaluate(() => ({ view: window.__present.view, slide: window.__present.slide }))
  check('presenter zooms into the drill-down', p3.view === 'proto_agent_detail' && p3.slide === 2, JSON.stringify(p3))
  await shot(page, '13-present-slide3')
  await page.keyboard.press('6')
  await waitFor(frame, () => !window.__present.busy && window.__present.view === 'chat_turn_flow', null, 15000)
  await wait(1200)
  check('digit jumps to a walkthrough slide', (await frame.evaluate(() => window.__present.view)) === 'chat_turn_flow')
  await shot(page, '14-present-dynamic-step')
  await page.keyboard.press('n'); await wait(200)
  check('N hides notes', (await frame.locator('.notes').count()) === 0)
  await page.keyboard.press('n')
  // bus: atlas.show → explore a view with focus
  await page.evaluate(() => window.emit('atlas.show', { view: 'proto_agent_detail', focus: 'proto_agent.graph' }))
  await wait(3500)
  const s4 = await state(frame)
  check('atlas.show (explore + focus) from the bus → live highlight', s4.mode === 'explore' && s4.view === 'proto_agent_detail' && s4.highlight?.focus?.[0] === 'proto_agent.graph', JSON.stringify(s4.highlight))
  await shot(page, '15-bus-show-focus')
  // bus: atlas.show tour auto, slide 2, present
  await page.evaluate(() => window.emit('atlas.show', { tour: 'overview', slide: 4, present: true }))
  await waitFor(frame, () => window.__present && !window.__present.busy && window.__present.slide === 3, null, 15000)
  await wait(900)
  check('atlas.show (tour + slide, present) from the bus', (await frame.evaluate(() => window.__present?.slide)) === 3)
  await shot(page, '16-bus-show-present')
  // Esc twice (unfocus, then up), up to the top, then exit
  for (let i = 0; i < 6 && (await state(frame)).mode === 'present'; i++) { await page.keyboard.press('Escape'); await wait(3500) }
  check('Esc at the top level exits the presenter', (await state(frame)).mode === 'explore')
  console.log(logs.join('\n'))
  await page.close()
}

// ---------------------------------------------------------------- auto tour + reduced motion (light)
await mock('tours=0')
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto(`${HOST}/harness.html?theme=light&src=${encodeURIComponent('/plugins/atlas/view')}`)
  const frame = await (await page.waitForSelector('#f')).contentFrame()
  await waitFor(frame, () => window.__atlas?.view === 'index')
  const s = await state(frame)
  check('auto tour derived when tours is null', s.tours?.[0]?.[0] === 'auto', JSON.stringify(s.tours))
  await frame.locator('.present-btn').click(); await wait(900)
  await page.keyboard.press('ArrowRight'); await wait(250)
  await shot(page, '17-present-auto-reduced-motion-light')
  await page.keyboard.press('End'); await wait(2500)
  await page.keyboard.press('ArrowRight'); await wait(1200)
  check('→ walks a whole-dynamic-view slide', (await frame.evaluate(() => window.__present.walk)) === 1)
  await shot(page, '18-present-auto-dynamic-walk-light')
  await ctx.close()
}

// ---------------------------------------------------------------- live reload: error banner + recovery
if (MODEL) {
  const f = join(MODEL, 'model.c4')
  const orig = readFileSync(f, 'utf8')
  const { page, frame } = await open('dark')
  await waitFor(frame, () => window.__atlas?.view === 'index')
  await frame.locator('.viewpick select').selectOption('proto_agent_detail'); await wait(2500)
  writeFileSync(f, orig.replace(/}\s*$/, '  broken_thing = component \'oops\' {\n    -> nowhere_at_all\n  }\n}\n'))
  const banner = await waitFor(frame, () => !!document.querySelector('[data-testid=error-banner]'), null, 10000)
  await wait(400)
  const s = await state(frame)
  check('error banner on ok:false, last good model kept', banner && s.view === 'proto_agent_detail' && s.stale === true, await frame.evaluate(() => document.querySelector('[data-testid=error-banner]')?.textContent?.slice(0, 160)))
  await shot(page, '20-error-banner')
  await frame.locator('.b-loc').first().click().catch(() => {}); await wait(300)
  const m = await page.evaluate(() => window.__msgs.filter((x) => x.type === 'protoagent:code:open').pop())
  check('error file:line opens the code pane', !!m && /model\.c4$/.test(m.path) && m.line > 0, JSON.stringify(m))
  // fix: rename an element → live reload keeps the view
  writeFileSync(f, orig.replace("'Server'", "'Server (live)'").replace(/title 'Server'/, "title 'Server'"))
  const fixed = await waitFor(frame, () => !document.querySelector('[data-testid=error-banner]'), null, 10000)
  await wait(800)
  check('recovers + keeps the current view after a fix', fixed && (await state(frame)).view === 'proto_agent_detail')
  await shot(page, '21-live-reload-recovered')
  writeFileSync(f, orig)
  await page.close()
}

// ---------------------------------------------------------------- empty + engine-missing states
for (const [sc, name, sel] of [['empty', '30-empty-state', '[data-testid=empty-state]'], ['nonode', '31-engine-missing', '[data-testid=engine-state]']]) {
  await mock(`scenario=${sc}`)
  const { page, frame } = await open('dark')
  const ok = await waitFor(frame, (s) => !!document.querySelector(s), sel)
  check(`${sc} state`, ok)
  await shot(page, name)
  await page.close()
}
// standalone (no console parent, no handshake): still loads, open-mode host
await mock('scenario=normal&token=')
{
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } })
  await page.goto(`${HOST}/plugins/atlas/view`)
  const ok = await waitFor(page.mainFrame(), () => window.__atlas?.view === 'index')
  check('standalone top-level load (no parent)', ok)
  await page.close()
}
await browser.close()
writeFileSync(join(OUT, 'results.txt'), results.join('\n') + '\n')
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`)
