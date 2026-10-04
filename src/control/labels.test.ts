import { describe, expect, it } from 'vitest'
import type { RuleConfig } from '../shared/config'
import { hotkeyLabel, ruleKey, ruleNote, ruleTrigger } from './labels'

const rule = (when: RuleConfig['when'], extra: Partial<RuleConfig> = {}): RuleConfig => ({ when, play: ['x'], perHand: false, confirm: 'partial', minConfidence: 0.9, ...extra })

describe('labels', () => {
  it('names rule triggers', () => {
    expect(ruleTrigger(rule({ gesture: 'ThumbUp' }))).toBe('Thumbs up')
    expect(ruleTrigger(rule({ word: 'bye' }))).toBe('“bye”')
    expect(ruleTrigger(rule({ word: 'fire', gesture: 'OpenPalm', withinMs: 1500 }))).toBe('“fire” + Open palm')
  })

  it('notes non-default behaviour', () => {
    expect(ruleNote(rule({ word: 'bye' }, { confirm: 'final', pauseAfterMs: 150 }), ['media'])).toBe('at the end of a phrase')
    expect(ruleNote(rule({ gesture: 'Pinch' }, { perHand: true }), ['lightPaint'])).toBe('each hand · draws while you pinch')
    expect(ruleNote(rule({ gesture: 'Rock' }), ['media'])).toBe('')
  })

  it('keys rules by trigger and effects, not position or cooldown', () => {
    expect(ruleKey(rule({ word: 'Bye' }))).toBe(ruleKey(rule({ word: 'bye' }, { cooldownMs: 100 })))
    expect(ruleKey(rule({ word: 'bye' }))).not.toBe(ruleKey(rule({ word: 'boom' })))
    // Same trigger and effects, confirmed differently: two rules, two switches.
    expect(ruleKey(rule({ word: 'bye' }))).not.toBe(ruleKey(rule({ word: 'bye' }, { confirm: 'final' })))
  })

  it('shows the hotkey with macOS glyphs', () => {
    expect(hotkeyLabel('CommandOrControl+Shift+K')).toBe('⇧⌘K')
    expect(hotkeyLabel('Alt+Control+F5')).toBe('⌃⌥F5')
  })
})
