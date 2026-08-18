import { describe, expect, it } from 'vitest'
import { computeStripLayout, maxScrollPx } from '../scrollMath'
import { nativeScrollToPx } from './nativeScroll'

describe('nativeScrollToPx', () => {
  it('is 0 at the bottom and maxScrollPx at the top', () => {
    expect(nativeScrollToPx(400, 500, 100, 20, 20)).toBe(0)
    expect(nativeScrollToPx(0, 500, 100, 20, 20)).toBe(400)
    expect(nativeScrollToPx(200, 500, 100, 20, 20)).toBe(200)
  })

  it('collapses when there is nothing to scroll', () => {
    expect(nativeScrollToPx(0, 100, 100, 20, 20)).toBe(0)
    expect(nativeScrollToPx(10, 80, 100, 20, 20)).toBe(0)
    expect(nativeScrollToPx(0, 200, 100, 0, 20)).toBe(0)
    expect(nativeScrollToPx(0, 200, 100, 20, 0)).toBe(0)
  })

  it('letterboxed Watch shell: native-top is maxScrollPx, native-bottom is 0', () => {
    const lineH = 17
    const sb = 100
    const viewportRows = 24
    const totalRows = sb + viewportRows
    const scale = 0.58
    const offsetY = 230
    const originY = 4 + offsetY
    const stripH = totalRows * lineH
    const scrollHeight = originY + stripH * scale
    const clientHeight = 700
    const max = maxScrollPx(sb, lineH)
    expect(max).toBe(1700)
    expect(nativeScrollToPx(0, scrollHeight, clientHeight, sb, lineH)).toBe(max)
    const overflow = scrollHeight - clientHeight
    expect(
      nativeScrollToPx(overflow, scrollHeight, clientHeight, sb, lineH),
    ).toBe(0)
    const topLayout = computeStripLayout(max, totalRows, viewportRows, lineH, 0)
    expect(topLayout.firstVisibleRow).toBe(0)
    const botLayout = computeStripLayout(0, totalRows, viewportRows, lineH, 0)
    expect(botLayout.firstVisibleRow).toBe(sb)
  })

  it('clamps iOS rubber-band before packFrame', () => {
    const max = maxScrollPx(100, 17)
    expect(nativeScrollToPx(-40, 1450, 700, 100, 17)).toBe(max)
    expect(nativeScrollToPx(900, 1450, 700, 100, 17)).toBe(0)
  })
})
