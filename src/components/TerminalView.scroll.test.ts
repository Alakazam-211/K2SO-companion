import { describe, expect, it } from 'vitest'
import { nativeScrollToPx } from './TerminalView'

describe('nativeScrollToPx', () => {
  it('is 0 at the bottom and max/scale at the top', () => {
    expect(nativeScrollToPx(400, 500, 100, 1)).toBe(0)
    expect(nativeScrollToPx(0, 500, 100, 1)).toBe(400)
    expect(nativeScrollToPx(0, 500, 100, 2)).toBe(200)
  })

  it('collapses when there is nothing to scroll', () => {
    expect(nativeScrollToPx(0, 100, 100, 1)).toBe(0)
    expect(nativeScrollToPx(10, 80, 100, 1)).toBe(0)
    expect(nativeScrollToPx(0, 200, 100, 0)).toBe(0)
  })
})
