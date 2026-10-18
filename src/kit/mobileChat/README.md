# Mobile chat kit

Keyboard + composer behaviour for chat screens in a WKWebView (Tauri iOS):
the composer rides the iOS keyboard on the compositor, the interactive
(iMessage) dismiss carries it by native scrolling, taps on the list close
the keyboard, and a recorder + replay harness measures how well it keeps up.

Full write-up (the problems, every technique and why, dead ends, native
shim, constants, validation): [docs/mobile-chat-kit.md](../../../docs/mobile-chat-kit.md).

```ts
import {
  useViewport, useViewportTrackRef, useViewportPadRef, keyboardColumnHeight, fullViewportHeight,
  useKeyboardFlip, useKeyboardForwardPlay, useComposerFocusGap, useScrollRoom,
  useKeyboardDrag, useTapToDismiss,
} from "src/kit/mobileChat";
```

Files: `useKeyboardFlip.ts` (show/hide FLIP), `useKeyboardForwardPlay.ts`
(hold layout, play, commit once — terminals), `useComposerFocusGap.ts`
(8px ↔ safe-bottom gap + blur on own hide), `useScrollRoom.ts` (top scroll
room), `useKeyboardDrag.ts` + `keyboardDragDock.ts` (interactive dismiss),
`useTapToDismiss.ts`. The viewport store, recorder and score live in
`src/lib/` (`useViewportHeight.ts`, `kbDragRecorder.ts`, `kbDragScore.ts`)
and are re-exported from `index.ts`. CSS: the `.mchat-*` block in
`src/styles/index.css`. Native shim: `src-tauri/src/lib.rs` (`ios_keyboard`).
