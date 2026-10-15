// Host integration: the DS plugin kit (handshake, bearer, theme), the bus bridge, and
// messages to the console (code pane). See protoAgent docs/reference/plugin-view-bridge.md.
import { parentOriginOf, schemeForRgb } from './logic.mjs'

export type Kit = {
  initPluginView: (cb?: (x: { token: string | null; theme: any }) => void) => any
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>
  getToken?: () => string | null
}

export const BASE: string = (window as any).ATLAS_BASE ?? location.pathname.split('/plugins/')[0]
export const embedded = (() => {
  try {
    return window.parent !== window
  } catch {
    return false
  }
})()

export async function loadKit(): Promise<Kit> {
  try {
    const kit = await import(/* @vite-ignore */ `${BASE}/_ds/plugin-kit.js`)
    if (typeof kit.apiFetch === 'function') return kit as Kit
  } catch {
    /* an older host with no /_ds — tokenless shim */
  }
  return {
    initPluginView: (cb) => {
      cb?.({ token: null, theme: null })
    },
    apiFetch: (p, i) => fetch(BASE + p, i),
    getToken: () => null,
  }
}

/** The console frame's origin — never "*": under the desktop app the console is
 *  tauri://localhost while this page is http://127.0.0.1, so it can't be assumed equal. */
export const PARENT_ORIGIN: string = parentOriginOf({
  ancestorOrigins: (location as any).ancestorOrigins ? Array.from((location as any).ancestorOrigins as ArrayLike<string>) : [],
  referrer: document.referrer,
  origin: location.origin,
})

/** A message really from the console: our parent window, at its origin. */
export function fromParent(e: MessageEvent) {
  return embedded && e.source === window.parent && (e.origin === PARENT_ORIGIN || e.origin === location.origin)
}

export function post(msg: Record<string, unknown>) {
  if (!embedded) return false
  try {
    window.parent.postMessage(msg, PARENT_ORIGIN)
    return true
  } catch {
    return false
  }
}

/** Subscribe this view to the plugin's bus topics (atlas.show). Patterns REPLACE. */
export function subscribeBus(since?: number) {
  post({ type: 'protoagent:subscribe', patterns: ['atlas.#'], ...(since ? { since } : {}) })
}

// ---------------------------------------------------------------- theme

const probe = (() => {
  try {
    return document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  } catch {
    return null
  }
})()

/** Resolve a CSS color token to RGB through a canvas pixel (handles hex/rgb/oklch/color-mix). */
export function tokenRGB(name: string, fallback: string): [number, number, number] | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw || !probe) return null
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = fallback
  probe.fillStyle = raw
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

/** 'light' | 'dark' from the console's live --pl-color-bg (else the OS preference). */
export function currentScheme(): 'light' | 'dark' {
  const rgb = tokenRGB('--pl-color-bg', '#0a0a0c')
  if (rgb) return schemeForRgb(rgb) as 'light' | 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
