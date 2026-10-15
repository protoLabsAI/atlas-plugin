// atlas-engine: validate / export a LikeC4 workspace as JSON on stdout.
import { statSync } from 'node:fs'
import { fromWorkspace } from '@likec4/language-services/node'
const [cmd, dir] = process.argv.slice(2)
const t0 = performance.now()
let isDir = false
try { isDir = statSync(dir).isDirectory() } catch {}
if (!isDir) {
  // LikeC4 treats a missing workspace as an empty, valid one — say so instead.
  process.stdout.write(JSON.stringify({ ok: false, errors: [{ message: `model directory not found: ${dir}`, file: dir, line: 1 }], ms: 0 }))
  process.exit(0)
}
const likec4 = await fromWorkspace(dir, { printErrors: false, throwIfInvalid: false, graphviz: 'wasm', watch: false })
const errors = likec4.getErrors().map(e => ({ message: e.message, file: e.sourceFsPath, line: e.range?.start?.line + 1 }))
const out = { ok: errors.length === 0, errors, ms: 0 }
if (cmd === 'export') {
  const model = await likec4.layoutedModel()
  out.model = model.$data
}
out.ms = Math.round(performance.now() - t0)
process.stdout.write(JSON.stringify(out))
await likec4.dispose()
