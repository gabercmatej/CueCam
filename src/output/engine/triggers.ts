/**
 * Matches trigger events against config rules: single triggers, combos (word + gesture
 * within a window, either order), per-rule cooldowns, and the armed flag.
 *
 * Combos cancel solo rules: the event that completes a combo fires no solo rule, and a word
 * that could start a combo holds its solo rules until the combo fires (cancelled) or the
 * combo's window passes (released by `tick`). Gestures are never held: a solo gesture rule
 * fires at once, so the common case stays instant.
 *
 * A gesture that is still being held completes a combo with a word at any time (open palm held,
 * then "fire" three seconds later), not just within `withinMs` of when it fired.
 * `perHand` rules keep a cooldown per hand: two fists at once fire twice.
 */
import type { RuleConfig } from '../../shared/config'
import type { GestureEvent, HandSide, Point, TriggerEvent, WordEvent } from '../../shared/types'

export interface Firing {
  /** Index of the rule in config.rules. */
  rule: number
  effects: string[]
  /** Where the gesture behind this firing happened (absent for word-only rules). */
  position?: Point
  /** Which hand made that gesture. */
  hand?: HandSide | 'Both'
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
  /** Last firing per cooldown key: the rule index, plus the hand for `perHand` rules. */
  private lastFired = new Map<string, number>()
  /** Gestures fired earlier and still held (from the gesture tracker, per tracking result). */
  private active: readonly GestureEvent[] = []
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

  /** The gestures currently held (fired earlier, still present). */
  setActive(active: readonly GestureEvent[]): void {
    this.active = active
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
        if (this.ready(i, rule, now)) firings.push(this.fire(i, rule, now))
      }
      return false
    })
    return firings
  }

  handle(e: TriggerEvent): Firing[] {
    if (!this._armed) return []
    this.recent = this.recent.filter((r) => e.at - r.at <= MAX_COMBO_WINDOW_MS)
    // Two raised palms are BothHandsUp: an OpenPalm from the first hand going up mustn't complete a combo.
    if (e.type === 'gesture' && e.gesture === 'BothHandsUp') this.recent = this.recent.filter((r) => !(r.type === 'gesture' && r.gesture === 'OpenPalm'))

    const firings: Firing[] = []
    let consumed = false
    this.rules.forEach((rule, i) => {
      const { gesture, word, withinMs = 1500 } = rule.when
      if (gesture && word) {
        if (consumed) return
        const wantPartner = e.type === 'gesture' ? { word } : { gesture }
        if (!matches(e.type === 'gesture' ? { gesture } : { word }, e)) return
        const partner =
          [...this.recent].reverse().find((r) => matches(wantPartner, r) && Math.abs(e.at - r.at) <= withinMs) ??
          (e.type === 'word' ? this.active.find((a) => matches(wantPartner, a)) : undefined)
        if (!partner) return
        const g = (e.type === 'gesture' ? e : partner) as GestureEvent
        if (!this.ready(i, rule, e.at, g.hand)) return
        this.recent = this.recent.filter((r) => r !== partner)
        // Held solo rules for this word are cancelled (all of them: "fire fire" holds twice).
        this.held = this.held.filter((h) => !matches({ word }, h.event))
        consumed = true
        firings.push(this.fire(i, rule, e.at, g))
      }
    })
    // The event that completed a combo fires no solo rule.
    if (consumed) return firings

    const hand = e.type === 'gesture' ? e.hand : undefined
    const solos = this.rules.flatMap((rule, i) =>
      !(rule.when.gesture && rule.when.word) && matches(rule.when, e) && this.ready(i, rule, e.at, hand) ? [i] : []
    )
    const holdMs = e.type === 'word' ? this.comboWindowFor(e) : 0
    if (e.type === 'word' && holdMs > 0 && solos.length > 0) {
      this.held.push({ event: e, rules: solos, releaseAt: e.at + holdMs + RELEASE_MARGIN_MS })
    } else {
      for (const i of solos) firings.push(this.fire(i, this.rules[i]!, e.at, e.type === 'gesture' ? e : undefined))
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

  private cooldownKey(i: number, rule: RuleConfig, hand: HandSide | 'Both' | undefined): string {
    return rule.perHand && hand ? `${i}:${hand}` : `${i}`
  }

  private ready(i: number, rule: RuleConfig, at: number, hand?: HandSide | 'Both'): boolean {
    const last = this.lastFired.get(this.cooldownKey(i, rule, hand))
    return last === undefined || at - last >= (rule.cooldownMs ?? this.defaultCooldownMs)
  }

  private fire(i: number, rule: RuleConfig, at: number, gesture?: GestureEvent): Firing {
    this.lastFired.set(this.cooldownKey(i, rule, gesture?.hand), at)
    return gesture ? { rule: i, effects: rule.play, position: gesture.position, hand: gesture.hand } : { rule: i, effects: rule.play }
  }
}
