/**
 * Matches trigger events against config rules: single triggers, combos (word + gesture
 * within a window, either order), per-rule cooldowns, and the armed flag.
 */
import type { RuleConfig } from '../../shared/config'
import type { GestureEvent, Point, TriggerEvent } from '../../shared/types'

export interface Firing {
  /** Index of the rule in config.rules. */
  rule: number
  effects: string[]
  /** Where the gesture behind this firing happened (absent for word-only rules). */
  position?: Point
}

/** Events older than this can never complete a combo. */
const MAX_COMBO_WINDOW_MS = 10_000

const norm = (w: string): string => w.trim().toLowerCase().replace(/\s+/g, ' ')

function matches(rulePart: { gesture?: string; word?: string }, e: TriggerEvent): boolean {
  return e.type === 'gesture' ? rulePart.gesture === e.gesture : rulePart.word !== undefined && norm(rulePart.word) === norm(e.word)
}

export class TriggerEngine {
  armed = true
  private rules: RuleConfig[] = []
  private defaultCooldownMs = 2000
  private lastFired = new Map<number, number>()
  /** Recent unconsumed events that could complete a combo. */
  private recent: TriggerEvent[] = []

  setRules(rules: RuleConfig[], defaultCooldownMs: number): void {
    this.rules = rules
    this.defaultCooldownMs = defaultCooldownMs
    this.lastFired.clear()
    this.recent = []
  }

  handle(e: TriggerEvent): Firing[] {
    if (!this.armed) {
      this.recent = []
      return []
    }
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
        consumed = true
        const g = (e.type === 'gesture' ? e : partner) as GestureEvent
        firings.push(this.fire(i, rule, e.at, g.position))
        return
      }

      if (matches({ gesture, word }, e)) firings.push(this.fire(i, rule, e.at, e.type === 'gesture' ? e.position : undefined))
    })

    if (!consumed) this.recent.push(e)
    return firings
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
