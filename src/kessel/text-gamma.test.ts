import { describe, expect, it } from 'vitest'
import {
  TEXT_GAMMA_DARK,
  TEXT_GAMMA_LIGHT,
  TEXT_GAMMA_MAX,
  TEXT_GAMMA_MIN,
  clampTextGamma,
  clearStoredTextGamma,
  defaultTextGammaFor,
  readStoredTextGamma,
  relativeLuminance,
  textGammaStorageKey,
  writeStoredTextGamma,
} from './text-gamma'

const mem = new Map<string, string>()
if (typeof localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
    configurable: true,
  })
}

describe('clampTextGamma', () => {
  it('clamps to [0.5, 3]', () => {
    expect(clampTextGamma(0.1)).toBe(TEXT_GAMMA_MIN)
    expect(clampTextGamma(9)).toBe(TEXT_GAMMA_MAX)
    expect(clampTextGamma(1.2)).toBe(1.2)
  })
  it('falls back to the dark-app preset for non-finite', () => {
    expect(clampTextGamma(Number.NaN)).toBe(TEXT_GAMMA_DARK)
    expect(clampTextGamma(Number.POSITIVE_INFINITY)).toBe(TEXT_GAMMA_DARK)
  })
})

describe('relativeLuminance / defaultTextGammaFor', () => {
  it('classifies pure black as dark → 0.7', () => {
    expect(relativeLuminance(0x000000)).toBe(0)
    expect(defaultTextGammaFor(0x000000)).toBe(TEXT_GAMMA_DARK)
    expect(defaultTextGammaFor('#000')).toBe(TEXT_GAMMA_DARK)
  })
  it('classifies pure white as light → light preset', () => {
    expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 5)
    expect(defaultTextGammaFor(0xffffff)).toBe(TEXT_GAMMA_LIGHT)
    expect(defaultTextGammaFor('#ffffff')).toBe(TEXT_GAMMA_LIGHT)
  })
  it('classifies Companion default bg as dark', () => {
    expect(defaultTextGammaFor(0x0a0a0a)).toBe(TEXT_GAMMA_DARK)
  })
})

describe('per-style storage keys', () => {
  it('keys include style id and scheme', () => {
    expect(textGammaStorageKey('square', 'dark')).toBe('k2.textGamma.square.dark')
    expect(textGammaStorageKey('glass', 'light')).toBe('k2.textGamma.glass.light')
  })

  it('write / read / clear round-trip', () => {
    mem.clear()
    writeStoredTextGamma('square', 'dark', 1.75)
    expect(readStoredTextGamma('square', 'dark')).toBe(1.75)
    clearStoredTextGamma('square', 'dark')
    expect(readStoredTextGamma('square', 'dark')).toBeNull()
  })
})
