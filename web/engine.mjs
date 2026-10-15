// atlas-engine: validate / export a LikeC4 workspace as JSON on stdout.
import { fromWorkspace } from '@likec4/language-services/node'
const [cmd, dir] = process.argv.slice(2)
const t0 = performance.now()
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
