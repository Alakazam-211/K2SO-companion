import { describe, expect, it } from 'vitest'

import {
  MAX_NOTCHES_PER_FLUSH,
  accumulateWheelPx,
  canSendSgrWheel,
  encodeSgrWheel,
  flushWheelNotches,
  initialWheelPump,
  sgrInputActions,
} from './sgrWheel'

describe('canSendSgrWheel', () => {
  it('is false in Watch even when the child wants SGR / alt-screen', () => {
    expect(
      canSendSgrWheel({
        drive: false,
        mouseReport: true,
        sgrMouse: true,
      }),
    ).toBe(false)
    expect(
      canSendSgrWheel({ mouseReport: true, sgrMouse: true }),
    ).toBe(false)
  })

  it('is true only with Drive + mouseReport + sgrMouse', () => {
    expect(
      canSendSgrWheel({
        drive: true,
        mouseReport: true,
        sgrMouse: true,
      }),
    ).toBe(true)
    expect(
      canSendSgrWheel({
        drive: true,
        mouseReport: true,
        sgrMouse: false,
      }),
    ).toBe(false)
    expect(canSendSgrWheel({ drive: true })).toBe(false)
  })
})

describe('encodeSgrWheel', () => {
  it('encodes 64/65 at 1-based cells', () => {
    expect(encodeSgrWheel('up', 5, 10)).toBe('\x1b[<64;5;10M')
    expect(encodeSgrWheel('down', 1, 1)).toBe('\x1b[<65;1;1M')
    expect(encodeSgrWheel('down', 0, -3)).toBe('\x1b[<65;1;1M')
  })
})

describe('sgrInputActions', () => {
  it('Watch emits nothing (never terminal.write, never grid input)', () => {
    expect(sgrInputActions(false, '\x1b[<64;1;1M')).toEqual([])
    expect(sgrInputActions(false, '')).toEqual([])
  })

  it('Drive emits a single grid input frame', () => {
    expect(sgrInputActions(true, '\x1b[<64;1;1M')).toEqual([
      { action: 'input', text: '\x1b[<64;1;1M' },
    ])
    expect(sgrInputActions(true, '')).toEqual([])
  })
})

describe('wheel pump (rAF flush / 32-notch / remainder drop)', () => {
  const CELL = 20

  it('sub-notch movement emits nothing and keeps the remainder', () => {
    const r = flushWheelNotches({ accumPx: 7 }, CELL, 1, 1)
    expect(r.ticks).toBe(0)
    expect(r.seq).toBe('')
    expect(r.state.accumPx).toBe(7)
  })

  it('one cell-height is one notch; remainder drains', () => {
    const r = flushWheelNotches({ accumPx: CELL }, CELL, 3, 4)
    expect(r.ticks).toBe(1)
    expect(r.dir).toBe('down')
    expect(r.seq).toBe('\x1b[<65;3;4M')
    expect(r.state.accumPx).toBe(0)
  })

  it('negative accum is wheel-up (64)', () => {
    const r = flushWheelNotches({ accumPx: -2 * CELL }, CELL, 1, 1)
    expect(r.ticks).toBe(2)
    expect(r.dir).toBe('up')
    expect(r.seq).toBe('\x1b[<64;1;1M\x1b[<64;1;1M')
    expect(r.state.accumPx).toBe(0)
  })

  it('caps at 32 notches and drops overflow, keeping sub-notch remainder', () => {
    const r = flushWheelNotches(
      { accumPx: (MAX_NOTCHES_PER_FLUSH + 5.25) * CELL },
      CELL,
      1,
      1,
    )
    expect(r.ticks).toBe(MAX_NOTCHES_PER_FLUSH)
    expect(r.seq).toBe('\x1b[<65;1;1M'.repeat(MAX_NOTCHES_PER_FLUSH))
    expect(r.state.accumPx).toBeCloseTo(0.25 * CELL)
  })

  it('below-cap remainder is the unused sub-notch, not the overflow drop', () => {
    const r = flushWheelNotches({ accumPx: 2.4 * CELL }, CELL, 1, 1)
    expect(r.ticks).toBe(2)
    expect(r.state.accumPx).toBeCloseTo(0.4 * CELL)
  })

  it('direction reversal clears the old remainder', () => {
    const mid = accumulateWheelPx(initialWheelPump(), 7)
    expect(mid.accumPx).toBe(7)
    const flipped = accumulateWheelPx(mid, -10)
    expect(flipped.accumPx).toBe(-10)
  })
})
