// Shared motion settings: the plugin's `transition_speed` (status route), adjustable live in
// the presenter with [ and ]. prefers-reduced-motion always wins (short fades, no zooms).
export type Speed = 'slow' | 'normal' | 'fast'
export const SPEEDS: Speed[] = ['fast', 'normal', 'slow']
export const SPEED_FACTOR: Record<Speed, number> = { fast: 0.6, normal: 1, slow: 1.6 }
export const ZOOM_MS = 1150 // zoom into / out of a node (normal speed)
export const FADE_MS = 700 // crossfade between unrelated views
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
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Slow + ease LikeC4's own animated camera moves (they go through xyflow's panZoom.setViewport). */
export function patchCamera(diagram: any, onMove?: (zoom: number, ms: number) => void, transform?: (vp: any) => any) {
  try {
    const pz = diagram?.getContext?.()?.xystore?.getState?.()?.panZoom
    if (!pz || pz.__atlas) return
    const orig = pz.setViewport.bind(pz)
    pz.setViewport = (vp: any, opts?: any) => {
      if (!opts?.duration) return orig(vp, opts)
      const ms = reducedMotion() ? Math.min(opts.duration, 150) : Math.round(opts.duration * CAMERA_SCALE * factor())
      // the owner may re-aim the move (present / record: into the safe rect, at the slide's subject)
      if (transform) vp = transform(vp) ?? vp
      // tell the owner where this animated move ENDS, before it starts (text visibility decides from it)
      if (typeof vp?.zoom === 'number') onMove?.(vp.zoom, ms)
      if (reducedMotion()) return orig(vp, { ...opts, duration: ms })
      return orig(vp, { ...opts, duration: ms, ease: easeInOutCubic })
    }
    pz.__atlas = true
  } catch {
    /* internals moved — LikeC4's default timing stays */
  }
}
