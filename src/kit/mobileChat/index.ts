// Mobile chat kit — keyboard / composer behaviour for a chat screen in a
// WKWebView (Tauri iOS), extracted from K2's Thread. See
// docs/mobile-chat-kit.md for the whys.
//
// Viewport store (the keyboard as a published height + motion):
export {
  useViewport,
  useViewportHeight,
  useViewportTrackRef,
  useViewportPadRef,
  fullViewportHeight,
  keyboardMotionMs,
  keyboardFlipTransition,
  viewportTransition,
  keyboardEasing,
  nowEpochMs,
  KEYBOARD_EASING,
  KEYBOARD_MS,
  type ViewportMotion,
  type ViewportState,
  type KeyboardWill,
  type KeyboardSample,
} from "../../lib/useViewportHeight";
// Screen hooks:
export { useKeyboardFlip, keyboardColumnHeight, type FlipList, type KeyboardFlipOptions } from "./useKeyboardFlip";
export { useComposerFocusGap, COMPOSER_FOCUSED_ATTR } from "./useComposerFocusGap";
export { useScrollRoom, TOP_ROOM_IDLE_MS } from "./useScrollRoom";
export { useKeyboardDrag } from "./useKeyboardDrag";
export { useKeyboardForwardPlay } from "./useKeyboardForwardPlay";
export { useTapToDismiss, isDismissTap, NO_DISMISS_SELECTOR } from "./useTapToDismiss";
// Interactive dismiss internals (stand-in, samples, correction):
export * from "./keyboardDragDock";
// Diagnostics: recorder + score (trace format v1).
export {
  initKbDragRecorder,
  setRecorderOn,
  recorderOn,
  recordedDrags,
  clearRecordedDrags,
  subscribeRecorder,
} from "../../lib/kbDragRecorder";
export { scoreTrace, gapSeries, isTrace, type KbTrace, type KbScore, type KbEvent } from "../../lib/kbDragScore";
