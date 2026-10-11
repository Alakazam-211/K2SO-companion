// The WebGL canvas paints only when asked (painterTypes: `render()` is
// the sole entry point). Desktop TerminalPane repaints on scroll from
// the scroll rAF (vsync pump) and keeps `scrollPx` in the paint
// effect's deps; a touch scroll with no new grid frame must do the
// same on the phone or the canvas stays frozen.
import { describe, expect, it } from 'vitest'

import terminalView from '../../components/TerminalView.tsx?raw'

describe('TerminalView WebGL scroll repaint', () => {
  it('paints from the touch-scroll rAF before committing scrollPx', () => {
    expect(terminalView).toMatch(
      /scrollPxRef\.current = next;\s*(\/\/[^\n]*\n\s*)*paintWebglRef\.current\(next\);\s*setScrollPx\(next\);/,
    )
  })

  it('keeps scrollPx in the paint layout effect deps', () => {
    expect(terminalView).toMatch(
      /paintWebglRef\.current\(scrollPxRef\.current, liveSnap\);\s*\}, \[webglSurfaceActive, liveSnap, scrollPx,/,
    )
  })
})
