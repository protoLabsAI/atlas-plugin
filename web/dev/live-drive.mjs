// Live-navigation checks against the dev server's harness (dev/server.mjs): highlights, dims,
// edge paths, callouts, clear, operator takeover, atlas.viewing publishes.
//   PLAYWRIGHT_FROM=<dir> node dev/live-drive.mjs [--port 4720] [--out dir]
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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(`${HOST}/harness.html?theme=dark&src=${encodeURIComponent('/plugins/atlas/view')}`)
const frame = await (await page.waitForSelector('#f')).contentFrame()
const wait = (ms) => page.waitForTimeout(ms)
const check = (n, ok, x = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`)
const dimmed = () => frame.evaluate(() => {
  const ctx = window.__atlasStage?.diagram()?.getContext()
  return { dim: (ctx?.xynodes ?? []).filter((n) => n.data.dimmed).map((n) => n.id), lit: (ctx?.xynodes ?? []).filter((n) => !n.data.dimmed).map((n) => n.id), active: (ctx?.xyedges ?? []).filter((e) => e.data.active).map((e) => e.id) }
})
await wait(2500)
await page.evaluate(() => window.emit('atlas.show', { view: 'proto_agent_detail', focus: ['proto_agent.graph', 'proto_agent.knowledge', 'proto_agent.tools'], note: 'The **graph** owns the tool loop; tools + knowledge are its hands.' }))
await wait(3500)
let d = await dimmed()
check('multi-highlight dims the rest', d.lit.includes('proto_agent.graph') && d.dim.includes('proto_agent.console'), `lit ${d.lit.length} dim ${d.dim.length}`)
check('callout shown', (await frame.locator('[data-testid=callout]').count()) === 1)
await page.screenshot({ path: join(OUT, 'mock-live-multi.png') })
const edges = await frame.evaluate(() => window.__atlasStage.diagram().getContext().xyedges.filter((e) => ['proto_agent.console', 'proto_agent.server'].includes(e.source) && ['proto_agent.server', 'proto_agent.graph'].includes(e.target)).map((e) => e.id))
await page.evaluate((edges) => window.emit('atlas.show', { view: 'proto_agent_detail', focus: ['proto_agent.console', 'proto_agent.graph'], edges }), edges)
await wait(2500)
d = await dimmed()
check('edge path active', d.active.length === edges.length && edges.length > 0, d.active.join())
await page.screenshot({ path: join(OUT, 'mock-live-path.png') })
await page.evaluate(() => window.emit('atlas.clear', {}))
await wait(800)
d = await dimmed()
check('atlas.clear undims', d.dim.length === 0 && d.active.length === 0)
const pub = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'protoagent:publish').map((m) => m.data))
check('atlas.viewing published', pub.some((p) => p.view === 'proto_agent_detail' && p.focus?.length === 3), JSON.stringify(pub.at(-1)))
// operator takeover
await page.evaluate(() => window.emit('atlas.show', { view: 'proto_agent_detail', focus: ['proto_agent.graph'], note: 'hi' }))
await wait(2500)
await frame.locator('.react-flow__node', { hasText: /^Agent graph/ }).first().click({ position: { x: 20, y: 15 } })
await wait(900)
const st = await frame.evaluate(() => window.__atlas)
check('a click hands control back (highlight cleared, selection published)', !st.highlight && st.selected === 'proto_agent.graph', JSON.stringify(st.viewing))
console.log(errs.join('\n'))
await browser.close()
