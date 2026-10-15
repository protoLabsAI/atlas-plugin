// likec4.config.ts loading is not supported by the vendored engine — use likec4.config.json.
export async function bundleRequire() {
  throw new Error('atlas: likec4.config.ts/.js is not supported; use likec4.config.json')
}
export const JS_EXT_RE = /\.(mjs|cjs|ts|js|tsx|jsx)$/
