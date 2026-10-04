/**
 * The Control window. It is opened by the Output page with window.open, so it lives in the
 * same renderer process and is driven directly from the Output's frame loop: no second
 * camera, no second tracker, no per-frame IPC. The preview is a mirrored, downscaled copy
 * of the Output canvas (one GPU blit), with the hand overlay drawn on top.
 *
 * It shares the Output's main thread, so it stays cheap: the DOM is built once, `update` runs at the
 * stats rate (250 ms) and only touches elements whose text or state changed, debug text is built only
 * while the Debug section is open, and nothing is drawn while the window is hidden.
 */
import type { HotkeyStatus } from '../shared/api'
import type { HandSide } from '../shared/types'
import type { FaceState } from '../output/perception/faceSmoother'
import type { FingerStates, Landmark } from '../output/perception/handGeometry'
import type { Health, Level, Link } from './health'
import { hotkeyLabel } from './labels'
import { PREVIEW, STYLE } from './panelStyle'

export const CONTROL_WINDOW_NAME = 'skillcam-control'

// The preview is mirrored, like a mirror: normalized raw camera x → (1 − x) · width.
const sx = (p: Landmark): number => (1 - p.x) * PREVIEW.width
const sy = (p: Landmark): number => p.y * PREVIEW.height

// MediaPipe hand skeleton (21 landmarks).
const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
]

const FINGER = { ext: '↑', curl: '↓', half: '~' }
const THUMB = { out: '↗', tucked: '·', half: '~' }

/** "T↗ I↑ M↓ R↓ P↑": the finger states our custom gestures are built from. */
export function fingerString(f: FingerStates): string {
  return `T${THUMB[f.thumb]} I${FINGER[f.index]} M${FINGER[f.middle]} R${FINGER[f.ring]} P${FINGER[f.pinky]}`
}

export interface OverlayHand {
  side: HandSide
  /** Predicted landmarks, normalized raw camera coordinates. */
  landmarks: Landmark[]
}

export interface HandLabel {
  side: HandSide
  label: string | null
  pinching: boolean
  fingers: FingerStates
}

/** One config rule as the effects list shows it. */
export interface RuleRow {
  trigger: string
  effects: string
  note: string
  enabled: boolean
}

export interface Issue {
  level: 'error' | 'warn'
  title: string
  detail?: string
}

/** What the panel shows, refreshed at the stats rate. */
export interface PanelState {
  armed: boolean
  hotkey: HotkeyStatus | null
  health: Health
  issues: readonly Issue[]
  last: { effects: string; cause: string; at: number } | null
  /** "Right: Thumbs up · Left: Fist", or empty when no hands. */
  gestures: string
  heard: readonly { word: string; fired: boolean }[]
  /** The last final transcript, decoys included. */
  heardText: string
  /** Rule index → why it can't show its files. */
  ruleProblems: ReadonlyMap<number, string>
  audio: { route: string; micDb: number; mixDb: number }
  /** Where skillcam.config.json and reactions/ live (empty until main has said). */
  folder: string
}

export interface PanelHandlers {
  toggleArmed(): void
  test(rule: number): void
  setRuleEnabled(rule: number, on: boolean): void
  sendToCall(on: boolean): void
  /** 0–1; 0 = monitor off. */
  monitorVolume(volume: number): void
  /** Open the config/reactions folder in Finder. */
  showFolder(): void
}

interface LabelText {
  title: string
  detail: string
  pinching: boolean
}

const LINKS = ['camera', 'tracking', 'speech', 'call'] as const
const LINK_NAMES = { camera: 'Camera', tracking: 'Tracking', speech: 'Speech', call: 'Call audio' }

/** dBFS → 0–1 over −60…0 dB. */
const meterLevel = (db: number): number => Math.max(0, Math.min(1, (db + 60) / 60))
const dbText = (db: number): string => (db <= -119 ? '—' : `${db.toFixed(0)} dB`)
/** "/Users/name/Library/…" → "~/Library/…". */
const homeShort = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')
const ago = (ms: number): string => (ms < 1500 ? 'just now' : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`)

/** Sets text only when it changed (a DOM write invalidates layout; most values repeat). */
function text(node: Element, value: string): void {
  if (node.textContent !== value) node.textContent = value
}
function attr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

export class ControlPanel {
  /** Overlay label text per side, rebuilt once per tracking result rather than per drawn frame. */
  private readonly labels = new Map<HandSide, LabelText>()
  private readonly doc: Document
  private readonly ctx: CanvasRenderingContext2D
  private readonly armButton: HTMLButtonElement
  private readonly armState: HTMLElement
  private readonly armHint: HTMLElement
  private readonly hotkeyBox: HTMLElement
  private readonly hotkeyKey: HTMLElement
  private readonly hotkeyNote: HTMLElement
  private readonly linkEls = new Map<(typeof LINKS)[number], { li: HTMLElement; sum: HTMLElement }>()
  private readonly issueList: HTMLUListElement
  private issueKey = ''
  private readonly lastFact: { box: HTMLElement; big: HTMLElement; small: HTMLElement }
  private readonly gestureFact: { big: HTMLElement }
  private readonly heardWords: HTMLElement
  private readonly heardText: HTMLElement
  private heardKey = ''
  private readonly ruleBody: HTMLTableSectionElement
  private readonly folderPath: HTMLElement
  private rows: { tr: HTMLTableRowElement; toggle: HTMLInputElement; problem: HTMLElement; firedAt: number }[] = []
  private readonly sendToCall: HTMLInputElement
  private readonly monitor: HTMLInputElement
  private readonly monitorText: HTMLElement
  private readonly route: HTMLElement
  private readonly meters: { fill: HTMLElement; bar: HTMLElement; value: HTMLElement }[] = []
  private readonly debug: HTMLDetailsElement
  private readonly debugStats: HTMLPreElement
  private readonly showMask: HTMLInputElement
  private readonly showFace: HTMLInputElement
  private handlers: PanelHandlers | null = null
  /** The latest segmentation mask as a tinted image, rebuilt per mask only while the toggle is on. */
  private readonly maskCanvas: HTMLCanvasElement
  private maskImage: ImageData | null = null

  private constructor(private readonly win: Window) {
    const doc = (this.doc = win.document)
    doc.head.replaceChildren()
    doc.body.replaceChildren()
    doc.title = 'Skillcam Control'
    const style = doc.createElement('style')
    style.textContent = STYLE
    doc.head.append(style)
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag)
      if (className) node.className = className
      if (content !== undefined) node.textContent = content
      return node
    }
    const section = (title: string, ...children: Node[]): HTMLElement => {
      const s = el('section')
      const h = el('h2', '', title)
      s.append(h, ...children)
      return s
    }
    const switchBox = (): HTMLInputElement => {
      const box = el('input', 'switch')
      box.type = 'checkbox'
      box.setAttribute('role', 'switch')
      return box
    }

    // Armed state + hotkey
    this.armButton = el('button', 'arm')
    this.armButton.type = 'button'
    this.armState = el('span', 'state', 'Armed')
    this.armHint = el('span', 'hint')
    this.armButton.append(el('span', 'lamp'), this.armState, this.armHint)
    this.armButton.addEventListener('click', () => this.handlers?.toggleArmed())
    this.hotkeyBox = el('div', 'hotkey')
    this.hotkeyKey = el('kbd')
    this.hotkeyNote = el('span', '', 'from any app')
    this.hotkeyBox.append(this.hotkeyKey, this.hotkeyNote)
    const top = el('header', 'top')
    top.append(this.armButton, this.hotkeyBox)

    // Health strip
    const strip = el('ul', 'health')
    strip.setAttribute('aria-label', 'Health')
    for (const link of LINKS) {
      const li = el('li')
      const sum = el('span', 'sum', '…')
      li.append(el('span', 'dot'), el('span', 'name', LINK_NAMES[link]), sum)
      li.dataset['level'] = 'wait'
      strip.append(li)
      this.linkEls.set(link, { li, sum })
    }
    this.issueList = el('ul', 'issues')
    this.issueList.setAttribute('aria-live', 'polite')

    // Live
    const canvas = el('canvas', 'preview')
    canvas.width = PREVIEW.width
    canvas.height = PREVIEW.height
    this.ctx = canvas.getContext('2d', { alpha: false })!
    const fact = (label: string): { box: HTMLElement; big: HTMLElement; small: HTMLElement } => {
      const box = el('div', 'fact')
      const big = el('div', 'big', '—')
      const small = el('div', 'small')
      box.append(el('div', 'label', label), big, small)
      return { box, big, small }
    }
    this.lastFact = fact('Last trigger')
    const gestures = fact('Gesture')
    this.gestureFact = gestures
    const heard = el('div', 'fact')
    this.heardWords = el('div', 'words')
    this.heardText = el('div', 'small')
    heard.append(el('div', 'label', 'Heard'), this.heardWords, this.heardText)
    const facts = el('div', 'facts')
    facts.append(this.lastFact.box, gestures.box, heard)

    // Effects
    const table = el('table', 'rules')
    this.ruleBody = el('tbody')
    table.append(this.ruleBody)
    const showFolder = el('button', 'test', 'Show in Finder')
    showFolder.type = 'button'
    showFolder.title = 'Edit skillcam.config.json, or add and replace files in reactions/. Changes apply without a restart.'
    showFolder.addEventListener('click', () => this.handlers?.showFolder())
    this.folderPath = el('code', 'path')
    const folderRow = el('div', 'row files')
    folderRow.append(el('span', '', 'Config and reactions'), this.folderPath, showFolder)

    // Audio
    this.sendToCall = switchBox()
    this.sendToCall.addEventListener('change', () => this.handlers?.sendToCall(this.sendToCall.checked))
    const sendLabel = el('label')
    sendLabel.append(this.sendToCall, 'Send to call')
    this.route = el('span', 'route')
    const sendRow = el('div', 'row')
    sendRow.append(sendLabel, this.route)
    this.monitor = el('input')
    this.monitor.type = 'range'
    this.monitor.min = '0'
    this.monitor.max = '100'
    this.monitor.setAttribute('aria-label', 'Monitor volume')
    this.monitorText = el('span', 'num')
    this.monitor.addEventListener('input', () => {
      this.monitorText.textContent = `${this.monitor.value}%`
      this.handlers?.monitorVolume(Number(this.monitor.value) / 100)
    })
    const monitorRow = el('div', 'row')
    monitorRow.append(el('span', '', 'Hear effects yourself'), this.monitor, this.monitorText)
    const meterGrid = el('div', 'meters')
    for (const name of ['Mic', 'To call']) {
      const bar = el('div', 'meter')
      const fill = el('i')
      bar.append(fill)
      const value = el('span', 'num', '—')
      meterGrid.append(el('span', '', name), bar, value)
      this.meters.push({ fill, bar, value })
    }
    const audio = el('div', 'audio')
    audio.append(sendRow, monitorRow, meterGrid)

    // Debug
    this.debug = el('details', 'debug')
    const summary = el('summary', '', 'Debug')
    const toggle = (label: string): [HTMLLabelElement, HTMLInputElement] => {
      const l = el('label')
      const box = el('input')
      box.type = 'checkbox'
      l.append(box, label)
      return [l, box]
    }
    const [maskLabel, showMask] = toggle('Segmentation mask')
    const [faceLabel, showFace] = toggle('Face box')
    this.showMask = showMask
    this.showFace = showFace
    const debugRow = el('div', 'row')
    debugRow.append(maskLabel, faceLabel)
    this.debugStats = el('pre')
    this.debug.append(summary, debugRow, this.debugStats)
    this.maskCanvas = el('canvas')

    const main = el('main')
    main.append(
      top,
      strip,
      this.issueList,
      section('Live', canvas, facts),
      section('Effects', table, folderRow),
      section('Audio', audio),
      this.debug
    )
    doc.body.append(main)
  }

  /** Opens (or, after a reload of the Output, reuses) the Control window. Null if it was blocked. */
  static open(): ControlPanel | null {
    const win = window.open('', CONTROL_WINDOW_NAME)
    if (!win) {
      console.warn('[control] window could not be opened')
      return null
    }
    return new ControlPanel(win)
  }

  get closed(): boolean {
    return this.win.closed
  }

  /** On screen (not closed, hidden or minimized): only then is anything drawn. */
  get visible(): boolean {
    return !this.win.closed && this.doc.visibilityState === 'visible'
  }

  /** The Debug section is open: only then are its stats worth building. */
  get debugOpen(): boolean {
    return this.debug.open && this.visible
  }

  on(handlers: PanelHandlers): void {
    this.handlers = handlers
  }

  /** The effects list, rebuilt when the config changes. */
  setRules(rules: readonly RuleRow[]): void {
    if (this.win.closed) return
    const doc = this.doc
    this.rows = rules.map((r, i) => {
      const tr = doc.createElement('tr')
      const toggle = doc.createElement('input')
      toggle.type = 'checkbox'
      toggle.className = 'switch'
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-label', `${r.trigger} on`)
      toggle.checked = r.enabled
      tr.classList.toggle('off', !r.enabled)
      toggle.addEventListener('change', () => {
        tr.classList.toggle('off', !toggle.checked)
        this.handlers?.setRuleEnabled(i, toggle.checked)
      })
      const what = doc.createElement('td')
      what.className = 'what'
      what.append(`→ ${r.effects}`)
      if (r.note) {
        const note = doc.createElement('span')
        note.className = 'note'
        note.textContent = r.note
        what.append(note)
      }
      const problem = doc.createElement('span')
      problem.className = 'problem'
      what.append(problem)
      const test = doc.createElement('button')
      test.type = 'button'
      test.className = 'test'
      test.textContent = 'Test'
      test.title = 'Play its effects now (also while disarmed)'
      test.addEventListener('click', () => this.handlers?.test(i))
      // Built explicitly: `instanceof` checks fail across windows (each has its own HTMLElement classes).
      const cell = (content: Node | string, className = ''): HTMLTableCellElement => {
        const td = doc.createElement('td')
        if (className) td.className = className
        td.append(content)
        return td
      }
      tr.append(cell(toggle), cell(r.trigger, 'trigger'), what, cell(test))
      return { tr, toggle, problem, firedAt: -Infinity }
    })
    this.ruleBody.replaceChildren(...this.rows.map((r) => r.tr))
  }

  /** Each rule's on/off, applied to the existing rows (keeps keyboard focus on the switch just used). */
  setRuleStates(enabled: readonly boolean[]): void {
    this.rows.forEach((row, i) => {
      const on = enabled[i] ?? true
      row.toggle.checked = on
      row.tr.classList.toggle('off', !on)
    })
  }

  /** A rule fired: its row lights up briefly. */
  ruleFired(rule: number, now: number): void {
    const row = this.rows[rule]
    if (!row || this.win.closed) return
    row.firedAt = now
    row.tr.classList.add('fired')
  }

  setLabels(labels: HandLabel[]): void {
    this.labels.clear()
    for (const l of labels) {
      this.labels.set(l.side, {
        title: `${l.label ?? '—'}${l.pinching ? ' · Pinch' : ''}`,
        detail: `${l.side} ${fingerString(l.fingers)}`,
        pinching: l.pinching
      })
    }
  }

  /** Shows the current call switch and monitor volume (after a config change). */
  setAudioControls(sendToCall: boolean, monitorVolume: number): void {
    if (this.win.closed) return
    this.sendToCall.checked = sendToCall
    this.monitor.value = String(Math.round(monitorVolume * 100))
    this.monitorText.textContent = `${this.monitor.value}%`
  }

  /** Everything but the preview, at the stats rate. Skipped while hidden. */
  update(s: PanelState, now: number): void {
    if (!this.visible) return
    attr(this.armButton, 'aria-pressed', String(s.armed))
    text(this.armState, s.armed ? 'Armed' : 'Disarmed')
    text(this.armHint, s.armed ? 'Gestures and words fire effects' : 'Nothing fires. Click or press the hotkey to arm.')

    if (s.hotkey) {
      text(this.hotkeyKey, hotkeyLabel(s.hotkey.accelerator))
      this.hotkeyBox.classList.toggle('bad', !s.hotkey.registered)
      text(this.hotkeyNote, s.hotkey.registered ? 'from any app' : 'not available')
    }

    const issues: Issue[] = []
    for (const link of LINKS) {
      const l: Link = s.health[link]
      const els = this.linkEls.get(link)!
      attr(els.li, 'data-level', l.level satisfies Level)
      text(els.sum, l.summary)
      if (l.reason && (l.level === 'error' || l.level === 'warn')) issues.push({ level: l.level, title: `${LINK_NAMES[link]}: ${l.summary}`, detail: l.reason })
    }
    if (s.hotkey && !s.hotkey.registered) {
      issues.push({ level: 'warn', title: `Hotkey ${hotkeyLabel(s.hotkey.accelerator)} ${s.hotkey.error ?? 'not registered'}`, detail: 'Use the button above, or set another "hotkey" in skillcam.config.json.' })
    }
    issues.push(...s.issues)
    this.renderIssues(issues)
    text(this.folderPath, homeShort(s.folder))

    if (s.last) {
      this.lastFact.box.classList.toggle('fresh', now - s.last.at < 3000)
      text(this.lastFact.big, s.last.effects)
      text(this.lastFact.small, `${s.last.cause} · ${ago(now - s.last.at)}`)
    } else {
      text(this.lastFact.small, 'Nothing yet')
    }
    text(this.gestureFact.big, s.gestures || 'No hands')

    const heardKey = s.heard.map((h) => `${h.word}${h.fired ? '!' : ''}`).join('|')
    if (heardKey !== this.heardKey) {
      this.heardKey = heardKey
      this.heardWords.replaceChildren(
        ...s.heard.map((h) => {
          const chip = this.doc.createElement('span')
          chip.textContent = h.word
          if (h.fired) {
            chip.className = 'fired'
            chip.title = 'fired a rule'
          }
          return chip
        })
      )
    }
    text(this.heardText, s.heardText ? `“${s.heardText.replace(/\[unk\]/g, '…')}”` : '')

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!
      text(row.problem, s.ruleProblems.get(i) ?? '')
      if (row.firedAt > 0 && now - row.firedAt > 900) {
        row.firedAt = -Infinity
        row.tr.classList.remove('fired')
      }
    }

    text(this.route, s.audio.route)
    const dbs = [s.audio.micDb, s.audio.mixDb]
    for (let i = 0; i < 2; i++) {
      const m = this.meters[i]!
      const level = meterLevel(dbs[i]!)
      m.fill.style.transform = `scaleX(${level.toFixed(3)})`
      m.bar.classList.toggle('hot', dbs[i]! > -3)
      text(m.value, dbText(dbs[i]!))
    }
  }

  /** Debug text: call only while `debugOpen`. */
  setDebug(lines: readonly string[]): void {
    text(this.debugStats, lines.join('\n'))
  }

  private renderIssues(issues: readonly Issue[]): void {
    const key = issues.map((i) => `${i.level}|${i.title}|${i.detail ?? ''}`).join('\n')
    if (key === this.issueKey) return
    this.issueKey = key
    this.issueList.replaceChildren(
      ...issues.map((issue) => {
        const li = this.doc.createElement('li')
        if (issue.level === 'warn') li.className = 'warn'
        const b = this.doc.createElement('b')
        b.textContent = issue.title
        li.append(b)
        if (issue.detail) {
          // Multi-line details (a config error) keep their layout.
          const detail = this.doc.createElement(issue.detail.includes('\n') ? 'pre' : 'span')
          detail.textContent = issue.detail
          li.append(detail)
        }
        return li
      })
    )
  }

  /** A new segmentation mask (bytes, raw camera orientation). Only converted while the mask toggle is on. */
  setMask(data: Uint8Array, width: number, height: number): void {
    if (!this.debugOpen || !this.showMask.checked) return
    if (!this.maskImage || this.maskImage.width !== width || this.maskImage.height !== height) {
      this.maskCanvas.width = width
      this.maskCanvas.height = height
      this.maskImage = new ImageData(width, height)
    }
    const px = this.maskImage.data
    // Person = magenta, alpha follows confidence; background stays clear.
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      px[j] = 255
      px[j + 1] = 40
      px[j + 2] = 200
      px[j + 3] = data[i]! >> 1
    }
    this.maskCanvas.getContext('2d')!.putImageData(this.maskImage, 0, 0)
  }

  /**
   * Copies the Output canvas, mirrored, then draws the overlay. Call right after the Output
   * renders, in the same task, so the WebGL drawing buffer is still valid. Skip while hidden.
   */
  drawPreview(output: HTMLCanvasElement, hands: OverlayHand[], face: FaceState | null): void {
    const g = this.ctx
    const debug = this.debug.open
    g.setTransform(-1, 0, 0, 1, PREVIEW.width, 0)
    g.drawImage(output, 0, 0, PREVIEW.width, PREVIEW.height)
    if (debug && this.showMask.checked && this.maskImage) g.drawImage(this.maskCanvas, 0, 0, PREVIEW.width, PREVIEW.height)
    g.setTransform(1, 0, 0, 1, 0, 0)

    if (debug && this.showFace.checked && face) {
      const b = face.box
      const x = (1 - (b.x + b.width)) * PREVIEW.width
      const y = b.y * PREVIEW.height
      g.lineWidth = 2
      g.setLineDash(face.visible ? [] : [6, 4])
      g.strokeStyle = face.visible ? '#4fc3ff' : '#ffb340'
      g.strokeRect(x, y, b.width * PREVIEW.width, b.height * PREVIEW.height)
      g.setLineDash([])
      g.font = '12px Menlo, monospace'
      g.textAlign = 'left'
      g.fillStyle = g.strokeStyle
      g.fillText(face.visible ? 'face' : 'face (held)', x, y - 5)
    }

    g.lineWidth = 1.5
    g.strokeStyle = 'rgba(255,255,255,0.6)'
    g.font = '600 13px -apple-system, system-ui, sans-serif'
    g.textAlign = 'center'
    for (const hand of hands) {
      const info = this.labels.get(hand.side)
      const pts = hand.landmarks
      g.beginPath()
      for (const [a, b] of BONES) {
        g.moveTo(sx(pts[a]!), sy(pts[a]!))
        g.lineTo(sx(pts[b]!), sy(pts[b]!))
      }
      g.stroke()
      g.fillStyle = info?.pinching ? '#ff4fd8' : '#33ff99'
      g.beginPath()
      for (let k = 0; k < pts.length; k++) {
        const r = k % 4 === 0 ? 3.5 : 2.5
        const x = sx(pts[k]!)
        const y = sy(pts[k]!)
        g.moveTo(x + r, y)
        g.arc(x, y, r, 0, Math.PI * 2)
      }
      g.fill()
      if (info) {
        const x = sx(pts[0]!)
        const y = sy(pts[0]!)
        g.fillStyle = '#ffe066'
        g.fillText(info.title, x, y + 18)
        if (debug) {
          g.fillStyle = '#ffffff'
          g.fillText(info.detail, x, y + 34)
        }
      }
    }
  }
}
