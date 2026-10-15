import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadKit } from './host'

async function main() {
  // RULE 4: the DS kit owns the protoagent:init handshake (bearer + theme) + slug-aware apiFetch
  const kit = await loadKit()
  kit.initPluginView()
  createRoot(document.getElementById('root')!).render(<App kit={kit} />)
}
main().catch((e) => {
  console.error(e)
  const b = document.getElementById('boot')
  if (b) b.textContent = 'Atlas failed to start: ' + e
})
