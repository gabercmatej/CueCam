/** Types shared across windows: gesture vocabulary, trigger events, effect context. */

/** Our gesture names. MediaPipe's built-in labels are mapped onto these in gestures.ts; rules never see raw labels. */
export const GESTURES = [
  'ThumbUp',
  'ThumbDown',
  'Victory',
  'OpenPalm',
  'Fist',
  'PointingUp',
  'Rock',
  'ILoveYou',
  'FingerGun',
  'Pinch',
  'PalmPush',
  'Heart'
] as const
export type GestureName = (typeof GESTURES)[number]

export type HandSide = 'Left' | 'Right'

/** A position on screen, in output pixels (already mirrored if the view is). */
export interface Point {
  x: number
  y: number
}

export interface GestureEvent {
  type: 'gesture'
  gesture: GestureName
  hand: HandSide | 'Both'
  position: Point
  at: number
}

export interface WordEvent {
  type: 'word'
  word: string
  confidence: number
  /** True when fired from a partial result (fast path); finals only add occurrences partials missed. */
  partial: boolean
  at: number
}

export type TriggerEvent = GestureEvent | WordEvent

/** What an effect knows about the moment it was triggered. */
export interface EffectContext {
  /** Where the triggering gesture happened, if any. */
  position?: Point
  /** Palm centers of the hands currently visible, in screen space. */
  hands: Point[]
}
