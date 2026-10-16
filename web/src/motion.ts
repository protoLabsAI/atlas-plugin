// Shared motion settings: the plugin's `transition_speed` (status route), adjustable live in
// the presenter with [ and ]. prefers-reduced-motion always wins (short fades, no zooms).
import { interpolateZoom } from './logic.mjs'

export type Speed = 'slow' | 'normal' | 'fast'
export const SPEEDS: Speed[] = ['fast', 'normal', 'slow']
export const SPEED_FACTOR: Record<Speed, number> = { fast: 0.6, normal: 1, slow: 1.6 }
export const ZOOM_MS = 1150 // zoom into / out of a node (normal speed)
export const FADE_MS = 700 // crossfade between unrelated views
export const JUMP_MS = 1100 // a cousin / multi-level jump: one crossfade-zoom, no stops
export const DIVE_MS = 1600 // several levels straight down / up: every zoom on ONE eased timeline
export const CAMERA_SCALE = 1.8 // LikeC4's own camera moves (focus, fit, walkthrough steps): 450 ms → ~810 ms

const URL_SLOW = Number(new URLSearchParams(location.search).get('slow') ?? 1) || 1 // screenshot aid
let speed: Speed = 'normal'
const subs = new Set<(s: Speed) => void>()

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
export const factor = () => SPEED_FACTOR[speed] * URL_SLOW
export const getSpeed = () => speed
export function setSpeed(s: unknown) {
  const v = (SPEEDS as unknown[]).includes(s) ? (s as Speed) : 'normal'
  if (v === speed) return
  speed = v
  subs.forEach((f) => f(v))
}
export function stepSpeed(dir: 1 | -1) {
  // ] = faster, [ = slower
  const i = SPEEDS.indexOf(speed) + (dir > 0 ? -1 : 1)
  setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i))])
  return speed
}
export function onSpeed(f: (s: Speed) => void) {
  subs.add(f)
  return () => subs.delete(f)
}
type VP = { x: number; y: number; zoom: number }
/** viewport ↔ (centre x, centre y, visible width) in flow space, for van Wijk flights */
export const toView = (vp: VP, W: number, H: number): [number, number, number] => [(W / 2 - vp.x) / vp.zoom, (H / 2 - vp.y) / vp.zoom, W / vp.zoom]
export const viewToVp = ([cx, cy, w]: number[], W: number, H: number): VP => {
  const zoom = W / w
  return { x: W / 2 - cx * zoom, y: H / 2 - cy * zoom, zoom }
}
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Slow + ease LikeC4's own animated camera moves (they go through xyflow's panZoom.setViewport). */
export function patchCamera(diagram: any, onMove?: (zoom: number, ms: number, vp?: any) => void, transform?: (vp: any) => any, fly = false, onArrive?: (vp: any) => void) {
  try {
    const store = diagram?.getContext?.()?.xystore
    const pz = store?.getState?.()?.panZoom
    if (!pz || pz.__atlas) return
    const orig = pz.setViewport.bind(pz)
    let flight = 0
    pz.setViewport = (vp: any, opts?: any) => {
      flight++ // any new move ends a flight under way
      if (!opts?.duration) return orig(vp, opts)
      const ms = reducedMotion() ? Math.min(opts.duration, 150) : Math.round(opts.duration * CAMERA_SCALE * factor())
      // the owner may re-aim the move (present / record: into the safe rect, at the slide's subject)
      if (transform) vp = transform(vp) ?? vp
      // tell the owner where this animated move ENDS, before it starts (text visibility decides from it)
      if (typeof vp?.zoom === 'number') onMove?.(vp.zoom, ms, vp)
      if (reducedMotion()) return orig(vp, { ...opts, duration: ms })
      if (fly) {
        // one smooth eased flight (van Wijk): a near move is a plain pan / zoom, a far one eases out
        // a little mid-way so source and target both stay in view — never a blank canvas
        const { width: W, height: H, transform: tr } = store.getState()
        if (W > 0 && H > 0 && tr) {
          const from = { x: tr[0], y: tr[1], zoom: tr[2] }
          if (Math.abs(from.x - vp.x) < 0.5 && Math.abs(from.y - vp.y) < 0.5 && Math.abs(from.zoom / vp.zoom - 1) < 1e-3) {
            // already there: no flight — it has landed
            orig(vp)
            onArrive?.(vp)
            return Promise.resolve(true)
          }
          const zi = interpolateZoom(1.2)(toView(from, W, H), toView(vp, W, H))
          const id = flight
          const t0 = performance.now()
          return new Promise<boolean>((resolve) => {
            const tick = (now: number) => {
              if (id !== flight) return resolve(false)
              const t = Math.min(1, (now - t0) / ms)
              orig(viewToVp(zi(easeInOutCubic(t)), W, H))
              if (t < 1) requestAnimationFrame(tick)
              else {
                onArrive?.(vp) // landed: the owner's at-rest rules apply from this frame
                resolve(true)
              }
            }
            requestAnimationFrame(tick)
          })
        }
      }
      return orig(vp, { ...opts, duration: ms, ease: easeInOutCubic })
    }
    pz.__atlas = true
  } catch {
    /* internals moved — LikeC4's default timing stays */
  }
}
