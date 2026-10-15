// Generates ../THIRD_PARTY_NOTICES.md from what the two shipped bundles ACTUALLY contain:
//   - vendor/atlas-engine.mjs — the inputs esbuild recorded in build/engine-meta.json
//     (`npm run build:engine` writes it with --metafile);
//   - static/assets/* — the modules a viewer build pulls in. Rather than touching the viewer's
//     vite.config.mjs, this re-runs that exact config into a temp dir with one extra plugin that
//     records every chunk's module ids.
// For each package: name, version, license, repository, and the verbatim LICENSE / NOTICE /
// COPYING files it ships. Graphviz (compiled to WASM inside @hpcc-js/wasm-graphviz) gets its
// EPL text, its native deps' licenses, and a statement of where its exact source lives.
//
//   npm run notices        (after build:engine; `npm run build` runs all three)

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(WEB, '..')
const OUT = join(REPO, 'THIRD_PARTY_NOTICES.md')
const LICENSES = join(WEB, 'licenses')
const NM = `node_modules${sep}`

function packageRoot(file) {
  const clean = file.replace(/^\0+/, '').split('?')[0]
  const i = clean.lastIndexOf(NM)
  if (i < 0) return null
  const rest = clean.slice(i + NM.length).split(sep)
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
  return { root: clean.slice(0, i + NM.length) + name.split('/').join(sep), name }
}

// ── the engine bundle ─────────────────────────────────────────────────────────────────────
const metaPath = join(WEB, 'build', 'engine-meta.json')
if (!existsSync(metaPath)) {
  console.error('notices: build/engine-meta.json missing — run `npm run build:engine` first')
  process.exit(1)
}
const engineInputs = Object.keys(JSON.parse(readFileSync(metaPath, 'utf8')).inputs).map((p) => join(WEB, p))

// ── the viewer bundle ─────────────────────────────────────────────────────────────────────
async function viewerModules() {
  const { build } = await import('vite')
  const { default: cfg } = await import(join(WEB, 'vite.config.mjs'))
  const ids = new Set()
  const out = mkdtempSync(join(tmpdir(), 'atlas-notices-'))
  try {
    await build({
      ...cfg,
      configFile: false,
      root: WEB,
      logLevel: 'error',
      build: { ...cfg.build, outDir: out, emptyOutDir: true },
      plugins: [
        ...(cfg.plugins || []),
        {
          name: 'atlas-notices-collect',
          generateBundle(_o, bundle) {
            for (const c of Object.values(bundle)) if (c.type === 'chunk') for (const id of c.moduleIds) ids.add(id)
          },
        },
      ],
    })
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
  return [...ids]
}
const viewerInputs = await viewerModules()

// ── packages ──────────────────────────────────────────────────────────────────────────────
const pkgs = new Map() // root → {name, version, license, repo, bundles:Set, files:[[name,text]]}
function add(file, bundle) {
  const p = packageRoot(file)
  if (!p) return
  let entry = pkgs.get(p.root)
  if (!entry && !existsSync(join(p.root, 'package.json'))) {
    // A dependency PRE-BUNDLED into another package's dist (e.g. @likec4/diagram inlines
    // @tabler/icons-react from its pnpm store) — no package.json ships with it. Name + version
    // come from the pnpm store dir; the license text from web/licenses/<scope__name>-LICENSE.txt.
    const m = p.root.match(/\.pnpm\/((?:@[^_/]+_)?[^@/]+)@([^_/]+)/)
    const version = m ? m[2] : '?'
    const lic = join(LICENSES, `${p.name.replace('@', '').replace('/', '__')}-LICENSE.txt`)
    if (!existsSync(lic)) {
      console.error(`notices: ${p.name} is inlined at ${p.root} with no package.json — add ${lic}`)
      process.exit(1)
    }
    const text = readFileSync(lic, 'utf8').trim()
    const host = packageRoot(p.root.slice(0, p.root.indexOf(`${sep}dist${sep}`)) || '')
    entry = {
      name: p.name,
      version,
      license: /^MIT License/.test(text) ? 'MIT' : 'see license file',
      repo: host ? `inlined in ${host.name}'s dist` : '',
      bundles: new Set(),
      files: [['LICENSE', text]],
    }
    pkgs.set(p.root, entry)
  }
  if (!entry) {
    const pj = JSON.parse(readFileSync(join(p.root, 'package.json'), 'utf8'))
    const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url || pj.homepage || ''
    let files = readdirSync(p.root)
      .filter((f) => /^(licen[cs]e|copying|notice|authors)([.-].*)?$/i.test(f))
      .sort()
      .map((f) => [f, readFileSync(join(p.root, f), 'utf8').trim()])
    if (!files.length) {
      // No license file in the npm package → the upstream repo's, vendored in web/licenses/.
      const lic = join(LICENSES, `${(pj.name || p.name).replace('@', '').replace('/', '__')}-LICENSE.txt`)
      if (existsSync(lic)) files.push(['LICENSE (from the upstream repository)', readFileSync(lic, 'utf8').trim()])
    }
    const license = typeof pj.license === 'string' ? pj.license : pj.license?.type || (pj.licenses || []).map((l) => l.type).join(' OR ')
    entry = { name: pj.name || p.name, version: pj.version, license: license || 'see license file', repo, bundles: new Set(), files }
    pkgs.set(p.root, entry)
  }
  entry.bundles.add(bundle)
}
for (const f of engineInputs) add(f, 'engine')
for (const f of viewerInputs) add(f, 'viewer')
const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

// ── graphviz (native code inside the WASM) ───────────────────────────────────────────────
const hpcc = list.find((p) => p.name === '@hpcc-js/wasm-graphviz')
let graphviz = ''
if (hpcc) {
  const { Graphviz } = await import('@hpcc-js/wasm-graphviz')
  const gv = (await Graphviz.load()).version()
  const eplFile = join(LICENSES, `graphviz-${gv}-COPYING.txt`)
  if (!existsSync(eplFile)) {
    console.error(`notices: Graphviz is now ${gv} — add web/licenses/graphviz-${gv}-COPYING.txt from https://gitlab.com/graphviz/graphviz/-/raw/${gv}/COPYING`)
    process.exit(1)
  }
  const tag = `wasm-graphviz-v${hpcc.version}`
  graphviz = [
    `## Graphviz ${gv} (inside @hpcc-js/wasm-graphviz ${hpcc.version}) — EPL-2.0`,
    '',
    `The layout engine embeds [Graphviz](https://graphviz.org) ${gv}, compiled to WebAssembly by`,
    `\`@hpcc-js/wasm-graphviz\` ${hpcc.version}. Graphviz is licensed under the Eclipse Public License 2.0 (below).`,
    '',
    '**Source code availability.** The complete corresponding source of the Graphviz code in this',
    'distribution is available, free of charge, from:',
    '',
    `- Graphviz ${gv}: https://gitlab.com/graphviz/graphviz/-/tree/${gv} (archive: https://gitlab.com/graphviz/graphviz/-/archive/${gv}/graphviz-${gv}.tar.gz)`,
    `- the WASM build recipe and patches: https://github.com/hpcc-systems/hpcc-js-wasm/tree/${tag} (\`vcpkg-overlays/graphviz\`, \`src-cpp/graphviz\`)`,
    '',
    'The WASM build also links Graphviz\'s native dependencies **expat** (MIT) and **zlib** (zlib license); their',
    'notices follow the EPL text. Source: https://github.com/libexpat/libexpat and https://github.com/madler/zlib.',
    '',
    '```text',
    readFileSync(eplFile, 'utf8').trim(),
    '```',
    '',
    '### expat',
    '',
    '```text',
    readFileSync(join(LICENSES, 'expat-COPYING.txt'), 'utf8').trim(),
    '```',
    '',
    '### zlib',
    '',
    '```text',
    readFileSync(join(LICENSES, 'zlib-LICENSE.txt'), 'utf8').trim(),
    '```',
    '',
  ].join('\n')
}

const bare = list.filter((p) => !p.files.length)
if (bare.length) {
  for (const p of bare) console.error(`notices: ${p.name} ${p.version} ships no license file — add web/licenses/${p.name.replace('@', '').replace('/', '__')}-LICENSE.txt from its repository`)
  process.exit(1)
}

// ── write ─────────────────────────────────────────────────────────────────────────────────
const fence = (t) => '```text\n' + t.replace(/```/g, "'''") + '\n```'
const lines = [
  '# Third-party notices',
  '',
  '<!-- GENERATED by web/scripts/notices.mjs from the bundles\' real inputs — do not edit by hand. -->',
  '',
  'Atlas ships two prebuilt bundles that include third-party code:',
  '',
  '- `vendor/atlas-engine.mjs` — the LikeC4 parser + Graphviz-WASM layout engine (**engine**);',
  '- `static/assets/*` — the diagram viewer (**viewer**).',
  '',
  `${list.length} packages are included. Each is listed with its license and the license / notice files it ships, verbatim.`,
  'Packages under the Apache License 2.0 are provided under its terms; its full text is in the appendix, and any NOTICE',
  'files they ship are reproduced in their sections.',
  '',
  '| Package | Version | License | Bundle |',
  '|---|---|---|---|',
  ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${[...p.bundles].sort().join(', ')} |`),
  '',
]
if (graphviz) lines.push(graphviz)
lines.push('## Packages', '')
for (const p of list) {
  lines.push(`### ${p.name} ${p.version}`, '', `License: ${p.license}${p.repo ? ` · ${p.repo.replace(/^git\+/, '')}` : ''}`, '')
  for (const [name, text] of p.files) lines.push(`\`${name}\`:`, '', fence(text), '')
}
const legal = join(REPO, 'vendor', 'atlas-engine.mjs.LEGAL.txt')
if (existsSync(legal)) {
  lines.push('## License comments preserved from the engine bundle', '', fence(readFileSync(legal, 'utf8').trim()), '')
}
lines.push('## Appendix: Apache License 2.0', '', fence(readFileSync(join(LICENSES, 'Apache-2.0.txt'), 'utf8').trim()), '')
writeFileSync(OUT, lines.join('\n'))
console.log(`notices: ${list.length} packages (${engineInputs.length} engine inputs, ${viewerInputs.length} viewer modules) → THIRD_PARTY_NOTICES.md`)
