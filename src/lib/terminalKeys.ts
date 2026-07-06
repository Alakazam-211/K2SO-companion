// Terminal key-chord byte tables + builders — ported from Orca
// (mobile/src/terminal/terminal-accessory-keys.ts and the special-key
// map of terminal-live-input.ts), adapted for the companion's web
// runtime (React-Native-only plumbing stripped; the byte machinery is
// verbatim — this encoding is exactly what xterm-compatible PTYs
// expect, and hand-rolling it is how the SS3→CSI modifier flip gets
// missed).
//
// MIT License
// Copyright (c) 2026 Lovecast Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, subject
// to the above copyright notice and this permission notice being
// included in all copies or substantial portions of the Software.
//
// Pure + Node-testable (scripts/test-terminal-keys.mjs).

export type TerminalAccessoryKey = {
  id: string
  label: string
  bytes: string
  accessibilityLabel?: string
  repeatable?: boolean
}

export type TerminalShortcutModifier = 'ctrl' | 'alt' | 'shift'

export type TerminalShortcutBinding = {
  key: string
  modifiers: TerminalShortcutModifier[]
}

export type TerminalShortcutBuildResult = {
  label: string
  bytes: string
  accessibilityLabel: string
}

const ESC = '\x1b'

const MODIFIER_LABELS: Record<TerminalShortcutModifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift'
}

const MODIFIER_ORDER: TerminalShortcutModifier[] = ['ctrl', 'alt', 'shift']

const SHIFTED_PRINTABLE: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?'
}

const CTRL_PRINTABLE_BYTES: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '`': '\x00',
  '[': '\x1b',
  '{': '\x1b',
  '\\': '\x1c',
  '|': '\x1c',
  ']': '\x1d',
  '}': '\x1d',
  '^': '\x1e',
  '~': '\x1e',
  _: '\x1f',
  '?': '\x7f'
}

const SPECIAL_KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  tab: 'Tab',
  enter: 'Enter',
  backspace: '⌫',
  delete: 'Del',
  insert: 'Ins',
  arrowUp: '↑',
  arrowDown: '↓',
  arrowLeft: '←',
  arrowRight: '→',
  home: 'Home',
  end: 'End',
  pageUp: 'PgUp',
  pageDown: 'PgDn',
  space: 'Space',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12'
}

const CSI_FINAL_SPECIAL_KEYS: Record<string, string> = {
  arrowUp: 'A',
  arrowDown: 'B',
  arrowRight: 'C',
  arrowLeft: 'D',
  home: 'H',
  end: 'F',
  f1: 'P',
  f2: 'Q',
  f3: 'R',
  f4: 'S'
}

const SS3_BASE_SPECIAL_KEYS = new Set(['f1', 'f2', 'f3', 'f4'])

const CSI_TILDE_SPECIAL_KEYS: Record<string, number> = {
  insert: 2,
  delete: 3,
  pageUp: 5,
  pageDown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24
}

/** The Direct-mode accessory strip — Orca's proven default set in the
 *  companion's order. `repeatable` keys hold-repeat (AccessoryBar). */
export const TERMINAL_ACCESSORY_KEYS: TerminalAccessoryKey[] = [
  { id: 'escape', label: 'Esc', bytes: '\x1b', accessibilityLabel: 'Escape' },
  { id: 'tab', label: 'Tab', bytes: '\t', accessibilityLabel: 'Tab' },
  // Why: terminal apps recognize ESC [ Z as the reverse-tab sequence.
  { id: 'shiftTab', label: '⇤', bytes: '\x1b[Z', accessibilityLabel: 'Shift Tab' },
  { id: 'arrowLeft', label: '←', bytes: '\x1b[D', accessibilityLabel: 'Arrow Left', repeatable: true },
  { id: 'arrowDown', label: '↓', bytes: '\x1b[B', accessibilityLabel: 'Arrow Down', repeatable: true },
  { id: 'arrowUp', label: '↑', bytes: '\x1b[A', accessibilityLabel: 'Arrow Up', repeatable: true },
  { id: 'arrowRight', label: '→', bytes: '\x1b[C', accessibilityLabel: 'Arrow Right', repeatable: true },
  { id: 'ctrlC', label: '^C', bytes: '\x03', accessibilityLabel: 'Interrupt terminal' },
  { id: 'ctrlD', label: '^D', bytes: '\x04', accessibilityLabel: 'Send EOF' },
  { id: 'ctrlZ', label: '^Z', bytes: '\x1a', accessibilityLabel: 'Suspend process' },
  { id: 'ctrlL', label: '^L', bytes: '\x0c', accessibilityLabel: 'Clear screen' },
  { id: 'ctrlR', label: '^R', bytes: '\x12', accessibilityLabel: 'Reverse search' },
  { id: 'ctrlA', label: '^A', bytes: '\x01', accessibilityLabel: 'Start of line' },
  { id: 'ctrlE', label: '^E', bytes: '\x05', accessibilityLabel: 'End of line' },
  { id: 'ctrlW', label: '^W', bytes: '\x17', accessibilityLabel: 'Delete word backward' },
  { id: 'ctrlU', label: '^U', bytes: '\x15', accessibilityLabel: 'Clear line before cursor' },
  { id: 'backspace', label: '⌫', bytes: '\x7f', accessibilityLabel: 'Backspace', repeatable: true }
]

export function buildTerminalShortcutKey(
  binding: TerminalShortcutBinding
): TerminalShortcutBuildResult | null {
  const key = normalizeShortcutKey(binding.key)
  if (!key) {
    return null
  }
  const modifiers = normalizeModifiers(binding.modifiers)
  const bytes = buildShortcutBytes(key, modifiers)
  if (bytes == null) {
    return null
  }
  const label = formatShortcutLabel(key, modifiers)
  return {
    label,
    bytes,
    accessibilityLabel: label.split('+').join(' ')
  }
}

function buildShortcutBytes(key: string, modifiers: TerminalShortcutModifier[]): string | null {
  if (key === 'space') {
    return buildPrintableShortcutBytes(' ', modifiers)
  }
  const csiFinal = CSI_FINAL_SPECIAL_KEYS[key]
  if (csiFinal) {
    // Why: xterm encodes unmodified F1-F4 as SS3 (ESC O P/S). Once a
    // modifier is present it switches to the CSI 1;N form like arrows.
    if (SS3_BASE_SPECIAL_KEYS.has(key) && csiModifierParameter(modifiers) === 1) {
      return `${ESC}O${csiFinal}`
    }
    return buildCsiFinalShortcut(csiFinal, modifiers)
  }
  const csiTilde = CSI_TILDE_SPECIAL_KEYS[key]
  if (csiTilde) {
    return buildCsiTildeShortcut(csiTilde, modifiers)
  }
  if (key === 'tab') {
    if (modifiers.includes('shift') && !modifiers.includes('ctrl') && !modifiers.includes('alt')) {
      return `${ESC}[Z`
    }
    const bytes = '\t'
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (key === 'escape') {
    const bytes = ESC
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (key === 'enter') {
    const bytes = '\r'
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (key === 'backspace') {
    const bytes = modifiers.includes('ctrl') ? '\b' : '\x7f'
    return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
  }
  if (isPrintableShortcutKey(key)) {
    return buildPrintableShortcutBytes(key, modifiers)
  }
  return null
}

function buildPrintableShortcutBytes(
  key: string,
  modifiers: TerminalShortcutModifier[]
): string | null {
  const shifted = modifiers.includes('shift') ? applyShift(key) : key
  let bytes = shifted
  if (modifiers.includes('ctrl')) {
    const ctrlBytes = controlBytesForPrintable(shifted)
    if (ctrlBytes == null) {
      return null
    }
    bytes = ctrlBytes
  }
  return modifiers.includes('alt') ? `${ESC}${bytes}` : bytes
}

function buildCsiFinalShortcut(final: string, modifiers: TerminalShortcutModifier[]): string {
  const parameter = csiModifierParameter(modifiers)
  return parameter === 1 ? `${ESC}[${final}` : `${ESC}[1;${parameter}${final}`
}

function buildCsiTildeShortcut(code: number, modifiers: TerminalShortcutModifier[]): string {
  const parameter = csiModifierParameter(modifiers)
  return parameter === 1 ? `${ESC}[${code}~` : `${ESC}[${code};${parameter}~`
}

function csiModifierParameter(modifiers: TerminalShortcutModifier[]): number {
  let parameter = 1
  if (modifiers.includes('shift')) {
    parameter += 1
  }
  if (modifiers.includes('alt')) {
    parameter += 2
  }
  if (modifiers.includes('ctrl')) {
    parameter += 4
  }
  return parameter
}

function controlBytesForPrintable(key: string): string | null {
  const lower = key.toLowerCase()
  if (lower >= 'a' && lower <= 'z') {
    return String.fromCharCode(lower.charCodeAt(0) - 96)
  }
  return CTRL_PRINTABLE_BYTES[key] ?? null
}

function applyShift(key: string): string {
  if (key >= 'a' && key <= 'z') {
    return key.toUpperCase()
  }
  if (key >= 'A' && key <= 'Z') {
    return key
  }
  return SHIFTED_PRINTABLE[key] ?? key
}

function normalizeModifiers(modifiers: TerminalShortcutModifier[]): TerminalShortcutModifier[] {
  const selected = new Set(modifiers)
  return MODIFIER_ORDER.filter((modifier) => selected.has(modifier))
}

function normalizeShortcutKey(key: string): string | null {
  if (SPECIAL_KEY_LABELS[key]) {
    return key
  }
  if (key.length === 1 && isPrintableShortcutKey(key)) {
    return key >= 'A' && key <= 'Z' ? key.toLowerCase() : key
  }
  return null
}

function isPrintableShortcutKey(key: string): boolean {
  return key.length === 1 && key >= ' ' && key <= '~'
}

function formatShortcutLabel(key: string, modifiers: TerminalShortcutModifier[]): string {
  const modifierLabels = modifiers.map((modifier) => MODIFIER_LABELS[modifier])
  return [...modifierLabels, displayKeyLabel(key)].join('+')
}

function displayKeyLabel(key: string): string {
  if (SPECIAL_KEY_LABELS[key]) {
    return SPECIAL_KEY_LABELS[key]
  }
  if (key === ' ') {
    return 'Space'
  }
  return key.length === 1 && key >= 'a' && key <= 'z' ? key.toUpperCase() : key
}

// ── KeyboardEvent.key → PTY bytes (terminal-live-input.ts port) ──
//
// Why Enter is ABSENT: Enter stays on the capture's own keydown handler
// (one deliberate `\r`); mapping it here is how carriage returns get
// double-sent when a platform emits both submit and key events.
const LIVE_SPECIAL_KEY_IDS = new Map<string, string>([
  ['Escape', 'escape'],
  ['Esc', 'escape'],
  ['Tab', 'tab'],
  ['Backspace', 'backspace'],
  ['Delete', 'delete'],
  ['Insert', 'insert'],
  ['ArrowUp', 'arrowUp'],
  ['ArrowDown', 'arrowDown'],
  ['ArrowLeft', 'arrowLeft'],
  ['ArrowRight', 'arrowRight'],
  ['Home', 'home'],
  ['End', 'end'],
  ['PageUp', 'pageUp'],
  ['PageDown', 'pageDown'],
  ['F1', 'f1'],
  ['F2', 'f2'],
  ['F3', 'f3'],
  ['F4', 'f4'],
  ['F5', 'f5'],
  ['F6', 'f6'],
  ['F7', 'f7'],
  ['F8', 'f8'],
  ['F9', 'f9'],
  ['F10', 'f10'],
  ['F11', 'f11'],
  ['F12', 'f12']
])

/** Bytes for a hardware-keyboard special key (`KeyboardEvent.key`),
 *  or null when the key isn't a terminal special (printables flow
 *  through the input event; Enter through the capture's own handler). */
export function getLiveSpecialKeyBytes(key: string): string | null {
  const shortcutKey = LIVE_SPECIAL_KEY_IDS.get(key)
  if (!shortcutKey) {
    return null
  }
  return buildTerminalShortcutKey({ key: shortcutKey, modifiers: [] })?.bytes ?? null
}
