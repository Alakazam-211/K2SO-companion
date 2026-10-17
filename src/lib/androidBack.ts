// Android system Back for the in-app layers that aren't router history:
// Zen's sheets, drawers and the open thread all live in component/store
// state, so the WebView sees no history and Back used to exit the app.
//
// Each open layer registers its close action with useBackHandler; the
// most recently registered one (the topmost layer) runs on Back.
// MainActivity.kt asks `window.__k2Back()` first and only falls back to
// WebView history / exiting when it returns false.
//
// The same stack answers "is anything open over me?" for the left-edge
// swipe-back (useSwipeBack): a screen swipes only while its own handler
// is the topmost layer, so a sheet, drawer or menu above it never lets
// an edge drag move the screen behind.

import { useCallback, useEffect, useRef } from "react";

type Entry = { run: () => void };
const stack: Entry[] = [];

/** Register a Back layer: `remove` unregisters it, `isTop` is true
 *  while nothing registered after it is still open. */
export function pushBackLayer(run: () => void): { remove: () => void; isTop: () => boolean } {
  const entry: Entry = { run };
  stack.push(entry);
  return {
    remove: () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    },
    isTop: () => stack[stack.length - 1] === entry,
  };
}

/** Register a Back handler; returns its unregister. */
export function pushBackHandler(run: () => void): () => void {
  return pushBackLayer(run).remove;
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
 *  open later register later, so the topmost one wins. Returns a stable
 *  getter: true while this layer is registered and the topmost one
 *  (read it at touch start, e.g. as useSwipeBack's `enabled`). */
export function useBackHandler(active: boolean, onBack: () => void): () => boolean {
  const ref = useRef(onBack);
  ref.current = onBack;
  const layer = useRef<ReturnType<typeof pushBackLayer> | null>(null);
  useEffect(() => {
    if (!active) return;
    const l = pushBackLayer(() => ref.current());
    layer.current = l;
    return () => {
      l.remove();
      if (layer.current === l) layer.current = null;
    };
  }, [active]);
  return useCallback(() => layer.current?.isTop() ?? false, []);
}

/** Expose the dispatcher to MainActivity.kt (called from main.tsx). */
export function installAndroidBack(): void {
  (window as unknown as { __k2Back?: () => boolean }).__k2Back = handleAndroidBack;
}
