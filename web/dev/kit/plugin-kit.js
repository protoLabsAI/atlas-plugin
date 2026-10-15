// Dev stub of the protoAgent DS plugin-kit.js — same exports + behaviour that Atlas uses:
// the protoagent:init / protoagent:theme handshake mapped onto --pl-* tokens, a bounded
// whenReady(), and a slug-aware, bearer-carrying apiFetch.
const TOKEN_MAP = { bg: ['--pl-color-bg'], bgPanel: ['--pl-color-bg-raised', '--pl-color-bg-subtle'], fg: ['--pl-color-fg'], fgMuted: ['--pl-color-fg-muted'], brand: ['--pl-color-accent'], border: ['--pl-color-border'] }
let token = null, done = false, resolveHs, listening = false
const hs = new Promise((r) => (resolveHs = r))
const listeners = new Set()
const embedded = () => { try { return window.parent !== window } catch { return false } }
function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return
  for (const [k, v] of Object.entries(theme)) {
    if (v == null || v === '') continue
    if (k.startsWith('--pl-')) document.documentElement.style.setProperty(k, String(v))
    else for (const t of TOKEN_MAP[k] ?? []) document.documentElement.style.setProperty(t, String(v))
  }
}
function onMessage(e) {
  const d = e?.data
  if (!d) return
  if (d.type === 'protoagent:init') { if (d.token) token = d.token; applyTheme(d.theme); if (!done) { done = true; resolveHs() } }
  else if (d.type === 'protoagent:theme') applyTheme(d.theme)
  else return
  for (const fn of listeners) try { fn({ token, theme: d.theme }) } catch {}
}
function ensure() {
  if (listening) return
  listening = true
  window.addEventListener('message', onMessage)
  if (embedded()) window.parent.postMessage({ type: 'protoagent:ready' }, '*')
}
export function initPluginView(cb) { if (typeof cb === 'function') listeners.add(cb); ensure(); return { getToken } }
export function getToken() { return token }
export function whenReady(ms = 2000) {
  if (done || !embedded()) return Promise.resolve(token)
  ensure()
  return Promise.race([hs, new Promise((r) => setTimeout(r, ms))]).then(() => token)
}
export function apiUrl(path) {
  if (typeof path !== 'string' || path[0] !== '/' || path.startsWith('//')) return path
  const i = location.pathname.indexOf('/plugins/')
  const base = i > 0 ? location.pathname.slice(0, i) : ''
  return !base || path.startsWith(base + '/') ? path : base + path
}
export async function apiFetch(input, init) {
  await whenReady()
  const opts = init || {}
  const headers = new Headers(opts.headers || {})
  if (token) headers.set('Authorization', 'Bearer ' + token)
  return fetch(typeof input === 'string' ? apiUrl(input) : input, { ...opts, headers })
}
