// Session-scoped WebGL vs DOM surface. onFatal demotes this session
// only; the next terminalId retries. Hidden + live WebGL keeps the
// empty scroll shell — do not mount the full DOM strip on lock.

import { TEXT_GAMMA_DARK } from '../text-gamma'
import type { PainterTheme } from './painterTypes'

export const CONTEXT_LOST_UNRESTORED = 'webgl-context-lost-unrestored'

export const PAINTER_THEME: PainterTheme = {
  fg: 0xe0e0e0,
  bg: 0x0a0a0a,
  selection: 0x444444,
  textGamma: TEXT_GAMMA_DARK,
}

export type PainterSurface = 'webgl' | 'dom' | 'shell'

export function resolvePainterSurface(opts: {
  painterFatal: string | null
  surfaceWanted: boolean
  hasLiveGrid: boolean
  cellReady: boolean
}): PainterSurface {
  const useWebgl =
    opts.painterFatal === null && opts.hasLiveGrid && opts.cellReady
  if (useWebgl && opts.surfaceWanted) return 'webgl'
  if (useWebgl) return 'shell'
  return 'dom'
}

/** Foreground remount only after unrestored context loss. */
export function shouldClearFatalOnForeground(fatal: string | null): boolean {
  return fatal === CONTEXT_LOST_UNRESTORED
}
