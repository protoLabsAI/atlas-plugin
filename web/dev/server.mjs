// Atlas viewer dev server — a stand-in for the protoAgent host + the Atlas backend.
//   node dev/server.mjs [--port 4720] [--model <dir>] [--project-root <dir>] [--real-kit]
//   --model defaults to ../examples/protoagent, --project-root to $ATLAS_PROJECT_ROOT or the repo;
//   --real-kit serves the console's built kit from $PROTOAGENT_DIR/apps/web/dist/_ds.
// Serves, at the host root AND under a fleet-style prefix (/agents/<slug>):
//   /plugins/atlas/view               → ../static/index.html (public)
//   /plugins/atlas/static/*           → ../static/* (public)
//   /_ds/plugin-kit.{css,js}          → dev/kit stubs (or the real kit with --real-kit)
//   /api/plugins/atlas/model          → the engine export of --model (ETag/304, last-good, stale)
//   /api/plugins/atlas/status         → node/engine/model-dir status
//   /api/fs/roots                     → {roots:{<name>: <project root>}}
//   /harness.html?src=<view path>&theme=dark|light  → a parent frame playing the console
//   POST /__mock?scenario=normal|empty|nonode&token=<t>&tours=0|1 → switch scenarios
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, extname, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const PORT = Number(arg('--port', 4720))
const MODEL_DIR = resolve(arg('--model', resolve(here, '../../examples/protoagent')))
const PROJECT_ROOT = resolve(arg('--project-root', process.env.ATLAS_PROJECT_ROOT || resolve(here, '../..')))
const PROJECT = arg('--project', '')  // '' → omit `project` so the viewer resolves it via /api/fs/roots
const STATIC = resolve(here, '../../static')
const ENGINE = resolve(here, '../../vendor/atlas-engine.mjs')
const REAL_KIT = process.env.PROTOAGENT_DIR ? join(process.env.PROTOAGENT_DIR, 'apps/web/dist/_ds') : ''
// the pinned @protolabsai/ui kit from node_modules (what a host serves at /_ds); --real-kit uses a
// protoAgent checkout's build; dev/kit stubs only when neither exists
const NPM_KIT = resolve(here, '../node_modules/@protolabsai/ui')
const KIT = process.argv.includes('--real-kit') && REAL_KIT && existsSync(REAL_KIT) ? REAL_KIT : existsSync(join(NPM_KIT, 'dist/plugin-kit.css')) ? NPM_KIT : join(here, 'kit')
const kitFile = (name) => (KIT === NPM_KIT ? join(KIT, name === 'plugin-kit.css' ? 'dist/plugin-kit.css' : 'src/plugin-kit.js') : join(KIT, name))
const state = { scenario: 'normal', token: '', tours: true, pane: true }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }

// Fallback tours for a model without its own atlas.tours.json: the bundled example's.
// the example's tours when serving the example model; else a sample for the atlas-spike skill-2 model
const EXAMPLE_DIR = resolve(here, '../../examples/protoagent')
const SAMPLE_TOURS = MODEL_DIR === EXAMPLE_DIR ? JSON.parse(readFileSync(join(EXAMPLE_DIR, 'atlas.tours.json'), 'utf8')) : { tours: [
  { id: 'overview', title: 'protoAgent in 5 minutes', slides: [
    { view: 'index', note: 'The landscape: an **operator**, the protoAgent runtime, and the systems it talks to.' },
    { view: 'index', focus: 'proto_agent', note: 'protoAgent is the system we own. Press *Enter* to open it.' },
    { view: 'proto_agent_detail', note: 'Inside: console, API server, agent graph, tools, knowledge.' },
    { view: 'proto_agent_detail', focus: 'proto_agent.graph', note: 'The agent graph owns the tool loop — `graph/agent.py`.' },
    { view: 'proto_agent_graph_detail', note: 'The graph: core loop, LLM client, middleware, subagents.' },
    { view: 'chat_turn_flow', step: 1, note: 'One chat turn: the operator sends a message.' },
    { view: 'chat_turn_flow', step: 3, note: 'The server hands the turn to the graph — it never calls the model directly.' },
    { view: 'chat_turn_flow', step: 5, note: 'The LLM client asks the gateway for a completion.' },
    { view: 'index', note: 'Back out to the landscape.' },
  ] },
] }

async function dirHash(dir) {
  const h = createHash('sha256')
  const walk = async (d) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else { const s = await stat(p); h.update(`${relative(dir, p)}|${s.mtimeMs}|${s.size}\n`) }
    }
  }
  await walk(dir)
  return h.digest('hex').slice(0, 16)
}

// mirror of the backend's links.classify
function classify(url, relativeTo) {
  url = (url || '').trim()
  if (/^https?:\/\//i.test(url)) return { kind: 'web', url }
  if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return { kind: 'other' }
  const [raw, frag = ''] = url.split('#')
  const m = /^L?(\d+)(?:-L?(\d+))?$/i.exec(frag)
  if (!raw || raw.startsWith('~')) return { kind: 'invalid', error: 'not a project file' }
  const target = raw.startsWith('/') ? join(PROJECT_ROOT, raw) : join(MODEL_DIR, (relativeTo || raw).split('#')[0])
  const rel = relative(PROJECT_ROOT, resolve(target))
  if (!rel || rel.startsWith('..')) return { kind: 'invalid', error: 'outside the project' }
  const out = { kind: 'code', path: rel }
  if (m) { out.line = Number(m[1]); if (m[2] && Number(m[2]) >= out.line) out.end_line = Number(m[2]) }
  return out
}
const normLinks = (ls) => Array.isArray(ls) ? ls.map((l) => (l && typeof l.url === 'string' ? { ...l, ...classify(l.url, l.relative) } : l)) : ls

let cache = { hash: null, payload: null }, lastGood = null
function runEngine() {
  return new Promise((res, rej) => execFile(process.execPath, [ENGINE, 'export', MODEL_DIR], { maxBuffer: 64 << 20, timeout: 60000 }, (err, out) => {
    if (err) return rej(err)
    try { res(JSON.parse(out)) } catch (e) { rej(e) }
  }))
}
async function modelPayload() {
  const base = { model_dir: MODEL_DIR, project_root: PROJECT_ROOT, ...(PROJECT ? { project: PROJECT } : {}) }
  if (state.scenario === 'empty') return { ...base, ok: false, errors: [{ message: `No architecture model at ${MODEL_DIR}` }], model: null, tours: null, hash: 'missing-x', exists: false, ms: 0, stale: false }
  if (state.scenario === 'nonode') return { ...base, ok: false, errors: [{ message: 'Node.js 20+ not found' }], model: null, tours: null, hash: 'x-nonode', exists: true, ms: 0, stale: false }
  const h = (await dirHash(MODEL_DIR)) + (state.tours ? 't' : '')
  if (cache.hash === h) return cache.payload
  const raw = await runEngine()
  const errors = (raw.errors || []).map((e) => ({ ...e, file: e.file ? relative(PROJECT_ROOT, e.file).startsWith('..') ? e.file : relative(PROJECT_ROOT, e.file) : e.file }))
  let tours = null
  if (existsSync(join(MODEL_DIR, 'atlas.tours.json'))) tours = JSON.parse(readFileSync(join(MODEL_DIR, 'atlas.tours.json'), 'utf8'))
  else if (state.tours) tours = SAMPLE_TOURS
  let payload
  if (raw.ok && raw.model) {
    const m = raw.model
    for (const el of Object.values(m.elements || {})) if (el.links) el.links = normLinks(el.links)
    for (const v of Object.values(m.views || {})) for (const n of v.nodes || []) if (n.links) n.links = normLinks(n.links)
    // a sample metadata block so the details panel has something to show
    if (m.elements?.['proto_agent.graph']) m.elements['proto_agent.graph'].metadata = { owner: 'core team', adr: 'ADR 0001, ADR 0023' }
    lastGood = { model: m, tours }
    payload = { ...base, ok: true, errors: [], model: m, tours, hash: h, exists: true, ms: raw.ms, stale: false }
  } else {
    payload = { ...base, ok: false, errors, model: lastGood?.model ?? null, tours: lastGood?.tours ?? null, hash: h, exists: true, ms: raw.ms, stale: !!lastGood }
  }
  cache = { hash: h, payload }
  return payload
}

function harness(q) {
  const src = q.get('src') || '/agents/foo/plugins/atlas/view'
  return `<!doctype html><html><head><meta charset="utf-8"><title>console harness</title>
<style>html,body{margin:0;height:100%;background:#222}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="f" src="${src}"></iframe><script>
const THEMES = {
  dark: { bg: '#0a0a0c', bgPanel: '#131316', fg: '#ededed', fgMuted: '#a1a1aa', brand: '#9b87f2', border: 'rgba(255,255,255,0.08)' },
  light: { bg: '#ffffff', bgPanel: '#f4f4f5', fg: '#18181b', fgMuted: '#52525b', brand: '#6d4fd8', border: 'rgba(0,0,0,0.12)' },
}
let theme = ${JSON.stringify(q.get('theme') || 'dark')}
const token = ${JSON.stringify(q.get('token') || 'dev-token')}
window.__msgs = []
let seq = 0
const f = document.getElementById('f')
const send = (m) => f.contentWindow.postMessage(m, location.origin)
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow) return
  window.__msgs.push(e.data)
  if (e.data?.type === 'protoagent:contextmenu:open') window.__menu = e.data
  if (e.data?.type === 'protoagent:ready') send({ type: 'protoagent:init', token, theme: THEMES[theme] })
})
f.addEventListener('load', () => send({ type: 'protoagent:init', token, theme: THEMES[theme] }))
window.setTheme = (t) => { theme = t; send({ type: 'protoagent:theme', theme: THEMES[t] }) }
window.menuAction = (id) => send({ type: 'protoagent:contextmenu:action', itemId: 'plugin.atlas.' + id })
window.emit = (topic, data) => send({ type: 'protoagent:event', topic, data, seq: ++seq })
</script></body></html>`
}

const send = (res, code, body, headers = {}) => { res.writeHead(code, headers); res.end(body) }
const json = (res, code, obj, headers = {}) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...headers })

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const path = u.pathname.replace(/^\/agents\/[^/]+(?=\/)/, '')  // fleet proxy prefix
  try {
    if (u.pathname === '/harness.html') return send(res, 200, harness(u.searchParams), { 'Content-Type': TYPES['.html'] })
    if (u.pathname === '/__mock') {
      for (const k of ['scenario', 'token']) if (u.searchParams.has(k)) state[k] = u.searchParams.get(k)
      if (u.searchParams.has('pane')) state.pane = u.searchParams.get('pane') === '1'
      if (u.searchParams.has('tours')) { state.tours = u.searchParams.get('tours') === '1'; cache.hash = null }
      return json(res, 200, state)
    }
    if (path === '/plugins/atlas/view') return send(res, 200, await readFile(join(STATIC, 'index.html')), { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' })
    if (path.startsWith('/plugins/atlas/static/')) {
      const f = resolve(STATIC, '.' + path.slice('/plugins/atlas/static'.length))
      if (!f.startsWith(STATIC + '/') || !existsSync(f)) return send(res, 404, 'not found')
      return send(res, 200, await readFile(f), { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' })
    }
    if (path === '/_ds/plugin-kit.css' || path === '/_ds/plugin-kit.js') return send(res, 200, await readFile(kitFile(path.slice(5))), { 'Content-Type': TYPES[extname(path)] })
    if (path.startsWith('/api/')) {
      if (state.token && req.headers.authorization !== `Bearer ${state.token}`) return json(res, 401, { detail: 'unauthorized' })
      if (path === '/api/runtime/status') return json(res, 200, { code_pane: { enabled: state.pane } })
      if (path === '/api/fs/roots') return json(res, 200, { roots: { protoAgent: PROJECT_ROOT, other: '/tmp' } })
      if (path === '/api/plugins/atlas/status')
        return json(res, 200, { node: state.scenario === 'nonode' ? { path: '', version: '', ok: false, source: '', error: 'no node ≥ 20 on PATH' } : { path: process.execPath, version: process.version, ok: true, source: 'path' }, model_dir: MODEL_DIR, exists: state.scenario !== 'empty', engine: 'vendor/atlas-engine.mjs', engine_present: true, project: PROJECT || 'protoAgent', project_root: PROJECT_ROOT })
      if (path === '/api/plugins/atlas/model') {
        const p = await modelPayload()
        const etag = `"${p.hash}"`
        if ((req.headers['if-none-match'] || '').split(',').map((s) => s.trim()).includes(etag)) return send(res, 304, '', { ETag: etag })
        return json(res, 200, p, { ETag: etag })
      }
    }
    send(res, 404, 'not found')
  } catch (e) {
    console.error(e)
    json(res, 500, { detail: String(e) })
  }
}).listen(PORT, () => console.log(`atlas dev server on http://localhost:${PORT}  model=${MODEL_DIR}  kit=${KIT}`))
