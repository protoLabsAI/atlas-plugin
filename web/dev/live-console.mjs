// Real-console live-navigation proof: runs Atlas's own tool logic (dev/resolve_show.py) against
// the host's model, publishes the resolved atlas.show over POST /api/events/publish (as the
// tool's registry.emit would), and reads atlas.viewing back off the bus (GET /api/events).
//   PLAYWRIGHT_FROM=<dir> ATLAS_PY=<python with langchain_core> node dev/live-console.mjs [--host …] [--token …] [--out dir]
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const HOST = arg('--host', 'http://127.0.0.1:7953')
const TOKEN = arg('--token', 'atlas-int-token')
const OUT = arg('--out', join(tmpdir(), 'atlas-viewer-shots'))
const PY = process.env.ATLAS_PY ?? 'python3'
const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(join(process.env.PLAYWRIGHT_FROM ?? '.', 'package.json'))('playwright')
const cache = join(homedir(), 'Library/Caches/ms-playwright')
const shell = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop()
const auth = { Authorization: `Bearer ${TOKEN}` }

// the bus: keep the latest atlas.viewing
let viewing = null
const sse = await fetch(`${HOST}/api/events`, { headers: auth })
;(async () => {
  const dec = new TextDecoder(); let buf = ''
  for await (const chunk of sse.body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
      try { const m = JSON.parse(data); const t = m.event ?? m.topic; if (t === 'atlas.viewing') viewing = m.data } catch {}
    }
  }
})().catch(() => {})

const py = (req) => {
  const r = spawnSync(PY, [join(here, 'resolve_show.py')], { input: JSON.stringify(req), env: { ...process.env, ATLAS_HOST: HOST, ATLAS_TOKEN: TOKEN }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}
const show = async (kwargs) => {
  const out = py({ op: 'show', kwargs, state: viewing })
  console.log('atlas_show', JSON.stringify(kwargs), '→', out.text ?? out.error)
  if (out.event) await fetch(`${HOST}/api/events/publish`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'atlas.show', data: out.event }) })
  return out
}

const browser = await chromium.launch({ executablePath: join(cache, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => localStorage.setItem('protoagent.authToken', t), TOKEN)
const page = await ctx.newPage()
const wait = (ms) => page.waitForTimeout(ms)
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') })
const check = (n, ok, x = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`)
await page.goto(HOST + '/app/')
await wait(2500)
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
await page.getByRole('button', { name: /atlas/i }).first().click()
await wait(3500)
const frame = page.frames().find((f) => f.url().includes('/plugins/atlas/view'))
const settle = async () => {
  await wait(600)
  for (let i = 0; i < 100 && (await frame.evaluate(() => !!window.__atlasStage?.busy())); i++) await wait(100)
  await wait(1600) // the highlight's camera ease
}
const lit = () => frame.evaluate(() => {
  const c = window.__atlasStage?.diagram()?.getContext()
  return { view: c?.view?.id, lit: (c?.xynodes ?? []).filter((n) => !n.data.dimmed).map((n) => n.id), dim: (c?.xynodes ?? []).filter((n) => n.data.dimmed).length, active: (c?.xyedges ?? []).filter((e) => e.data.active).map((e) => e.id) }
})

let r = await show({ element: 'proto_agent.core.graph.llm_client' })
await settle()
let s = await lit()
check('element → auto view + highlight', s.view === r.event.view && s.lit.includes('proto_agent.core.graph.llm_client') && s.dim > 0, JSON.stringify(s))
await shot('live-element-resolve')

r = await show({ element: ['proto_agent.interfaces.server.chat', 'proto_agent.interfaces.server.turn_stream', 'proto_agent.interfaces.server.a2a_routes'] })
await settle()
s = await lit()
check('multi-highlight + dim', r.event && s.view === r.event.view && r.event.focus.every((f) => s.lit.includes(f)) && s.dim > 0, `${s.view} lit ${s.lit.length} dim ${s.dim}`)
await shot('live-multi-highlight')

r = await show({ relations: [['proto_agent.interfaces.console', 'proto_agent.core.graph']] })
await settle()
s = await lit()
check('edge path highlight', r.event && s.active.length === r.event.edges.length && s.active.length > 0, `${r.event?.view} edges ${s.active.join(',')}`)
await shot('live-edge-path')

r = await show({ element: 'gateway', relations: [['proto_agent.core', 'gateway']], note: 'Every model call leaves through the **LLM gateway** — model choice is gateway config, not code.' })
await settle()
check('callout', (await frame.locator('[data-testid=callout]').count()) === 1, r.text ?? r.error)
await shot('live-callout')

await show({ view: 'chat_turn_flow', step: 2 })
await settle()
r = await show({ step: 'next' })
await wait(2500)
const walk = await frame.evaluate(() => window.__atlas.walk)
check('flow step "next" from the operator\'s step', r.event?.step === 3 && walk === 3, `event step ${r.event?.step}, viewer step ${walk}, viewing ${JSON.stringify(viewing)}`)
await shot('live-flow-step-next')
const bad = await show({ view: 'chat_turn_flow', step: 42 })
check('bad step lists the steps', /out of range/.test(bad.error ?? '') && /1\. /.test(bad.error ?? ''))

// the operator takes over: picks a node → atlas_describe(current=True)
await show({ view: 'proto_agent_platform_detail' })
await settle()
await frame.locator('.react-flow__node', { hasText: /^Scheduler/ }).first().click({ position: { x: 30, y: 20 } })
await wait(2000)
const cur = py({ op: 'current', state: viewing })
check('atlas_describe(current=True) sees the selection', /Selected element: proto_agent\.platform\.scheduler/.test(cur.text), cur.text.replace(/\n/g, ' | '))
await shot('live-operator-selected')
await browser.close()
process.exit(0)
