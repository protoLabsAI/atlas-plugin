// Keyboard: presenter shortcuts never steal Tab / Enter from controls; the Tour options menu is a
// real menu (ArrowDown moves into it, Escape returns focus to the trigger).
//   PLAYWRIGHT_FROM=<dir> node dev/keyboard.mjs [--port 4720]   (needs dev/server.mjs)
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = `http://localhost:${arg('--port', '4720')}`
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(`${HOST}/plugins/atlas/view`)
await page.waitForFunction(() => window.__atlas?.view)
await page.waitForTimeout(1500)
const check = (n, ok, x = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`)
const active = () => page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label') ?? '', text: document.activeElement?.textContent?.trim().slice(0, 40), role: document.activeElement?.getAttribute('role') }))

// Tour options: open by keyboard, ArrowDown into the items, Escape back to the trigger
await page.getByRole('button', { name: 'Tour options' }).focus()
await page.keyboard.press('Enter'); await page.waitForTimeout(300)
await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150)
let a = await active()
check('menu: ArrowDown moves focus into the items', a.role === 'menuitem', JSON.stringify(a))
await page.keyboard.press('Escape'); await page.waitForTimeout(250)
a = await active()
check('menu: Escape returns focus to the trigger', a.label === 'Tour options', JSON.stringify(a))

// 'p' on a focused button is the button's, not ours
await page.keyboard.press('p'); await page.waitForTimeout(600)
check('explore: shortcuts ignored while a control has focus', (await page.evaluate(() => window.__atlas.mode)) === 'explore')
// presenter: Tab reaches Exit, Enter activates it (no drill, no focus-cycling)
await page.mouse.click(400, 400); await page.waitForTimeout(300) // the canvas
await page.keyboard.press('p'); await page.waitForTimeout(2500)
check('presenting', (await page.evaluate(() => window.__atlas.mode)) === 'present')
let found = false
for (let i = 0; i < 25 && !found; i++) {
  await page.keyboard.press('Tab')
  found = (await active()).label === 'Exit presenter'
}
check('presenter: Tab reaches the Exit button (native tab order)', found)
await page.keyboard.press('Enter'); await page.waitForTimeout(800)
check('presenter: Enter activates Exit (not a drill)', (await page.evaluate(() => window.__atlas.mode)) === 'explore')
// on the diagram surface the shortcuts still work
await page.keyboard.press('p'); await page.waitForTimeout(2500)
await page.mouse.click(5, 400) // the canvas
const s0 = await page.evaluate(() => window.__present.slide)
await page.keyboard.press('ArrowRight'); await page.waitForTimeout(2500)
check('presenter: → on the diagram still advances', (await page.evaluate(() => window.__present.slide)) === s0 + 1)
await browser.close()
