// A/B switch for a lighter blur (Diagnostics → "Light blur"): the Zen
// header and footer blur stacks drop from four live backdrop-filter layers
// to two (index.css `.k2-light-blur`). Off by default: the shipped look is
// the four-layer stack. A class on <html>, kept in localStorage (this
// phone only).

export const LIGHT_BLUR_KEY = "k2.debug.lightBlur";
export const LIGHT_BLUR_CLASS = "k2-light-blur";

const listeners = new Set<() => void>();

export function lightBlurOn(): boolean {
  try {
    return localStorage.getItem(LIGHT_BLUR_KEY) === "1";
  } catch {
    return false;
  }
}

function apply(on: boolean): void {
  try {
    document.documentElement.classList.toggle(LIGHT_BLUR_CLASS, on);
  } catch {
    /* no document */
  }
}

export function setLightBlur(on: boolean): void {
  try {
    if (on) localStorage.setItem(LIGHT_BLUR_KEY, "1");
    else localStorage.removeItem(LIGHT_BLUR_KEY);
  } catch {
    /* private mode: this run only */
  }
  apply(on);
  for (const fn of [...listeners]) fn();
}

/** Stamp the saved choice on <html> before the first render. */
export function initLightBlur(): void {
  apply(lightBlurOn());
}

export function subscribeLightBlur(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
