// Builds the Atlas viewer into ../static (committed). One JS bundle with a content hash
// (the backend serves static/assets/* as immutable) + an index.html generated here whose
// tiny inline bootstrap computes the slug-aware BASE and loads
// `${BASE}/plugins/atlas/static/assets/atlas-<hash>.js` — the page itself lives at
// `<BASE>/plugins/atlas/view` (no trailing slash), so relative asset URLs can't work.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

function atlasIndex() {
  return {
    name: 'atlas-index',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry)
      if (!entry) this.error('no entry chunk')
      const css = readFileSync(here('./src/atlas.css'), 'utf8')
        .replace(/\/\*[^]*?\*\//g, '')
        .replace(/\s*\n\s*/g, '\n')
        .trim()
      // a GENERATED snapshot of the DS token defaults (the :root block of the pinned
      // @protolabsai/ui plugin-kit.css) — only used when the host serves no /_ds kit
      const kit = readFileSync(here('./node_modules/@protolabsai/ui/dist/plugin-kit.css'), 'utf8')
      const tokens = (kit.match(/:root\s*\{[^}]*\}/) ?? [''])[0].replace(/\s*\n\s*/g, '')
      const html = readFileSync(here('./src/index.template.html'), 'utf8')
        .replace('/*__ATLAS_TOKENS__*/', () => tokens)
        .replace('/*__ATLAS_CSS__*/', () => css)
        .replace('__ATLAS_ENTRY__', entry.fileName)
      this.emitFile({ type: 'asset', fileName: 'index.html', source: html })
    },
  }
}

export default defineConfig({
  plugins: [react(), atlasIndex()],
  base: './',
  logLevel: 'warn',
  build: {
    outDir: here('../static'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    copyPublicDir: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4096,
    rolldownOptions: {
      input: here('./src/main.tsx'),
      output: {
        entryFileNames: 'assets/atlas-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        codeSplitting: false,
      },
    },
  },
})
