import { describe, expect, it } from 'vitest'
import {
  CONTEXT_LOST_UNRESTORED,
  resolvePainterSurface,
  shouldClearFatalOnForeground,
} from './painterSession'
import { TEXT_GAMMA_DARK } from '../text-gamma'
import { PAINTER_THEME } from './painterSession'

describe('resolvePainterSurface', () => {
  const live = { hasLiveGrid: true, cellReady: true }

  it('defaults to WebGL when the session is live and visible', () => {
    expect(
      resolvePainterSurface({
        painterFatal: null,
        surfaceWanted: true,
        ...live,
      }),
    ).toBe('webgl')
  })

  it('onFatal mounts the DOM strip for that session', () => {
    expect(
      resolvePainterSurface({
        painterFatal: 'webgl2-unavailable',
        surfaceWanted: true,
        ...live,
      }),
    ).toBe('dom')
  })

  it('hidden + no fatal keeps the empty shell (no DOM strip)', () => {
    expect(
      resolvePainterSurface({
        painterFatal: null,
        surfaceWanted: false,
        ...live,
      }),
    ).toBe('shell')
  })

  it('HTTP / pre-stream never creates a painter', () => {
    expect(
      resolvePainterSurface({
        painterFatal: null,
        surfaceWanted: true,
        hasLiveGrid: false,
        cellReady: true,
      }),
    ).toBe('dom')
  })
})

describe('shouldClearFatalOnForeground', () => {
  it('retries only unrestored context loss', () => {
    expect(shouldClearFatalOnForeground(CONTEXT_LOST_UNRESTORED)).toBe(true)
    expect(shouldClearFatalOnForeground('webgl2-unavailable')).toBe(false)
    expect(shouldClearFatalOnForeground('webgl2-sanity-readback-failed')).toBe(
      false,
    )
    expect(shouldClearFatalOnForeground(null)).toBe(false)
  })
})

describe('PAINTER_THEME', () => {
  it('bakes the dark-app gamma', () => {
    expect(PAINTER_THEME.textGamma).toBe(TEXT_GAMMA_DARK)
    expect(PAINTER_THEME.textGamma).toBe(0.7)
  })
})
