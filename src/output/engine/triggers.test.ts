import { describe, expect, it } from 'vitest'
import type { GestureEvent, GestureName, WordEvent } from '../../shared/types'
import type { RuleConfig } from '../../shared/config'
import { TriggerEngine } from './triggers'

const g = (gesture: GestureName, at: number, x = 100): GestureEvent => ({ type: 'gesture', gesture, hand: 'Right', position: { x, y: 200 }, at })
const w = (word: string, at: number): WordEvent => ({ type: 'word', word, confidence: 1, partial: true, at })
const rule = (when: RuleConfig['when'], play: string[], cooldownMs?: number): RuleConfig => ({ when, play, cooldownMs })

function engine(rules: RuleConfig[], cooldown = 2000) {
  const e = new TriggerEngine()
  e.setRules(rules, cooldown)
  return e
}

describe('TriggerEngine', () => {
  it('fires a single gesture rule with the gesture position', () => {
    const e = engine([rule({ gesture: 'ThumbUp' }, ['confetti'])])
    expect(e.handle(g('ThumbUp', 0))).toEqual([{ rule: 0, effects: ['confetti'], position: { x: 100, y: 200 } }])
    expect(e.handle(g('Fist', 10))).toEqual([])
  })

  it('fires a single word rule, case-insensitively', () => {
    const e = engine([rule({ word: "Let's Go" }, ['cannons'])])
    expect(e.handle(w("let's go", 0))).toHaveLength(1)
  })

  it('applies the default and per-rule cooldowns', () => {
    const e = engine([rule({ word: 'boom' }, ['a']), rule({ gesture: 'Rock' }, ['b'], 500)])
    expect(e.handle(w('boom', 0))).toHaveLength(1)
    expect(e.handle(w('boom', 1999))).toHaveLength(0)
    expect(e.handle(w('boom', 2000))).toHaveLength(1)
    expect(e.handle(g('Rock', 0))).toHaveLength(1)
    expect(e.handle(g('Rock', 499))).toHaveLength(0)
    expect(e.handle(g('Rock', 500))).toHaveLength(1)
  })

  it('fires a combo when word and gesture land within the window, in either order', () => {
    const combo = rule({ word: 'fire', gesture: 'PalmPush', withinMs: 1500 }, ['fireball'])
    const a = engine([combo])
    expect(a.handle(w('fire', 0))).toEqual([])
    expect(a.handle(g('PalmPush', 1200, 300))).toEqual([{ rule: 0, effects: ['fireball'], position: { x: 300, y: 200 } }])

    const b = engine([combo])
    b.handle(g('PalmPush', 0, 300))
    expect(b.handle(w('fire', 900))).toEqual([{ rule: 0, effects: ['fireball'], position: { x: 300, y: 200 } }])
  })

  it('does not fire a combo outside the window', () => {
    const e = engine([rule({ word: 'fire', gesture: 'PalmPush', withinMs: 1500 }, ['fireball'])])
    e.handle(w('fire', 0))
    expect(e.handle(g('PalmPush', 1501))).toEqual([])
  })

  it('consumes combo events so one word cannot complete two combos', () => {
    const e = engine([rule({ word: 'fire', gesture: 'PalmPush', withinMs: 1500 }, ['fireball'], 0)])
    e.handle(w('fire', 0))
    expect(e.handle(g('PalmPush', 100))).toHaveLength(1)
    expect(e.handle(g('PalmPush', 200))).toHaveLength(0)
  })

  it('fires nothing while disarmed, and forgets events seen while disarmed', () => {
    const e = engine([rule({ gesture: 'ThumbUp' }, ['x']), rule({ word: 'fire', gesture: 'PalmPush' }, ['y'])])
    e.armed = false
    expect(e.handle(g('ThumbUp', 0))).toEqual([])
    e.handle(w('fire', 10))
    e.armed = true
    expect(e.handle(g('PalmPush', 20))).toEqual([])
  })

  it('fires every matching rule, in order', () => {
    const e = engine([rule({ word: 'boom' }, ['clip']), rule({ word: 'boom' }, ['shake'])])
    expect(e.handle(w('boom', 0)).map((f) => f.effects)).toEqual([['clip'], ['shake']])
  })

  it('resets cooldowns when rules change', () => {
    const e = engine([rule({ word: 'boom' }, ['a'])])
    e.handle(w('boom', 0))
    e.setRules([rule({ word: 'boom' }, ['a'])], 2000)
    expect(e.handle(w('boom', 10))).toHaveLength(1)
  })
})
