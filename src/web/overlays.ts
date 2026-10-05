/**
 * The web demo's overlay switches: defaults, and the viewer's choices remembered in localStorage.
 * Storage can be missing or throw (private windows, blocked site data): then the switches still
 * work for this visit.
 */
import type { OverlayControl, OverlayName } from '../shared/api'

export const OVERLAY_DEFAULTS: Readonly<Record<OverlayName, boolean>> = { hands: true, mask: false, face: false, stats: false }
const KEY = 'skillcam.web.overlays'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function createOverlayControl(store: () => Store | null): OverlayControl {
  const state: Record<OverlayName, boolean> = { ...OVERLAY_DEFAULTS }
  try {
    const saved: unknown = JSON.parse(store()?.getItem(KEY) ?? '{}')
    if (saved && typeof saved === 'object') {
      for (const name of Object.keys(OVERLAY_DEFAULTS) as OverlayName[]) {
        const v = (saved as Record<string, unknown>)[name]
        if (typeof v === 'boolean') state[name] = v
      }
    }
  } catch {
    // Unreadable or corrupt: defaults.
  }
  const listeners: (() => void)[] = []
  return {
    state,
    set(name, on) {
      if (state[name] === on) return
      state[name] = on
      try {
        store()?.setItem(KEY, JSON.stringify(state))
      } catch {
        // Not saved: applies for this visit.
      }
      for (const cb of listeners) cb()
    },
    onChange: (cb) => void listeners.push(cb)
  }
}
