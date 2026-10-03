/**
 * Matches trigger events against config rules: single triggers, combos (word + gesture
 * within a window, either order), per-rule cooldowns, and the armed flag.
 *
 * Combos cancel solo rules: the event that completes a combo fires no solo rule, and a word
 * that could start a combo holds its solo rules until the combo fires (cancelled) or the
 * combo's window passes (released by `tick`). Gestures are never held: a solo gesture rule
 * fires at once, so the common case stays instant.
 */
import type { RuleConfig } from '../../shared/config'
import type { GestureEvent, Point, TriggerEvent, WordEvent } from '../../shared/types'

export interface Firing {
  /** Index of the rule in config.rules. */
  rule: number
  effects: string[]
  /** Where the gesture behind this firing happened (absent for word-only rules). */
  position?: Point
}

/** Events older than this can never complete a combo. */
const MAX_COMBO_WINDOW_MS = 10_000

/**
 * Held solo rules wait this long past the combo window: gesture events are stamped with their
 * camera frame time but arrive after tracking, so a gesture made just inside the window lands late.
 */
export const RELEASE_MARGIN_MS = 150

const NONE: readonly Firing[] = Object.freeze([])

const norm = (w: string): string => w.trim().toLowerCase().replace(/\s+/g, ' ')

function matches(rulePart: { gesture?: string; word?: string }, e: TriggerEvent): boolean {
  return e.type === 'gesture' ? rulePart.gesture === e.gesture : rulePart.word !== undefined && norm(rulePart.word) === norm(e.word)
}

interface HeldSolo {
  /** The word event that is holding its solo rules back. */
  event: WordEvent
  rules: number[]
  releaseAt: number
}

export class TriggerEngine {
  private _armed = true
  private rules: RuleConfig[] = []
  private defaultCooldownMs = 2000
  private lastFired = new Map<number, number>()
  /** Recent unconsumed events that could complete a combo. */
  private recent: TriggerEvent[] = []
  private held: HeldSolo[] = []

  get armed(): boolean {
    return this._armed
  }

  set armed(on: boolean) {
    this._armed = on
    if (!on) this.reset()
  }

  setRules(rules: RuleConfig[], defaultCooldownMs: number): void {
    this.rules = rules
    this.defaultCooldownMs = defaultCooldownMs
    this.lastFired.clear()
    this.reset()
  }

  /** Fires held solo rules whose combo window has passed. Call every frame. */
  tick(now: number): readonly Firing[] {
    if (this.held.length === 0) return NONE
    const firings: Firing[] = []
    this.held = this.held.filter((h) => {
      if (now < h.releaseAt) return true
      // Its solo rules fire now, so this word can no longer complete a combo.
      this.recent = this.recent.filter((r) => r !== h.event)
      for (const i of h.rules) {
        const rule = this.rules[i]!
        if (this.ready(i, rule, now)) firings.push(this.fire(i, rule, now, undefined))
      }
      return false
    })
    return firings
  }

  handle(e: TriggerEvent): Firing[] {
    if (!this._armed) return []
    this.recent = this.recent.filter((r) => e.at - r.at <= MAX_COMBO_WINDOW_MS)

    const firings: Firing[] = []
    let consumed = false
    this.rules.forEach((rule, i) => {
      const { gesture, word, withinMs = 1500 } = rule.when
      if (!this.ready(i, rule, e.at)) return

      if (gesture && word) {
        if (consumed) return
        const wantPartner = e.type === 'gesture' ? { word } : { gesture }
        if (!matches(e.type === 'gesture' ? { gesture } : { word }, e)) return
        const partner = [...this.recent].reverse().find((r) => matches(wantPartner, r) && Math.abs(e.at - r.at) <= withinMs)
        if (!partner) return
        this.recent = this.recent.filter((r) => r !== partner)
        // Held solo rules for this word are cancelled (all of them: "fire fire" holds twice).
        this.held = this.held.filter((h) => !matches({ word }, h.event))
        consumed = true
        const g = (e.type === 'gesture' ? e : partner) as GestureEvent
        firings.push(this.fire(i, rule, e.at, g.position))
      }
    })
    // The event that completed a combo fires no solo rule.
    if (consumed) return firings

    const solos = this.rules.flatMap((rule, i) =>
      !(rule.when.gesture && rule.when.word) && matches(rule.when, e) && this.ready(i, rule, e.at) ? [i] : []
    )
    const holdMs = e.type === 'word' ? this.comboWindowFor(e) : 0
    if (e.type === 'word' && holdMs > 0 && solos.length > 0) {
      this.held.push({ event: e, rules: solos, releaseAt: e.at + holdMs + RELEASE_MARGIN_MS })
    } else {
      for (const i of solos) firings.push(this.fire(i, this.rules[i]!, e.at, e.type === 'gesture' ? e.position : undefined))
    }
    // A word fires either its solo rules or a combo, never both. Gestures fire their solo at
    // once and can still complete a combo with a word that follows.
    if (e.type === 'gesture' || firings.length === 0) this.recent.push(e)
    return firings
  }

  /** Longest window of the ready combos this word could start (0 = none). */
  private comboWindowFor(e: WordEvent): number {
    let ms = 0
    this.rules.forEach((rule, i) => {
      const { gesture, word, withinMs = 1500 } = rule.when
      if (gesture && word && matches({ word }, e) && this.ready(i, rule, e.at)) ms = Math.max(ms, withinMs)
    })
    return ms
  }

  private reset(): void {
    this.recent = []
    this.held = []
  }

  private ready(i: number, rule: RuleConfig, at: number): boolean {
    const last = this.lastFired.get(i)
    return last === undefined || at - last >= (rule.cooldownMs ?? this.defaultCooldownMs)
  }

  private fire(i: number, rule: RuleConfig, at: number, position: Point | undefined): Firing {
    this.lastFired.set(i, at)
    return position ? { rule: i, effects: rule.play, position } : { rule: i, effects: rule.play }
  }
}
