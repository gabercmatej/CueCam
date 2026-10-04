/**
 * Clap = what the camera sees AND what the mic hears: hands meeting fast (visual contact, from the
 * gesture tracker) plus a clap-like sound onset (clapOnset worklet, raw mic), within `windowMs` of each
 * other, in either order. Neither alone fires: fixing your hair is a fast approach with no bang, and a
 * clap off camera (or a door) is a bang with no hands.
 *
 * Both are stamped on the performance.now clock: the contact with its camera frame time, the sound with
 * its onset sample. They usually arrive in that order too (the sound is confirmed only once it has
 * decayed, ~20–80 ms), so a contact waits up to `windowMs` + `SOUND_LAG_MS` for its sound.
 */
import type { Point } from '../../shared/types'

export interface ClapFusionSettings {
  /** Contact and sound must be at most this far apart. */
  windowMs: number
  /** false = visual contact alone fires (the Phase 3b behaviour, for when there is no mic). */
  requireSound: boolean
}

export interface FusedClap {
  /** The contact's camera frame time. */
  at: number
  position: Point
  /** Sound onset minus contact time (negative: the sound came first). */
  offsetMs: number
}

/** A sound is reported this long after its onset at most (confirmation + delivery). */
export const SOUND_LAG_MS = 120
/** A contact is reported this long after its frame at most (tracking + the merge case). */
const CONTACT_LAG_MS = 150

export class ClapFusion {
  settings: ClapFusionSettings = { windowMs: 150, requireSound: true }
  private contact: { at: number; position: Point } | null = null
  private sounds: number[] = []
  /** Counts since start, for the Control window. */
  readonly stats = { fused: 0, contactOnly: 0, soundOnly: 0 }
  /** The last fused clap's sound offset. */
  lastOffsetMs: number | null = null

  /** Hands made contact (fast approach) at this camera frame time. */
  visual(at: number, position: Point, now: number): FusedClap | null {
    this.expire(now)
    if (!this.settings.requireSound) return { at, position, offsetMs: 0 }
    const i = this.sounds.findIndex((s) => Math.abs(s - at) <= this.settings.windowMs)
    if (i >= 0) {
      const sound = this.sounds[i]!
      this.sounds.splice(i, 1)
      return this.fuse(at, position, sound)
    }
    if (this.contact) this.stats.contactOnly++
    this.contact = { at, position }
    return null
  }

  /** A clap-like sound started at this time. */
  sound(at: number, now: number): FusedClap | null {
    this.expire(now)
    const c = this.contact
    if (c && Math.abs(at - c.at) <= this.settings.windowMs) {
      this.contact = null
      return this.fuse(c.at, c.position, at)
    }
    this.sounds.push(at)
    return null
  }

  /** Drops contacts and sounds that can no longer be paired. Call regularly (cheap). */
  expire(now: number): void {
    const w = this.settings.windowMs
    if (this.contact && now - this.contact.at > w + SOUND_LAG_MS) {
      this.contact = null
      this.stats.contactOnly++
    }
    while (this.sounds.length > 0 && now - this.sounds[0]! > w + CONTACT_LAG_MS) {
      this.sounds.shift()
      this.stats.soundOnly++
    }
  }

  private fuse(at: number, position: Point, sound: number): FusedClap {
    this.stats.fused++
    this.lastOffsetMs = sound - at
    return { at, position, offsetMs: sound - at }
  }
}
