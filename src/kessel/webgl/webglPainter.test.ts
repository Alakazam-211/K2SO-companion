import { describe, expect, it, vi } from 'vitest'
import { createWebglPainter } from './webglPainter'
import type { PainterBackend } from './glBackend'

function stubBackend(): PainterBackend {
  return {
    resize: vi.fn(),
    beginFrame: vi.fn(),
    drawRects: vi.fn(),
    uploadAtlas: vi.fn(),
    drawGlyphs: vi.fn(),
    readPixel: () => [0x3a, 0x7b, 0x19, 0xff],
    dispose: vi.fn(),
  }
}

describe('createWebglPainter — fatal policy', () => {
  it('onFatal fires once when WebGL2 is unavailable', () => {
    const painter = createWebglPainter({ createBackend: () => null })
    const onFatal = vi.fn()
    painter.onFatal(onFatal)
    const canvas = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      width: 0,
      height: 0,
      style: {},
    } as unknown as HTMLCanvasElement
    painter.mount(canvas)
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledWith('webgl2-unavailable')
    painter.mount(canvas)
    expect(onFatal).toHaveBeenCalledTimes(1)
    painter.dispose()
  })

  it('replays a mount-time fatal to a late subscriber', () => {
    const painter = createWebglPainter({ createBackend: () => null })
    const canvas = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      width: 0,
      height: 0,
      style: {},
    } as unknown as HTMLCanvasElement
    painter.mount(canvas)
    const onFatal = vi.fn()
    painter.onFatal(onFatal)
    expect(onFatal).toHaveBeenCalledWith('webgl2-init-failed')
    painter.dispose()
  })

  it('sanity readback mismatch is fatal', () => {
    const backend = stubBackend()
    backend.readPixel = () => [0, 0, 0, 255]
    const painter = createWebglPainter({ createBackend: () => backend })
    const onFatal = vi.fn()
    painter.onFatal(onFatal)
    const canvas = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      width: 0,
      height: 0,
      style: {},
    } as unknown as HTMLCanvasElement
    painter.mount(canvas)
    expect(onFatal).toHaveBeenCalledWith('webgl2-sanity-readback-failed')
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    painter.dispose()
  })

  it('hides the dead buffer on context lost (no 3s black canvas)', () => {
    const backend = stubBackend()
    const painter = createWebglPainter({ createBackend: () => backend })
    const listeners = new Map<string, EventListener>()
    const canvas = {
      addEventListener: (type: string, fn: EventListener) => {
        listeners.set(type, fn)
      },
      removeEventListener: vi.fn(),
      width: 8,
      height: 8,
      style: { visibility: '' },
    } as unknown as HTMLCanvasElement
    painter.mount(canvas)
    const lost = listeners.get('webglcontextlost')
    expect(lost).toBeTypeOf('function')
    lost?.({ preventDefault: vi.fn() } as unknown as Event)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(canvas.style.visibility).toBe('hidden')
    painter.dispose()
  })
})
