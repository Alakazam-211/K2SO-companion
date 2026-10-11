# iOS WKWebView Keyboard Layout — What We Learned

## The Problem

Standard chat layout: fixed header + scrollable content + fixed input bar.
On iOS WKWebView (Tauri mobile), when the keyboard opens, the header scrolls off screen and/or two scrollable layers fight each other.

## Root Cause

iOS WKWebView has a **native UIScrollView** wrapping the web content. When the keyboard opens:
1. iOS doesn't shrink the layout viewport
2. Instead, it scrolls the native UIScrollView to reveal the focused input
3. This creates TWO scrollable layers: the native UIScrollView and any CSS overflow:auto containers
4. `position: fixed` and `position: sticky` behave relative to the layout viewport, not the visual viewport
5. CSS/JS cannot control the native UIScrollView

## What We Tried (and Why It Failed)

### CSS-only approaches
- `position: fixed` on header/input → iOS still scrolls the native layer behind it, creating blank space
- `position: sticky` → doesn't work inside `overflow: hidden` containers; in `overflow: auto` containers, sticks to the scroll container not the viewport
- `height: 100dvh` / `interactive-widget=resizes-content` → not supported in WKWebView
- `body { position: fixed }` → locks everything but content still overflows

### JavaScript approaches
- `window.visualViewport` tracking → unreliable in WKWebView, height/offset values are inconsistent
- Setting `--app-height` CSS variable from `visualViewport.height` → shrinks content but page behind it stays full height, creating two scroll areas
- `window.scrollTo(0, 0)` on viewport scroll → prevents terminal content from scrolling too
- Blocking `touchmove` on non-scrollable elements → fragile, doesn't prevent all scroll scenarios

### Native approaches
- `tauri-plugin-ios-keyboard` → provides keyboard height events but doesn't resize the webview
- `tauri-plugin-webview-scroll` → repo no longer exists
- **`scrollView.isScrollEnabled = false`** (via objc2 msg_send) → **PARTIALLY WORKS**
  - Successfully disables the native scroll layer
  - Header/input bar no longer fight with native scroll
  - But: when keyboard opens, the page content is still full-height, so sticky elements stick to the full-height page edges, not the visible window edges

## What Works

### Native scroll disable (in lib.rs)
```rust
// Disables WKWebView's native scroll view
unsafe {
    let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
    let _: () = msg_send![scroll_view, setScrollEnabled: false];
    let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2i64]; // .never
    let _: () = msg_send![scroll_view, setBounces: false];
}
```
This eliminates the two-scroll-layer problem. Essential prerequisite.

### Keyboard height events (tauri-plugin-ios-keyboard)
```typescript
listen("plugin:keyboard::ios-keyboard-event", (event) => {
    const { eventType, keyboardHeight } = event.payload;
    // Use keyboardHeight to resize layout
});
```
Provides accurate keyboard height from native UIKit notifications.

## Remaining Challenge

Even with native scroll disabled, when the keyboard opens:
- The layout viewport stays at full screen height
- `position: sticky` sticks relative to the scroll container's full content height
- The visible area is smaller but the content area hasn't changed

## Resume With the Keyboard Up (IMG_0844)

Symptom: rarely, after re-opening the app onto the Zen thread, the whole
page sits shifted up. The header is gone, the last bubble is under the
status bar, and a black gap separates the composer from the keyboard.

Cause: the composer was still focused when the app went to the
background. On resume iOS re-shows the keyboard, and WebKit pans the web
content up to "reveal" the input. The scroll view's `contentOffset`
moves even with `scrollEnabled = false`, so `visualViewport.offsetTop`
ends up at roughly the keyboard height. The fixed, top:0 column is
positioned against the layout viewport, so it slides up by that amount.
Nothing re-pinned it, because:
- no `focusin` fires (focus never left the input);
- the pan is a `visualViewport` **scroll**, not a `resize`;
- nothing listened for `visibilitychange`, `pageshow` or window `focus`.

The column height was still right (the visible height), which is why
the gap equals the pan.

Fix, at two layers:
- **Web (`src/lib/useViewportHeight.ts`).** One shared store with
  `useViewport()` returning `{ height, offsetTop }`, and
  `useViewportHeight()` returning the height. It re-measures, coalesced
  to one animation frame, on:
  - `visualViewport` `resize` **and** `scroll`;
  - window `resize`, `focus` and `pageshow`;
  - `visibilitychange` back to visible (plus re-measures at 100, 300 and
    600 ms while the keyboard animates in);
  - `focusin` / `focusout`;
  - the native `k2-viewport-resize` / `k2-viewport-resync` events.

  Each measure runs `scrollTo(0,0)`, zeroes `document.scrollingElement`,
  and re-reads the keyboard-closed height
  (`max(innerHeight, documentElement.clientHeight)`) instead of trusting
  a mount-time capture. Any `offsetTop` that iOS will not give back is
  returned, and the fixed homes (`ThreadHome` in `Zen.tsx`, the
  `ChatsList` backdrop) set `top` to it so they track the visible area.
- **Native (`src-tauri/src/lib.rs`).** A `K2ViewportObserver` listens
  for `UIKeyboardDidShow`, `UIKeyboardDidHide` and
  `UIApplicationDidBecomeActive`.
  - On hide and on become-active, it forces `scrollView.contentOffset`
    back to zero and re-asserts `contentInsetAdjustmentBehavior = .never`.
  - On all three, it calls the injected `window.__k2ViewportPing()`,
    which re-sends `k2-viewport-resize` with the current height and fires
    `k2-viewport-resync`.
  - With the keyboard **up**, native only pings. The web hook resets the
    pan, because screens without the hook may rely on WebKit's reveal
    scroll.

## Key References

- Tauri Discussion #9368: https://github.com/tauri-apps/tauri/discussions/9368
- Tauri Issue #9907: https://github.com/tauri-apps/tauri/issues/9907
- Tauri Issue #10631: https://github.com/tauri-apps/tauri/issues/10631
- tauri-plugin-ios-keyboard: https://crates.io/crates/tauri-plugin-ios-keyboard

## Architecture

- `src-tauri/src/lib.rs` — native scroll disable via objc2; keyboard / app-active observers (resume re-sync)
- `src/lib/useViewportHeight.ts` — shared viewport store (`useViewport` / `useViewportHeight`)
- `src/main.tsx` — keyboard event listener
- `index.html` — viewport meta tag with `interactive-widget=resizes-content` (no effect in WKWebView but harmless)
- `src/styles/index.css` — `.input-bar` class with safe area handling
