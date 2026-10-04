import { describe, expect, it } from 'vitest'
import type { GestureEvent, GestureName, WordEvent } from '../../shared/types'
import type { RuleConfig } from '../../shared/config'
import { RELEASE_MARGIN_MS, TriggerEngine } from './triggers'

const g = (gesture: GestureName, at: number, x = 100): GestureEvent => ({ type: 'gesture', gesture, hand: 'Right', position: { x, y: 200 }, at })
const w = (word: string, at: number): WordEvent => ({ type: 'word', word, confidence: 1, partial: true, at })
const rule = (when: RuleConfig['when'], play: string[], cooldownMs?: number, perHand = false): RuleConfig => ({ when, play, cooldownMs, perHand })

function engine(rules: RuleConfig[], cooldown = 2000) {
  const e = new TriggerEngine()
  e.setRules(rules, cooldown)
  return e
}

describe('TriggerEngine', () => {
  it('fires a single gesture rule with the gesture position', () => {
    const e = engine([rule({ gesture: 'ThumbUp' }, ['confetti'])])
    expect(e.handle(g('ThumbUp', 0))).toEqual([{ rule: 0, effects: ['confetti'], position: { x: 100, y: 200 }, hand: 'Right' }])
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
    expect(a.handle(g('PalmPush', 1200, 300))).toEqual([{ rule: 0, effects: ['fireball'], position: { x: 300, y: 200 }, hand: 'Right' }])

    const b = engine([combo])
    b.handle(g('PalmPush', 0, 300))
    expect(b.handle(w('fire', 900))).toEqual([{ rule: 0, effects: ['fireball'], position: { x: 300, y: 200 }, hand: 'Right' }])
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

  describe('combos cancel solo rules', () => {
    const rules = () => [
      rule({ word: 'fire', gesture: 'PalmPush', withinMs: 1500 }, ['fireball']),
      rule({ word: 'fire' }, ['flames']),
      rule({ gesture: 'PalmPush' }, ['push'])
    ]

    it('holds a solo word rule while its combo could still complete, then cancels it when the combo fires', () => {
      const e = engine(rules())
      expect(e.handle(w('fire', 0))).toEqual([])
      expect(e.tick(1000)).toEqual([])
      // The gesture completes the combo: neither the held word solo nor the gesture solo fires.
      expect(e.handle(g('PalmPush', 1200, 300))).toEqual([{ rule: 0, effects: ['fireball'], position: { x: 300, y: 200 }, hand: 'Right' }])
      expect(e.tick(5000)).toEqual([])
    })

    it('releases the held solo word rule once the combo window passes', () => {
      const e = engine(rules())
      e.handle(w('fire', 0))
      // Released after the window plus a margin for tracking latency (gesture events are stamped earlier than they arrive).
      expect(e.tick(1500 + RELEASE_MARGIN_MS - 1)).toEqual([])
      expect(e.tick(1500 + RELEASE_MARGIN_MS)).toEqual([{ rule: 1, effects: ['flames'] }])
      expect(e.tick(3000)).toEqual([])
    })

    it('a late gesture after the release fires its own solo rule, not the combo', () => {
      const e = engine(rules())
      e.handle(w('fire', 0))
      e.tick(1500 + RELEASE_MARGIN_MS)
      expect(e.handle(g('PalmPush', 1700)).map((f) => f.rule)).toEqual([2])
    })

    it('gesture first: the gesture solo fires at once; the word then completes the combo and its solo is suppressed', () => {
      const e = engine(rules())
      expect(e.handle(g('PalmPush', 0, 300)).map((f) => f.rule)).toEqual([2])
      expect(e.handle(w('fire', 800)).map((f) => f.rule)).toEqual([0])
      expect(e.tick(5000)).toEqual([])
    })

    it('does not hold a solo word rule while the combo is cooling down', () => {
      const e = engine([rule({ word: 'fire', gesture: 'PalmPush', withinMs: 1500 }, ['fireball'], 10_000), rule({ word: 'fire' }, ['flames'], 0)])
      e.handle(w('fire', 0))
      e.handle(g('PalmPush', 100))
      expect(e.handle(w('fire', 2000))).toEqual([{ rule: 1, effects: ['flames'] }])
    })

    it('does not hold words that belong to no combo', () => {
      const e = engine([...rules(), rule({ word: 'boom' }, ['clip'])])
      expect(e.handle(w('boom', 0))).toEqual([{ rule: 3, effects: ['clip'] }])
    })

    it('holds for the longest window among the combos that share the word', () => {
      const e = engine([
        rule({ word: 'fire', gesture: 'PalmPush', withinMs: 1000 }, ['a']),
        rule({ word: 'fire', gesture: 'Fist', withinMs: 2000 }, ['b']),
        rule({ word: 'fire' }, ['solo'])
      ])
      e.handle(w('fire', 0))
      expect(e.tick(1500 + RELEASE_MARGIN_MS)).toEqual([])
      expect(e.tick(2000 + RELEASE_MARGIN_MS)).toEqual([{ rule: 2, effects: ['solo'] }])
    })

    it('drops held solo rules on disarm and on a config change', () => {
      const a = engine(rules())
      a.handle(w('fire', 0))
      a.armed = false
      expect(a.tick(2000)).toEqual([])

      const b = engine(rules())
      b.handle(w('fire', 0))
      b.setRules(rules(), 2000)
      expect(b.tick(2000)).toEqual([])
    })
  
    it('a repeated combo word is cancelled completely when the combo fires', () => {
      const e = engine(rules())
      e.handle(w('fire', 0))
      e.handle(w('fire', 400))
      expect(e.handle(g('PalmPush', 600)).map((f) => f.rule)).toEqual([0])
      expect(e.tick(5000)).toEqual([])
    })

    it('a word whose solo rule already fired cannot complete a combo afterwards', () => {
      const e = engine(rules())
      e.handle(w('fire', 0))
      expect(e.tick(1500 + RELEASE_MARGIN_MS).map((f) => f.rule)).toEqual([1])
      // A late-arriving gesture stamped inside the window fires its own solo, not the combo too.
      expect(e.handle(g('PalmPush', 1480)).map((f) => f.rule)).toEqual([2])
    })

    it('a word that fired its solo at once (combo cooling down) cannot complete the combo later', () => {
      const e = engine([rule({ word: 'fire', gesture: 'PalmPush', withinMs: 1500 }, ['fireball'], 1000), rule({ word: 'fire' }, ['flames'], 0)])
      e.handle(w('fire', 0))
      e.handle(g('PalmPush', 100))
      expect(e.handle(w('fire', 900)).map((f) => f.rule)).toEqual([1])
      expect(e.handle(g('PalmPush', 1200)).map((f) => f.rule)).toEqual([])
    })
  })

  describe('per hand and held gestures', () => {
    const left = (gesture: GestureName, at: number): GestureEvent => ({ ...g(gesture, at), hand: 'Left', position: { x: 900, y: 200 } })

    it('perHand rules fire once per hand at the same moment (two fists, two bursts)', () => {
      const e = engine([rule({ gesture: 'Fist' }, ['confetti'], 1000, true)])
      expect(e.handle(g('Fist', 0))).toHaveLength(1)
      expect(e.handle(left('Fist', 0))).toEqual([{ rule: 0, effects: ['confetti'], position: { x: 900, y: 200 }, hand: 'Left' }])
      // Each hand still has its own cooldown.
      expect(e.handle(g('Fist', 500))).toEqual([])
      expect(e.handle(g('Fist', 1000))).toHaveLength(1)
    })

    it('without perHand the second hand is in cooldown', () => {
      const e = engine([rule({ gesture: 'Fist' }, ['confetti'], 1000)])
      e.handle(g('Fist', 0))
      expect(e.handle(left('Fist', 0))).toEqual([])
    })

    it('a gesture still held completes a combo with a word long after it fired', () => {
      const e = engine([rule({ word: 'fire', gesture: 'OpenPalm', withinMs: 1500 }, ['fire_palm'])])
      e.handle(g('OpenPalm', 0))
      e.setActive([g('OpenPalm', 3000)])
      expect(e.handle(w('fire', 3000))).toEqual([{ rule: 0, effects: ['fire_palm'], position: { x: 100, y: 200 }, hand: 'Right' }])
    })

    it('a gesture that is no longer held does not', () => {
      const e = engine([rule({ word: 'fire', gesture: 'OpenPalm', withinMs: 1500 }, ['fire_palm'])])
      e.handle(g('OpenPalm', 0))
      e.setActive([])
      expect(e.handle(w('fire', 3000))).toEqual([])
    })
  })

  it('BothHandsUp stops an earlier one-hand OpenPalm from completing the fire combo', () => {
    const e = engine([rule({ word: 'fire', gesture: 'OpenPalm', withinMs: 1500 }, ['fire_palm'])])
    e.handle(g('OpenPalm', 250))
    e.handle({ ...g('BothHandsUp', 650), hand: 'Both' })
    expect(e.handle(w('fire', 1000))).toEqual([])
  })
})
