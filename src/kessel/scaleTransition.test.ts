import { describe, expect, it } from 'vitest'

import { SCALE_TRANSITION_MS, scaleTransitionCss } from './scaleTransition'

describe('scaleTransitionCss', () => {
  it('is none until the show has settled', () => {
    expect(scaleTransitionCss(false)).toBe('none')
  })

  it('animates the scale and its clip box at desktop timing', () => {
    expect(SCALE_TRANSITION_MS).toBe(120)
    const css = scaleTransitionCss(true)
    for (const p of ['transform', 'left', 'top', 'width', 'height']) {
      expect(css).toContain(`${p} 120ms ease-out`)
    }
  })
})
