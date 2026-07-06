// T4 — the Direct-type text-commit pipeline for the hidden capture
// input (components/LiveInputCapture.tsx).
//
// Adapted from Orca's terminal-live-text-commit.ts +
// terminal-text-input-normalization.ts (MIT, Copyright (c) 2026
// Lovecast Inc. — full notice in lib/terminalKeys.ts, the verbatim
// byte-table port). The COMMIT STRATEGY is re-platformed for the web:
// React Native exposed no portable composition events, so Orca settled
// ALL non-ASCII text on timers; WKWebView gives real
// `compositionstart/end`, so the IME path here is event-driven
// (buffer during composition, emit exactly the composed text on
// compositionend) and Orca's timers survive only as the FALLBACK for
// non-ASCII that arrives without composition events (dictation, emoji
// keyboard, exotic IMEs).
//
// Invariants (Orca's, kept):
//   • plain ASCII commits immediately (typing latency is the product);
//   • Hangul waits indefinitely for composition to finish (delay null);
//   • other non-ASCII settles after 150ms;
//   • backspace while text is PENDING edits locally, never sends \x7f;
//   • pending text always flushes BEFORE a control byte (ordering);
//   • Enter is never synthesized here — the capture's keydown owns \r.
//
// Pure + Node-testable (scripts/test-live-input.mjs).

// Why: iOS smart punctuation can rewrite two ASCII hyphens into a single
// Unicode dash before the input event delivers terminal text.
const IOS_SMART_DASH_REPLACEMENT_PATTERN = /[–—]/g
const IOS_SMART_DASH_REPLACEMENT_TEST = /[–—]/

export function normalizeTerminalTextInput(text: string, previousText = ''): string {
  const normalizedText = text.replace(IOS_SMART_DASH_REPLACEMENT_PATTERN, '--')
  const previousTrailingHyphens = /-+$/.exec(previousText)?.[0] ?? ''
  const previousPrefix = previousText.slice(0, previousText.length - previousTrailingHyphens.length)
  const collapsedPreviousHyphenRun =
    previousTrailingHyphens.length >= 2 &&
    IOS_SMART_DASH_REPLACEMENT_TEST.test(text) &&
    (text === `${previousPrefix}–` || text === `${previousPrefix}—`)
  if (collapsedPreviousHyphenRun) {
    return `${previousText}-`
  }
  return normalizedText
}

export const LIVE_TEXT_COMMIT_DELAY_MS = 150

export type LiveTextChangeDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'send-now'; readonly text: string }
  | { readonly kind: 'defer'; readonly text: string; readonly delayMs: number | null }

export function isImeTextCandidate(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint > 0x7f) {
      return true
    }
  }
  return false
}

function isHangulCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  )
}

export function isHangulTextCandidate(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isHangulCodePoint(codePoint)) {
      return true
    }
  }
  return false
}

/** How NON-composition text commits: ASCII now, Hangul waits for more
 *  input (no timer), other IME-shaped text settles after 150ms. */
export function getTextChangeDecision(text: string): LiveTextChangeDecision {
  if (text.length === 0) {
    return { kind: 'ignore' }
  }
  if (isHangulTextCandidate(text)) {
    return { kind: 'defer', text, delayMs: null }
  }
  if (isImeTextCandidate(text)) {
    return { kind: 'defer', text, delayMs: LIVE_TEXT_COMMIT_DELAY_MS }
  }
  return { kind: 'send-now', text }
}

export function getDeferredTextDelayMs(text: string): number | null {
  return isHangulTextCandidate(text) ? null : LIVE_TEXT_COMMIT_DELAY_MS
}

export type LiveLocalEdit = 'backspace' | 'delete'

export type LiveControlByteDecision =
  | { readonly kind: 'local-edit'; readonly localEdit: LiveLocalEdit }
  | { readonly kind: 'send-now'; readonly bytes: string }
  | { readonly kind: 'flush-then-send'; readonly pendingText: string; readonly bytes: string }

export type LiveControlByteDecisionInput = {
  readonly bytes: string
  readonly localEdit?: LiveLocalEdit
  readonly pendingText: string
}

/** Control bytes (accessory keys, hardware specials) against pending
 *  text: backspace/delete edit the pending text LOCALLY; anything else
 *  flushes the pending text first so bytes arrive in typed order. */
export function getControlByteDecision({
  bytes,
  localEdit,
  pendingText
}: LiveControlByteDecisionInput): LiveControlByteDecision {
  if (pendingText.length > 0 && localEdit) {
    return { kind: 'local-edit', localEdit }
  }
  if (pendingText.length > 0) {
    return { kind: 'flush-then-send', pendingText, bytes }
  }
  return { kind: 'send-now', bytes }
}

export function getLocalEditText({
  localEdit,
  pendingText
}: {
  readonly localEdit: LiveLocalEdit
  readonly pendingText: string
}): string {
  if (localEdit === 'delete') {
    // Why: forward-delete at the hidden input's end stays local but
    // does not remove the pending IME text.
    return pendingText
  }
  return Array.from(pendingText).slice(0, -1).join('')
}

// ── The stateful pipeline the capture component drives ──

export type LiveInputSink = {
  /** Deliver bytes to the PTY (the grid-WS input seam). */
  sendBytes: (bytes: string) => void
  /** Mirror local-edit / clear results back into the hidden field. */
  setFieldValue: (value: string) => void
}

/** One per mounted capture. The component forwards raw DOM events;
 *  this owns pending text, composition state and the settle timer.
 *  Injected sink keeps it Node-testable (no DOM). */
export class LiveTextCommitPipeline {
  private pending = ''
  private composing = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private sink: LiveInputSink

  // No TS parameter property: Node's native type-stripping (the test
  // harness) only ERASES types, it can't rewrite constructor sugar.
  constructor(sink: LiveInputSink) {
    this.sink = sink
  }

  get isComposing(): boolean {
    return this.composing
  }

  get pendingText(): string {
    return this.pending
  }

  /** `compositionstart`: anything deferred BEFORE the IME opened must
   *  land before the composition's output; the field itself is left
   *  alone (the IME owns it until compositionend). */
  compositionStart(): void {
    if (this.pending.length > 0) {
      this.cancelTimer()
      const out = this.pending
      this.pending = ''
      this.sink.sendBytes(out)
    }
    this.composing = true
  }

  /** `compositionend`: emit exactly the composed text (normalized),
   *  clear the field. Empty data = canceled composition, nothing sent. */
  compositionEnd(text: string): void {
    this.composing = false
    this.pending = ''
    this.sink.setFieldValue('')
    const out = normalizeTerminalTextInput(text)
    if (out.length > 0) {
      this.sink.sendBytes(out)
    }
  }

  /** `input` with the field's current value. During composition the
   *  IME paints the field itself — just track it as pending (so
   *  control bytes know text is outstanding). Otherwise: ASCII sends
   *  now; non-ASCII without composition events takes Orca's fallback
   *  timers. Newlines never pass through here — Enter is keydown's. */
  fieldInput(value: string): void {
    if (this.composing) {
      this.pending = value
      return
    }
    this.cancelTimer()
    const text = normalizeTerminalTextInput(value.replace(/[\r\n]/g, ''), this.pending)
    const decision = getTextChangeDecision(text)
    if (decision.kind === 'ignore') {
      this.pending = ''
      this.sink.setFieldValue('')
      return
    }
    if (decision.kind === 'send-now') {
      this.pending = ''
      this.sink.setFieldValue('')
      this.sink.sendBytes(decision.text)
      return
    }
    this.pending = decision.text
    this.armTimer(decision.delayMs)
  }

  /** Send pending text now (settle-timer fire, or ordering before a
   *  control byte). */
  flushPending(): void {
    this.cancelTimer()
    if (this.pending.length === 0) return
    const out = this.pending
    this.pending = ''
    this.sink.setFieldValue('')
    this.sink.sendBytes(out)
  }

  /** Control bytes from the accessory bar / hardware specials.
   *  Ordering rule: pending text flushes FIRST. Backspace/delete with
   *  pending text edit locally instead of sending. A control byte
   *  mid-composition force-commits what the IME had (clearing the
   *  field ends the session) so e.g. Ctrl+C still lands in order. */
  controlBytes(bytes: string, localEdit?: LiveLocalEdit): void {
    if (this.composing && localEdit) {
      // The IME owns backspace inside its own composition.
      return
    }
    this.composing = false
    const decision = getControlByteDecision({ bytes, localEdit, pendingText: this.pending })
    if (decision.kind === 'local-edit') {
      this.cancelTimer()
      this.pending = getLocalEditText({ localEdit: decision.localEdit, pendingText: this.pending })
      this.sink.setFieldValue(this.pending)
      if (this.pending.length > 0) {
        this.armTimer(getDeferredTextDelayMs(this.pending))
      }
      return
    }
    if (decision.kind === 'flush-then-send') {
      this.flushPending()
      this.sink.sendBytes(decision.bytes)
      return
    }
    this.sink.sendBytes(decision.bytes)
  }

  /** Unmount: drop the timer; pending text dies with the capture. */
  dispose(): void {
    this.cancelTimer()
    this.pending = ''
    this.composing = false
  }

  private armTimer(delayMs: number | null): void {
    this.cancelTimer()
    if (delayMs === null) return // Hangul: wait for more input, no timer
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushPending()
    }, delayMs)
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
