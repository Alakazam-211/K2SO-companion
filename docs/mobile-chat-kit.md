# Mobile chat kit — making a WKWebView chat feel native

What we did to make K2 Companion's chat screens (Tauri 2 iOS, React, one
WKWebView) feel like iMessage around the keyboard, why each piece works,
and what did not. Written for another Tauri / WKWebView team; the code is
in `src/kit/mobileChat/` (hooks), `src/lib/useViewportHeight.ts`
(viewport store), `src-tauri/src/lib.rs` (`mod ios_keyboard`, the native
shim) and the `.mchat-*` block in `src/styles/index.css`.

Contents: [Problems](#the-problems) · [Techniques](#techniques) ·
[Dead ends](#dead-ends) · [Native shim](#native-shim) · [JS API](#js-api) ·
[Constants](#timing-constants-and-curves) · [Message motion](#message-motion) ·
[Chat cache](#chat-cache-return-hold-deltas) · [Recorder](#recorder-and-replay-harness) ·
[Device checklist](#device-validation-checklist) · [Known gaps](#known-gaps)

---

## The problems

1. **WKWebView does not resize the layout viewport for the keyboard.** The
   page stays full height; the keyboard covers its bottom. A composer
   pinned to `bottom: 0` sits under the keyboard. WebKit instead *pans*
   the page to reveal a focused field — and with the native scroll view
   disabled (we do, to stop rubber-banding the whole app) that pan shows
   up as `visualViewport.offsetTop`, dragging fixed headers under the
   notch.
2. **The keyboard animates in the UI process; the page learns late.**
   `visualViewport` updates arrive in one or two steps, after the
   keyboard has started moving. A column sized from it steps instead of
   gliding.
3. **IPC latency and jitter.** Anything the native side tells the page
   per frame (`evaluateJavaScript`) lands 1–4 frames later, and not
   evenly. A per-frame follower trails and stutters.
4. **Layout per frame is expensive.** Animating a chat column's `height`
   re-lays out the whole message list every frame — visible stutter,
   especially on short animations.
5. **Interactive dismiss (iMessage drag-down).** UIKit moves the keyboard
   with the finger and posts *no* notifications while it does; the
   composer is web content and must follow exactly.
6. **The focus gap.** At rest the composer clears the home indicator
   (~34px); over the keyboard it should sit 8px above it. Switching
   padding on `:focus-within` makes the composer jump 26px, and a list
   padded by the composer's height jumps with it.
7. **Pop-in.** Messages that arrive, are sent, or fold away (a "working"
   drawer) should move as one continuous motion, not snap.

## Techniques

### 1. The viewport as a store, sized from native keyboard events

`useViewportHeight.ts` keeps one shared store: `{height, offsetTop,
motion, interactive}`. A screen sizes a `position: fixed` column to
`height` (`keyboardColumnHeight()` — see FLIP below). Every re-measure
resets the page pan (`scrollTo(0,0)`), so fixed headers never slide.

The native shell observes `UIKeyboardWill{Show,Hide,ChangeFrame}` and
posts `window.__k2KeyboardWill({height, duration, curve, show, at,
fromTop, scrollY})`. The store jumps straight to the height the keyboard
is heading for and publishes `motion = {ms, easing, elapsed, from, to}`
with the keyboard's **own** duration and curve (curve 7 ≈
`cubic-bezier(0.38, 0.7, 0.125, 1)`), and `elapsed` = how late the page
heard about it (the bridge hop). Until the keyboard lands it ignores
`visualViewport` noise (it would fight the animation), then re-measures.
*Why it works:* the page knows the destination and the timing at the
start of the animation instead of chasing it.

### 2. FLIP on the compositor (`useKeyboardFlip`)

No `height` transition anywhere. Per motion:

- **hide** — the column takes its final (taller) height at once. If the
  reader was at the newest message, the list re-sticks. Then the docked
  composer (and its blur) and, if that commit moved the list, the list's
  children are translated back to where they were drawn, a style flush,
  and they play to 0 on the keyboard's duration + curve, with
  `transition-delay: -elapsed` so they start mid-curve, in step with the
  keyboard. The region the keyboard uncovers was already laid out.
- **show** — the column is **held** at its old height (nothing is clipped
  while the keyboard rises); the composer (and the list, if at the newest)
  play up to where the new layout will put them. When the motion clears,
  the column takes its height and the transforms go in the same commit —
  the same picture, one layout.
- After an interactive drag, the finger owns the scroll: only the composer
  plays; the list is never moved or re-stuck (momentum stands).
- Reduced motion: final layout, no transforms.

*Why it works:* transforms are composited; the only layouts are one at the
start (hide) or the end (show).

**Forward play** (`useKeyboardForwardPlay`) is the variant for content that
must not re-lay out mid-motion — our terminal grid re-fits its rows on any
size change. Show holds the column; hide pins the grid's box at its old
height; the composer plays by transform; the pin and transform go in one
commit when the motion clears, so the grid re-fits **once**.

### 3. The focus gap (`useComposerFocusGap` + `.mchat-*` CSS)

The screen root (`.mchat-pane`) gets `data-composer-focused` **in the
focus event itself**, so it flips in the same style pass as the bar's
`:focus-within`. CSS derives `--mchat-composer-gap` (8px vs
`max(8px, var(--safe-bottom))`) and uses it for both the bar's bottom
padding (`.mchat-bar`) and a spacer ending the scroller (`.mchat-gap`),
both transitioning on the keyboard's timing (`--k2-kb-ms` /
`--k2-kb-ease`, set by the store from the shell). The composer's measured
height excludes that padding (`composerBlockHeight`), so nothing
re-measures per frame. **Blur on own hide:** an interactive dismiss or
backgrounding can hide the keyboard while WebKit keeps the field focused
(8px gap stays, a tap no longer raises the keyboard) — on a Will*Hide we
blur the field, as UIKit resigns the first responder. Android: no
transitions (no keyboard timing from the shell).

### 4. Interactive dismiss — attach to scroll (`useKeyboardDrag`, `keyboardDragDock.ts`)

- Native sets `keyboardDismissMode = .interactive` on every child
  `UIScrollView` WebKit creates for `overflow: auto` elements (not the
  disabled top-level one), and `keyboardDismissPadding` (iOS 17+) = the
  composer's height (`ios_keyboard_dismiss_padding`), so the drag starts
  at the composer's top like iMessage.
- **The insight:** while the finger drags the list into the keyboard, the
  list scrolls natively in the UI process, the same frame as the keyboard,
  1:1 with the finger. So at the moment the keyboard starts to follow the
  finger we put an **inert copy of the composer dock into the scrolled
  content**, at its exact on-screen spot, and make the real dock opacity 0
  (its textarea keeps focus — re-parenting a focused element would blur it
  and drop the keyboard). Native scrolling then carries the copy in
  lockstep. No per-frame JS.
- **Switch moment:** a passive `touchmove` crossing the keyboard top minus
  the dismiss padding; fallback: the shell's first keyboard sample.
  Finger back above the line → hand back; let go with no Will* → hand back
  after 300ms.
- **Drag start (one layout):** the column goes full height and a pad at
  the end of the scroller grows by the keyboard's height, so the scroll
  range — and so what is on screen — does not change and the copy is not
  clipped.
- **Scroll room** (`useScrollRoom`): while the keyboard is up the list
  keeps keyboard height + 48px of real scroll range above the view,
  scrollTop compensated, so the drag is a true 1:1 scroll, never a top
  rubber band. Removed once scrolling is idle (a programmatic scroll would
  stop momentum).
- **Short lists** (`CHAT_CONTENT_CLASS`, `.mchat-content`): the list's
  content block ALWAYS has `min-height: calc(100% − gap − drag pad)`,
  easing with the gap spacer. A short list fills the view exactly (no
  phantom scroll range), the room is reachable above it, and the room
  coming and going never moves it. A chat list adds
  `justify-content: flex-end` so a short conversation sits at the bottom,
  right above the composer, keyboard up or down (iMessage), and tells the
  FLIP it is `bottomAnchored` (the newest then rides the composer on
  show / hide even when nothing scrolls). A document-like list (a ticket:
  brief and answers lead) stays top-aligned. Dead end: a `min-height`
  that came and went with the room — a short chat dropped back to its
  natural top-aligned layout ~200ms after the keyboard closed (the snap
  up).
- **Exact placement — one eased correction:** the shell samples the
  keyboard only during the drag (see native), each sample carrying the
  keyboard top **and the panning scroll view's `contentOffset.y` from the
  same native frame**. JS knows the copy's content-space bottom, so
  `diff = sample.top − (copyBottomContent − sample.scrollY)` is exact,
  independent of when the page last saw the scroll. The copy eases to it
  by a transform transition (80–220ms by size, ease-out, either sign); one
  confirmation ~100ms later eases a second correction only if off by >2px.
- **Release hand-off:** on Will*Hide / Will*Show the copy's on-screen
  bottom (its content bottom at the Will's own `scrollY`) is where the
  real composer starts: the column goes final (hide) or is held (spring
  back), and the real dock is translated onto the copy **before** it is
  un-hidden, in the same style commit. Then the FLIP plays it on.
- Mid-drag the list's `onScroll` sets no React state.

### 5. Tap to dismiss (`useTapToDismiss`, option `dismissOnTap`, default on)

A plain tap (pointerup within 10px of pointerdown, ≤350ms, not cancelled —
WebKit cancels pointers when a scroll pan starts) on non-interactive
content in the list blurs the composer; the Will*Hide FLIP animates the
rest. Never on `a, button, input, textarea, select, label, summary,
video, audio, [role=button|menuitem|link|checkbox|switch|tab],
[contenteditable], [data-no-dismiss]`; never with a text selection; never
while a composer menu is open (`aria-expanded="true"` inside the
composer — the outside tap closes the menu only); never when the screen
vetoes (`canDismiss`: our terminal in direct-typing mode, where a tap
means "type here").

## Dead ends

- **Animating the column's `height`** (66a2958): smooth on paper, but a
  layout of the whole list per frame; stuttered on device, worst on the
  short release animation. Replaced by FLIP.
- **Per-frame JS tracking of the keyboard during the drag**
  (3f27691): a CADisplayLink posted the keyboard top every frame and the
  page resized the column. With **one evaluateJavaScript in flight**
  (waiting for completion + 150ms timeout) updates came at a fraction of
  the display rate — "refreshing slowly". **Without gating** (b85d8e6,
  transform-only, latest value per rAF) it was smoother but still trailed
  and jittered: native read → IPC → web rAF → commit back is 2–4 frames,
  unevenly.
- **Prediction** (extrapolating the keyboard): shrinks average lag, not
  jitter. Not built.
- **Snapshot stand-in** (native `resizableSnapshotView` pinned to the
  keyboard layout guide): perfect sync in theory, but the blur freezes in
  the image and the swap can flicker; 2–4 days. Superseded by
  **attach-to-scroll**, which gets perfect sync from the list's own native
  scrolling for free.
- **Re-parenting the real composer into the list:** blurs the focused
  field → keyboard drops. Use an inert copy.
- **iOS's begin frame at release** (TestFlight 1320): after an interactive
  dismiss iOS can report the keyboard's *resting* frame as the Will's
  begin frame; starting the release from it snapped the composer up, then
  down. Start from where the copy is drawn.
- **Timestamp precision:** the bridge-hop compensation used `Date.now()`
  (whole ms) against native whole-ms; ~1px behind early in the curve.
  Now native sends fractional ms and the page uses
  `performance.timeOrigin + performance.now()`.
- **A one-time correction from page-side rects:** both the copy's rect and
  scrollTop come from the same (possibly late) page snapshot, so they
  cannot see the UI-process drift. The fix is the native `scrollY` in the
  same frame as the keyboard sample.

## Native shim

`src-tauri/src/lib.rs`, `mod ios_keyboard` (objc2; iOS only):

| Surface | Direction | What |
|---|---|---|
| `UIKeyboardWill{Show,ChangeFrame,Hide}` → `window.__k2KeyboardWill({height, duration, curve, show, at, fromTop, scrollY})` | native → page | overlap of the web view, duration (ms), UIViewAnimationCurve, wall-clock ms (fractional), begin-frame top, panning list's contentOffset.y |
| `UIKeyboardDid{Show,Hide}`, app active → `window.__k2ViewportPing()` | native → page | re-measure + reset pan |
| `window.__k2KeyboardSample({top, scrollY, t})` | native → page | during a dismiss drag only: first 4 moving frames + one ~100ms later |
| `window.__k2KeyboardRec({top, scrollY, t})` | native → page | recorder on + drag sampled: every frame, through the release animation |
| `ios_keyboard_dismiss_padding(px) -> bool` | page → native | `keyboardDismissPadding` on every child scroll view (iOS 17+); false if unsupported |
| `ios_keyboard_recorder(on)` | page → native | recorder per-frame frames on/off |
| `ios_strip_accessory_bar` | page → native | no form accessory bar |

**Idle by default:** no display link while the keyboard sits there. Every
child scroll view's `panGestureRecognizer` gets a target; a pan that
*begins* with the keyboard up starts the sampler (`kb_sampler`, pure,
host-tested), which posts only once the keyboard leaves its rest, and
stops when the pan has ended and the keyboard has been still 8 frames, on
any Will*, or DidHide. Keyboard top: `UIKeyboardLayoutGuide` first;
if it sits still while the keyboard's host view moves, the host view's
public frame (found by class name `UIInputSetHostView`, read-only).

## JS API

```ts
import {
  useViewport, useViewportTrackRef, useViewportPadRef, keyboardColumnHeight, fullViewportHeight,
  useKeyboardFlip, useKeyboardForwardPlay, useComposerFocusGap, useScrollRoom,
  useKeyboardDrag, useTapToDismiss, COMPOSER_FOCUSED_ATTR,
} from "src/kit/mobileChat";
```

A chat screen (see `ThreadPane.tsx`, `TicketView.tsx` for full wiring):

```tsx
const vp = useViewport();                       // {height, offsetTop, motion, interactive}
const columnRef = useViewportTrackRef();        // the fixed column (drag sizes it)
<div ref={columnRef} style={{ height: keyboardColumnHeight(vp, fullViewportHeight()) }}>
  <div className="mchat-pane" ref={root}>
    <div ref={scroller} style={{ overflowY: "auto" }}>
      <div ref={room} />                         {/* useScrollRoom */}
      <div ref={layer} style={{ position: "relative", height: 0, zIndex: 3 }} /> {/* drag layer */}
      <div ref={content} className="mchat-content" /* + justify-end for a chat */>…messages…</div>
      <div className="mchat-gap" />              {/* focus gap spacer */}
      <div ref={useViewportPadRef()} />          {/* drag pad */}
    </div>
    <div ref={dock} style={{ position: "absolute", bottom: 0 }}>…blur + composer (.mchat-bar)…</div>
  </div>
</div>

useKeyboardFlip({ viewportHeight: vp.height, motion: vp.motion, interactive: vp.interactive,
  scroller, docks: () => [dock.current], list: { isFollowing, lastScrollTop, stick, held } });
useScrollRoom({ viewportHeight: vp.height, scroller, room, content, lastScrollAt, onScrollWrite });
useKeyboardDrag({ scroller, dock, layer, composerPx });     // composer height above the keyboard
useComposerFocusGap({ root, bar, onChange });
useTapToDismiss({ area: scroller, composer: bar /*, dismissOnTap, canDismiss */ });
```

The list contract: `isFollowing()` (at the newest), `lastScrollTop()`
(scrollTop before this commit, from onScroll / own writes), `stick()`
(re-stick if following), `held()` (an anchor is being restored),
`bottomAnchored` (content pushed to the bottom — a chat). Pause
your own "stick to newest" while `vp.interactive`.

## Timing constants and curves

| Constant | Value | Where / why |
|---|---|---|
| keyboard curve 7 | `cubic-bezier(0.38, 0.7, 0.125, 1)` | `KEYBOARD_EASING`; UIKit's private keyboard curve as commonly approximated |
| keyboard duration | from the Will* (default 250ms) | used as reported, even when very short |
| bridge hop | `transition-delay: -elapsed` | elapsed = page now − native `at` (sub-ms) |
| settle | duration − elapsed + 60ms | `SETTLE_SLOP_MS`: then re-measure / commit |
| slop for "keyboard up" | 100px | `KEYBOARD_SLOP`: hardware-keyboard bar is not a keyboard |
| scroll room | keyboard + 48px | `TOP_ROOM_MARGIN`; dropped after 200ms idle |
| correction ease | 80 + 7·\|d\| ms, clamp 80–220, `cubic-bezier(0.2,0.8,0.2,1)` | `correctionMs`, `CORRECTION_EASE` |
| confirmation | ≥90ms after, if off by >2px | `CONFIRM_AFTER_MS`, `CONFIRM_TOLERANCE_PX` |
| sanity bound | \|diff\| ≤ 48px | `MAX_CORRECTION_PX` (a wrong scroll view's offset) |
| return / grace | finger 4px above line; 300ms no-Will grace | `RETURN_SLOP_PX`, `RELEASE_GRACE_MS` |
| native sampler | 4 early + 1 at 100ms; stop after 8 still frames | `kb_sampler` (lib.rs) |
| tap | ≤10px, ≤350ms | `TAP_SLOP_PX`, `TAP_MAX_MS` |
| focus gap | 8px ↔ `max(8px, safe-bottom)` on `--k2-kb-ms/ease` | `.mchat-*` CSS |

## Message motion

All compositor-only (transform / opacity), K2 code in `src/zen/`:

- **Send fly** (`sendFly.ts`): FLIP of a clone from the composer into the
  bubble's final slot; 480ms critically damped spring, blue in by 25%;
  the list glides to make room on the same curve; a multi-line draft's
  field eases shut on it (`smoothClear`), and the list pads for the
  field's *end* height (`settledHeight`) so the bubble aims at its final
  slot.
- **Deliver brighten** (`useDeliverBrighten.ts`): the dim "Sending…"
  bubble (0.7 ↔ 0.8 breathe) brightens to 1 over 700ms from the frame on
  screen.
- **Incoming glide** (`listGlide.ts`): while following, new agent rows
  keep the old content in place and the list glides up by their height
  (320ms spring) as each row fades in and rises 8px (260ms, 40ms stagger,
  ≤160ms, newest 6). One controller owns the list transform; a second
  change mid-glide folds into the running curve.
- **One-motion turn end** (`ThreadWorkingStrip.tsx`, `listGlide.ts`): the
  scroller's bottom padding no longer eases; the drawer's cover change
  sticks at once and glides the difference; folding with no reply yet
  holds up to 300ms so the reply's glide takes both.

## Chat cache, return hold, deltas

Brief; see the files:

- **Stale-while-revalidate cache** (`chatCache.ts`,
  `chatCacheBackend.ts`): memory LRU (40 chats, sync on open) + IndexedDB
  (newest messages per chat, capped by chats and bytes), written behind;
  keyed per server + room.
- **Merges** (`threadCacheMerge.ts`): server wins for what it carries;
  inside the page's window a missing cached message is dropped; own
  optimistic rows always stay; unchanged objects keep identity (no
  re-render).
- **Return hold** (`returnHold.ts`): a chat whose cache is known to be
  behind (unread `lastSeq` / list latest) holds its first paint up to
  300ms for the delta read (`thread-delta-v1`); in time → the merged copy
  paints at once; late → the cache paints and arrivals glide in.

## Recorder and replay harness

- **On device:** Server settings → Diagnostics → **Keyboard drag
  recorder** (or `__k2KbRecorder.on()` in the console). Off costs one
  localStorage read; native behaves exactly as without it. Each drag
  (attach → release → settled, ≤5s) records native frames (keyboard top +
  list offset + wall clock), page frames (composer bottom, scrollTop) and
  attach / correct / lift / release / Will / touch events, then scores it:
  frames, max / p95 |gap| (composer bottom − keyboard top), % ≤1px,
  correction start / duration, steady-phase off-frames, dropped frames,
  gap at the lift, hand-off window max, landing error, release-tail max
  gap + dropped, early attach. The Diagnostics row shows the last 6 with a
  gap sparkline, **Copy trace JSON** and Clear. Clock residual: per trace
  `clockErrMs` (wall-clock slew since page load + 0.5ms); native reads at
  frame start, a constant part-frame bias.
- **Replay** (`src/test/kbReplay.ts`, `kbReplay.test.ts`): feeds a trace's
  native timeline through the real JS logic under fake timers (page scroll
  1 frame late, samples 1 IPC frame late, the native sampler's rules) and
  scores the modelled composer. Thresholds: steady max ≤1px, correction
  ≤220ms starting within 3 frames, lift gap ≤1px, landing ≤1px, release
  tail ≤1px, no attach before the keyboard moved.
- **Synthetic traces** in `src/test/kbTraces/` (slow drag, fast flick,
  reverse mid-drag, spring back, release mid-drag with momentum + iOS's
  resting begin frame), from `src/test/kbSynth.ts`; regenerate with
  `npx vite-node scripts/gen-kb-traces.ts`.
- **Adding a real trace:** Diagnostics → Copy trace JSON → save as
  `src/test/kbTraces/<name>.json`. The suite picks it up.

## Device validation checklist

- Tap a composer: it rises with the keyboard, no step; the newest message
  rides above it. Tap the list: keyboard closes, composer glides down.
- Tap a link / button / file chip / choice card / code copy: it acts, the
  keyboard stays. Long-press select text: keyboard stays.
- Drag the list down into the keyboard slowly, fast, reverse mid-way,
  release mid-way, spring back: the composer stays on the keyboard; no
  snap up at release; momentum continues.
- Short chat (a few messages): the drag is still a 1:1 scroll (no top
  rubber band); scrolling to the top while typing shows only the scroll
  room, gone after the keyboard closes.
- Attach menu open: an outside tap closes it, keyboard stays.
- Background the app with the keyboard up, come back: no gap, header in
  place.
- Terminal: composer rises / falls smoothly, the grid re-fits once at the
  end; tap the output in safe send closes the keyboard; in direct typing a
  tap types.
- Tickets: same as the chat. Chats list search: bar rides the keyboard.
- Reduced motion: final layout, no animation, still correct.
- Run the recorder for a few drags; copy one trace into the replay suite.

## Known gaps

- **Hard flick hand-off:** between the lift and the page hearing the
  Will*, the copy coasts with the list's momentum while the keyboard
  starts its own animation: ~1 frame, ~12px on a fast flick
  (`handoffMaxGap`; no threshold yet).
- **iPad floating / undocked keyboard:** treated as covering nothing
  (`followsUndockedKeyboard = false`); not tuned.
- **Android:** none of the native keyboard events exist; the
  visualViewport path is used, no FLIP timing, no interactive dismiss.
- **Terminal:** scrolls in JS, not a native child scroll view, so no
  interactive dismiss there.
- **Curve 7 fidelity:** synthetic traces model the keyboard on our own
  bezier; only real traces show any mismatch with iOS's curve.
- Sheets inside the chats column (Add agent…) are not FLIP-wired: on
  keyboard show they take their final layout when the motion ends.
