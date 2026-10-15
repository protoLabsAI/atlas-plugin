// PLAYWRIGHT_FROM=<dir with node_modules/playwright> node dev/console-theme.mjs --out <dir>
// Real-console verification: theming (light ↔ dark, a custom brand theme) + transition timing.
//   node dev/console-theme.mjs [--host http://127.0.0.1:7953] [--token atlas-int-token]
import { createRequire } from 'node:module'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = arg('--host', 'http://127.0.0.1:7953')
const TOKEN = arg('--token', 'atlas-int-token')
const OUT = arg('--out', '/tmp/atlas-viewer-shots')
const req = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))
const { chromium } = req('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => localStorage.setItem('protoagent.authToken', t), TOKEN)
const page = await ctx.newPage()
const logs = []
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message.slice(0, 200)))
const wait = (ms) => page.waitForTimeout(ms)
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') })
const results = []
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)) }

await page.goto(HOST + '/app/')
await wait(2500)
await page.getByRole('button', { name: /atlas/i }).first().click()
await wait(3000)
const frame = page.frames().find((f) => f.url().includes('/plugins/atlas/view'))
const st = () => frame.evaluate(() => ({ ...window.__atlas, contrast: window.__atlasContrast?.min }))
const setTheme = (mode, vars = {}) => page.evaluate(([mode, vars]) => {
  const r = document.documentElement
  r.setAttribute('data-theme', mode)
  for (let i = r.style.length - 1; i >= 0; i--) if (r.style[i].startsWith('--pl-')) r.style.removeProperty(r.style[i])
  for (const [k, v] of Object.entries(vars)) r.style.setProperty(k, v)
}, [mode, vars])

// ---- light (the console's [data-theme=light])
await setTheme('light'); await wait(900)
let s = await st()
check('light: scheme + contrast', s.scheme === 'light' && s.contrast >= 4.5, `contrast ${s.contrast}`)
await shot('theme-light-index')
// drill into the containers view (compound + relationships), keep it for the toggles
await frame.locator('.viewpick').selectOption('proto_agent_detail')
await wait(2600)
await shot('theme-light-containers')

// ---- live toggle → dark: same view, no remount
const layerKey = () => frame.evaluate(() => document.querySelector('.layer[data-active]')?.dataset.view + '|' + document.querySelectorAll('.layer').length)
const before = await layerKey()
await setTheme('dark'); await wait(900)
s = await st()
check('dark: live re-theme keeps the view', s.scheme === 'dark' && s.view === 'proto_agent_detail' && (await layerKey()) === before && s.contrast >= 4.5, `contrast ${s.contrast}`)
await shot('theme-dark-containers')
// details panel + a dynamic-view walkthrough in dark
await frame.locator('.react-flow__node', { hasText: /^Agent graph/ }).first().click({ position: { x: 30, y: 20 } }).catch(() => {})
await wait(600)
await shot('theme-dark-details')
await frame.locator('.viewpick').selectOption('chat_turn_flow'); await wait(2200)
await frame.getByRole('button', { name: /Walk through/ }).click(); await wait(1400)
await frame.getByRole('button', { name: 'Next step' }).click(); await wait(1400)
await shot('theme-dark-walkthrough')
// LikeC4's own Mantine overlay: the relationship browser
await frame.evaluate(() => window.__atlasStage?.diagram()?.openRelationshipsBrowser('proto_agent.graph'))
await wait(1500)
await shot('theme-dark-relationship-browser')
await frame.evaluate(() => window.__atlasStage?.diagram()?.overlays?.().send({ type: 'close.all' }))
await page.keyboard.press('Escape'); await wait(500)

// ---- a custom brand theme (an agent's config/theme.json-style override set)
const BRAND = { '--pl-color-accent': '#10b981', '--pl-color-accent-hover': '#34d399', '--pl-color-focus': '#10b981', '--pl-color-bg': '#0b1512', '--pl-color-bg-raised': '#11201b', '--pl-color-bg-subtle': '#16291f', '--pl-color-fg': '#e6f4ee', '--pl-color-fg-muted': '#93b5a7', '--pl-color-fg-on-accent': '#04120d', '--pl-color-border': 'rgba(160,255,210,.12)' }
await setTheme('dark', BRAND); await wait(900)
await frame.locator('.viewpick').selectOption('proto_agent_detail'); await wait(2600)
s = await st()
check('custom brand (forest) theme', s.contrast >= 4.5, `contrast ${s.contrast}`)
await shot('theme-custom-forest-containers')
await setTheme('light', { '--pl-color-accent': '#e11d48', '--pl-color-accent-hover': '#be123c', '--pl-color-focus': '#e11d48', '--pl-color-fg-on-accent': '#ffffff' }); await wait(900)
s = await st()
check('custom brand (rose, light) theme', s.contrast >= 4.5, `contrast ${s.contrast}`)
await shot('theme-custom-rose-light')

// ---- transition timing: frame strip of a drill-in (Open drill-down via the bus-free path: picker)
await setTheme('dark'); await wait(600)
await frame.locator('.viewpick').selectOption('index'); await wait(2600)
const frames = []
const t0 = Date.now()
await frame.evaluate(() => { window.__tStart = performance.now(); const sel = document.querySelector('.viewpick'); sel.value = 'proto_agent_detail'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
for (let i = 0; i < 12; i++) {
  const buf = await page.screenshot({ clip: { x: 64, y: 90, width: 946, height: 768 }, type: 'jpeg', quality: 70 })
  frames.push({ ms: Date.now() - t0, b64: buf.toString('base64') })
  await wait(80)
}
// duration from the stage itself
const dur = await frame.evaluate(async () => { while (document.documentElement.dataset.atlasTransition) await new Promise((r) => setTimeout(r, 16)); return Math.round(performance.now() - window.__tStart) })
check('zoom-in takes ~1.1–1.4 s at normal speed (incl. mount)', dur > 1050 && dur < 1700, dur + ' ms')
const strip = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await strip.setContent(`<body style="margin:0;background:#111;color:#ddd;font:12px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px">${frames.map((f) => `<figure style="margin:0"><img style="width:100%" src="data:image/jpeg;base64,${f.b64}"><figcaption>${f.ms} ms</figcaption></figure>`).join('')}</body>`)
await strip.screenshot({ path: join(OUT, 'theme-transition-strip.png'), fullPage: true })

// presenter speed keys
await frame.locator('.present-btn').click(); await wait(1500)
await page.keyboard.press('['); await wait(200)
const slow = await frame.evaluate(() => window.__present?.speed)
await shot('theme-present-speed-toast')
await page.keyboard.press(']'); await page.keyboard.press(']'); await wait(200)
const fast = await frame.evaluate(() => window.__present?.speed)
check('presenter [ / ] adjust speed live', slow === 'slow' && fast === 'fast', `${slow} → ${fast}`)
console.log(logs.join('\n'))
writeFileSync(join(OUT, 'theme-results.txt'), results.join('\n') + '\n')
await browser.close()
