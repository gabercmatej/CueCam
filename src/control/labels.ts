/** Words for the Control window: gesture names, rule triggers, the hotkey. Pure. */
import type { RuleConfig } from '../shared/config'
import type { GestureName } from '../shared/types'

const GESTURE_NAMES: Record<GestureName, string> = {
  ThumbUp: 'Thumbs up',
  ThumbDown: 'Thumbs down',
  Victory: 'Victory',
  OpenPalm: 'Open palm',
  Fist: 'Fist',
  PointingUp: 'Pointing up',
  Rock: 'Rock',
  ILoveYou: 'I love you (sign)',
  FingerGun: 'Finger gun',
  Pinch: 'Pinch',
  PalmPush: 'Palm push',
  Heart: 'Finger heart',
  Pray: 'Pray',
  Clap: 'Clap',
  BothHandsUp: 'Both hands up'
}

export const gestureName = (g: string): string => GESTURE_NAMES[g as GestureName] ?? g

/** What triggers a rule: `Thumbs up`, `"bye"`, `"fire" + Open palm`. */
export function ruleTrigger(rule: RuleConfig): string {
  const { gesture, word } = rule.when
  const said = word ? `“${word}”` : ''
  if (gesture && word) return `${said} + ${gestureName(gesture)}`
  return gesture ? gestureName(gesture) : said
}

/** A short note on how a rule behaves, if it isn't the plain default. */
export function ruleNote(rule: RuleConfig, effectTypes: readonly string[]): string {
  const notes: string[] = []
  if (rule.when.word && rule.confirm === 'final') notes.push(rule.pauseAfterMs !== undefined ? 'at the end of a phrase' : 'after you finish the phrase')
  if (rule.perHand) notes.push('each hand')
  if (effectTypes.includes('lightPaint')) notes.push('draws while you pinch')
  return notes.join(' · ')
}

/**
 * A stable identity for a rule across config reloads, for remembering on/off: everything that makes it a
 * different rule (trigger, effects, how a word is confirmed, per hand), but not the cooldown, so tuning
 * a cooldown keeps the switch. Editing its trigger or effects makes it a new rule (on again).
 */
export const ruleKey = (rule: RuleConfig): string =>
  JSON.stringify([
    rule.when.gesture ?? null,
    rule.when.word?.trim().toLowerCase() ?? null,
    rule.when.withinMs ?? null,
    rule.play,
    rule.perHand,
    rule.when.word ? [rule.confirm, rule.minConfidence, rule.pauseAfterMs ?? null] : null
  ])

const KEYS: Record<string, string> = {
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  command: '⌘',
  cmd: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  altgr: '⌥',
  shift: '⇧',
  super: '⌘',
  meta: '⌘'
}

/** "CommandOrControl+Shift+K" → "⇧⌘K" (macOS glyphs, modifiers in Apple's order). */
export function hotkeyLabel(accelerator: string): string {
  const order = ['⌃', '⌥', '⇧', '⌘']
  const mods: string[] = []
  let key = ''
  for (const part of accelerator.split('+')) {
    const glyph = KEYS[part.trim().toLowerCase()]
    if (glyph) mods.push(glyph)
    else key = part.trim().length === 1 ? part.trim().toUpperCase() : part.trim()
  }
  return [...new Set(mods)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('') + key
}
