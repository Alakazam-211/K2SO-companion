// Android system Back for the in-app layers that aren't router history:
// Zen's sheets, drawers and the open thread all live in component/store
// state, so the WebView sees no history and Back used to exit the app.
//
// Each open layer registers its close action with useBackHandler; the
// most recently registered one (the topmost layer) runs on Back.
// MainActivity.kt asks `window.__k2Back()` first and only falls back to
// WebView history / exiting when it returns false.

import { useEffect, useRef } from "react";

type Entry = { run: () => void };
const stack: Entry[] = [];

/** Register a Back handler; returns its unregister. */
export function pushBackHandler(run: () => void): () => void {
  const entry: Entry = { run };
  stack.push(entry);
  return () => {
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Run the topmost handler. False when nothing in-app claims Back. */
export function handleAndroidBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.run();
  return true;
}

/** Test hook: the number of registered handlers. */
export function backHandlerCount(): number {
  return stack.length;
}

/** While `active`, Back calls `onBack` (the latest closure). Layers that
 *  open later register later, so the topmost one wins. */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => ref.current());
  }, [active]);
}

/** Expose the dispatcher to MainActivity.kt (called from main.tsx). */
export function installAndroidBack(): void {
  (window as unknown as { __k2Back?: () => boolean }).__k2Back = handleAndroidBack;
}
