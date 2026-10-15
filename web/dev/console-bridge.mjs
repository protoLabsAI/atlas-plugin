// Real-console verification of the bridge: code links (pane/editor routing + pane-off hint),
// node context menu through the console, host chord forwarding.
//   PLAYWRIGHT_FROM=<dir> node dev/console-bridge.mjs [--host http://127.0.0.1:7953] [--token …] [--out dir]
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = arg('--host', 'http://127.0.0.1:7953')
const TOKEN = arg('--token', 'atlas-int-token')
const OUT = arg('--out', join(tmpdir(), 'atlas-viewer-shots'))
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => localStorage.setItem('protoagent.authToken', t), TOKEN)
const page = await ctx.newPage()
const wait = (ms) => page.waitForTimeout(ms)
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') })
const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
await page.goto(HOST + '/app/')
await wait(2500)
await page.getByRole('button', { name: /atlas/i }).first().click()
await wait(3000)
const frame = page.frames().find((f) => f.url().includes('/plugins/atlas/view'))
// capture what the iframe posts to the console
await frame.evaluate(() => { const orig = window.parent.postMessage.bind(window.parent); window.__sent = []; window.parent.postMessage = (m, o) => { window.__sent.push([m, o]); return orig(m, o) } })
const paneOn = await frame.evaluate(() => window.__atlas?.paneOn)
await frame.locator('.viewpick select').selectOption('proto_agent_detail'); await wait(2600)
await frame.locator('.react-flow__node', { hasText: /^Agent graph/ }).first().click({ position: { x: 30, y: 20 } }); await wait(600)
const hint = await frame.locator('[data-testid=pane-hint]').count()
await shot('bridge-details-code-actions')
await frame.locator('[data-testid=code-link]').first().click(); await wait(1200)
const sent = await frame.evaluate(() => window.__sent.filter(([m]) => m.type === 'protoagent:code:open').map(([m, o]) => ({ ...m, _origin: o })))
check(`code link (pane ${paneOn ? 'on' : 'off'})`, sent.length === 1 && sent[0].open_in === (paneOn === false ? 'editor' : 'pane') && sent[0]._origin === new URL(HOST).origin && (paneOn !== false || hint === 1), JSON.stringify(sent[0]))
await shot('bridge-code-open-result')
// node context menu → the console renders it
await frame.locator('.react-flow__node', { hasText: /^Tools/ }).first().click({ button: 'right', position: { x: 30, y: 20 } }); await wait(700)
const menu = await page.locator('[role=menu]').count()
await shot('bridge-context-menu')
const item = page.getByRole('menuitem', { name: /Show details/ })
if (await item.count()) { await item.first().click(); await wait(600) }
check('node right-click → console context menu → action', menu > 0 && (await frame.evaluate(() => window.__atlas.selected)) === 'proto_agent.tools', `menus=${menu}`)
// host chord ⌘K / ⌘⇧K forwarded
await frame.locator('.react-flow__pane').first().click({ position: { x: 20, y: 20 } }).catch(() => {})
await page.keyboard.press('Meta+Shift+K'); await wait(800)
const kd = await frame.evaluate(() => window.__sent.filter(([m]) => m.type === 'protoagent:keydown').map(([m]) => m.combo))
await shot('bridge-host-chord')
check('host chord forwarded', kd.includes('mod+shift+k'), kd.join())
await browser.close()
