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
  'Heart',
  /** Both palms pressed together, fingers up, held still. */
  'Pray',
  /** Two hands meeting fast. Fires on contact. */
  'Clap',
  /** Two open palms, apart. While it holds, neither hand counts as OpenPalm. */
  'BothHandsUp'
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
  /** Camera frame time of the result that completed the hold. */
  at: number
  /** Camera frame time the gesture was first seen (start of the hold), for latency measurement. */
  heldFrom?: number
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
  /** Which hand made the triggering gesture, if one did (effects that follow a hand track this one). */
  hand?: HandSide | 'Both'
  /** Palm centers of the hands currently visible, in screen space. */
  hands: Point[]
  /** The face box in screen space (held for a moment while the face is covered), if known. */
  face?: ScreenBox
}

/** A box in output pixels (already mirrored if the view is). */
export interface ScreenBox {
  x: number
  y: number
  width: number
  height: number
}
