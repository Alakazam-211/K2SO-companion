import { describe, expect, it, vi } from 'vitest'

import terminalView from '../components/TerminalView.tsx?raw'

import {
  TERMINAL_FONT_FACE,
  TERMINAL_FONT_FAMILY,
  loadTerminalFont,
} from './terminalFont'

describe('TERMINAL_FONT_FAMILY', () => {
  it('leads with the bundled Meslo Nerd Font, like desktop Kessel', () => {
    const first = TERMINAL_FONT_FAMILY.split(',')[0].trim()
    expect(first).toBe(`'${TERMINAL_FONT_FACE}'`)
    expect(TERMINAL_FONT_FAMILY).toContain("'MesloLGM Nerd Font'")
    expect(TERMINAL_FONT_FAMILY.trim().endsWith('monospace')).toBe(true)
  })

  it('is the face the terminal view probes and rasterizes with', () => {
    expect(terminalView).toMatch(/const FONT_FAMILY = TERMINAL_FONT_FAMILY;/)
    // A late font load re-probes the cells and rebuilds the atlas.
    expect(terminalView).toMatch(/\}, \[painterFatal, fontEpoch\]\);/)
    expect(terminalView).toMatch(/\}, \[webglSurfaceActive, cellW, lineH, dpr, fontEpoch\]\);/)
  })
})

describe('loadTerminalFont', () => {
  it('loads regular and bold at the terminal size', async () => {
    const load = vi.fn(async () => [{}])
    await expect(loadTerminalFont(10, { load })).resolves.toBe(true)
    expect(load).toHaveBeenCalledWith(`10px "${TERMINAL_FONT_FACE}"`)
    expect(load).toHaveBeenCalledWith(`bold 10px "${TERMINAL_FONT_FACE}"`)
  })

  it('is false when a weight did not match a face', async () => {
    const load = vi.fn(async (font: string) => (font.startsWith('bold') ? [] : [{}]))
    await expect(loadTerminalFont(10, { load })).resolves.toBe(false)
  })

  it('never rejects: no FontFaceSet or a failed load is false', async () => {
    await expect(loadTerminalFont(10, null)).resolves.toBe(false)
    await expect(loadTerminalFont(10, undefined)).resolves.toBe(false)
    const load = vi.fn(async () => {
      throw new Error('network')
    })
    await expect(loadTerminalFont(10, { load })).resolves.toBe(false)
  })
})
