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
[Rendering performance](#rendering-performance) ·
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
blur the field, as UIKit resigns the first responder. Never while the app
is leaving the screen (the shell sends `active:false` on that Will* and
skips its own `endEditing`): a focus change in the background can hang
UIKit's keyboard queue until the watchdog kills the app (0x8BADF00D,
TestFlight 202610181404). That blur waits until the app is back, unless
iOS brings the keyboard back first. Android: no
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
  easing with the gap spacer, so a short list fills the view exactly (no
  phantom scroll range) and the room above it is reachable. A short list
  rests TOP-aligned with the keyboard down, and every move into or out of
  that rest is animated:
  - **hide** (not a drag release): the FLIP drops the scroll room in the
    same commit (`FlipList.beforeHide` → `useScrollRoom().dropNow`),
    measures how far the content itself moved (its offset in the scroller
    minus scroll, before vs after: re-stick, clamp, room) and plays that as
    one glide on the keyboard's curve — from where the newest sat above the
    composer to the top-aligned rest;
  - **show**: the content stays at the top if it still fits the smaller
    view; if not, it rises only by its overflow (`finalScrollTop` predicts
    the re-stick), during the keyboard's rise;
  - **after a drag release** the room waits for scroll idle (momentum); if
    dropping it must move visible content (the reader scrolled into the
    room), the move plays over 250ms instead of snapping.
  Dead ends: a `min-height` that came and went with the room (the short
  chat dropped to its natural layout ~200ms after the keyboard closed — a
  snap); always pushing a short chat to the bottom (iMessage-like, but
  Rosson prefers few messages to rest at the top).
  A list may still opt into `bottomAnchored` (flex-end) — it then rides
  the composer on show / hide.

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
| `UIApplicationWillResignActive` (keyboard up) → `_incrementFocusPreservationCount`; DidBecomeActive + 1 s → `_decrementFocusPreservationCount` | native only | keep WebKit's focus while the app is away (see below) |

**Idle by default:** no display link while the keyboard sits there. Every
child scroll view's `panGestureRecognizer` gets a target; a pan that
*begins* with the keyboard up starts the sampler (`kb_sampler`, pure,
host-tested), which posts only once the keyboard leaves its rest, and
stops when the pan has ended and the keyboard has been still 8 frames, on
any Will*, or DidHide. Keyboard top: `UIKeyboardLayoutGuide` first;
if it sits still while the keyboard's host view moves, the host view's
public frame (found by class name `UIInputSetHostView`, read-only).

### Returning with the keyboard up

A native app comes back with its keyboard already up: the field stays first
responder and UIKit restores the keyboard from a snapshot. WKWebView
unfocuses the page when the app goes to the background
(`PageClientImpl::isViewFocused` is false while `_isBackground`): the DOM
gets `blur` (not `focusout`), the input session ends and the keyboard hides.
On return WebKit refocuses and calls `_showKeyboard`, a fresh, animated
presentation (`_restoreFocusWithToken:` returns NO, WebKit bug 196740). No
page-side layout hold can hide that.

The fix is WebKit's own focus hold. On `UIApplicationWillResignActive`, with
the keyboard up, the shim calls `[webView _incrementFocusPreservationCount]`.
That is the counter `_isRetainingActiveFocusedState` reads, so
`isViewFocused` stays true: no blur, no refocus, and UIKit's restore applies.
It calls `_decrementFocusPreservationCount` 1 s after `DidBecomeActive`, but
not if the app went inactive again.

- A blur while the hold is on resets the count inside WebKit, and WebKit
  documents the decrement as harmless after a reset.
- Both calls are WKWebView SPI, behind `respondsToSelector:`. Without them
  the app keeps the animation.
- No focus changes while the app is in the background, which also matters
  for the watchdog hang below.
- Verified on device, 4.1.0 build 202610211936.
- The page also holds the keyboard's height while away
  (`keyboardHeldNow()`, `RETURN_HOLD_MS`), so the layout doesn't move
  either.

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
      <div ref={content} className="mchat-content">…messages…</div>
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
`content()` (the .mchat-content block, to measure / predict short
lists), `beforeHide()` (drop the scroll room in the hide's commit:
`useScrollRoom` returns `{dropNow}`), `bottomAnchored` (optional). Pause
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

- **Send fly** (`sendFly.ts`), matched frame by frame to a 30 fps screen
  recording of iMessage (tap → settled ≈ 0.42 s, 13 frames):
  - *Frame 1*: the whole composer field pill (`data-composer-field`, its
    full width, radius and padding) is a faint blue bubble in place
    (opacity `FLY_BLUE_FROM` 0.25); in the same commit the real field is
    empty, one line, placeholder showing — no eased collapse (the DEV
    `collapse: true` override brings the old `smoothClear` ease back for
    an A/B).
  - *First quarter*: the blue is solid by `FLY_BLUE_AT` 0.25 (then the
    bubble's Sending… opacity); the shape shrinks in width toward the
    right edge while it starts rising; the field's text blurs
    (`FLY_TEXT_BLUR_PX` 1.5px) and crossfades to the bubble's line breaks
    by `FLY_TEXT_AT` 0.3.
  - *Glide*: 420ms (`FLY_MS`) on `spring(0.85)` (`FLY_EASING`): ~0.6%
    overshoot, i.e. a ~2px settle on a 300px flight, peaking past the
    middle; the list glides on the same keyframes.
  - Two layers. The **shape** is a box anchored at the bubble's
    bottom-right corner: position = compositor `translate3d`, size and
    corner radius = `clip-path: inset(… round r)` (a non-uniform scale
    would squash the pill ends; old WebKit without animatable clip-path
    falls back to that scale). The **text** is a transparent clone of the
    bubble on `translate3d + uniform scale` with the field's "ghost" text.
    The tail (if the bubble has one) rides the shape and grows in.
  - The list pads for the composer's new height before the bubble is
    aimed (the field snapped in the Send commit), so the newest stays
    pinned and nothing jumps.
  - DEV override (`localStorage["k2.debug.sendFly"]`, debug builds only):
    `{ ms, easing, blueAt, blueFrom, textAt, blurPx, collapse }`.
- **Deliver brighten** (`useDeliverBrighten.ts`): kept, subtler now that
  the receipt says it in words: the Sending… bubble rests at 0.85 and
  breathes 0.85 ↔ 0.95; on delivery it brightens to 1 over 500ms from the
  frame on screen.
- **Receipt** (`chatReceipt.ts`, `chatBubbles.css`): one "Delivered"
  (11px, muted, right-aligned) under the newest outgoing message the
  server has confirmed — never under a pending one (it breathes and says
  Sending…), never under one still flying in. A newer confirmed send takes
  it: the old label fades out (160ms) and the new fades in after a beat
  (120ms delay, 240ms, 3px drop, grows from the right edge) — ≈0.36s, like
  iMessage's ~0.3s. It is CSS generated content over the message's
  fixed-height status line (`data-receipt`), so it moves with **no layout
  change** (iMessage nudges its list ~3px because its label adds a line;
  ours never moves the list, so there is nothing to glide). "Read" (agent
  Threads only) once the agent replied after it, or its turn (activity
  frames) started at or after the message (2s slack) and got past
  `delivering`; no activity feature → stays Delivered. Project chats:
  always Delivered. Tickets: Delivered (POST ok or shown back), never
  Read. Failed sends keep "Not sent · Retry". Reduced motion: no
  transitions, the label still shows.
- **Runs and tails** (`chatReceipt.ts` `chatRuns`): consecutive messages
  from one sender ≤120s apart are a run. Only a run's last bubble has an
  iMessage tail (an SVG mask, `--k2-bubble` colour, outside the bubble's
  box — the bubble's content clips in an inner wrapper). Inside a run rows
  sit 4px apart with no meta line between (theirs: name • time on the
  first; mine: the status line on the last, or under any send still
  Sending… / Not sent); runs start 6px further down. A send joining my run
  takes the tail (and the previous row's status line) in the Send commit,
  inside the send glide; so a still-labelled previous message in the same
  run loses its "Delivered" at Send, and the new one gains it on
  confirmation.
- **Incoming glide** (`listGlide.ts`): while following, new agent rows
  keep the old content in place and the list glides up by their height
  (320ms spring) as each row fades in and rises 8px (260ms, 40ms stagger,
  ≤160ms, newest 6). One controller owns the list transform; a second
  change mid-glide folds into the running curve.
- **One-motion turn end** (`ThreadWorkingStrip.tsx`, `listGlide.ts`): the
  scroller's bottom padding no longer eases; the drawer's cover change
  sticks at once and glides the difference; folding with no reply yet
  holds up to 300ms so the reply's glide takes both.

## Rendering performance

**The symptom:** typing, the keyboard and live frames lagged in proportion
to the conversation's length. In a chat with a few hundred messages every
keystroke re-rendered the whole pane, and with it every message's
Markdown, and every message was in the DOM. Short chats felt fine, which
hid it. The fixes below made the Thread "buttery smooth" on device and are
applied to every chat surface: agent Threads, project chats and sidecars
(all one `ThreadPane`), the open ticket (`TicketView`), and the lists
behind them.

**Numbers** (jsdom, `ThreadPane.renderCost.test.tsx` /
`TicketView.renderCost.test.tsx`; device timings are larger, the ratios hold):

| | before | after |
|---|---|---|
| Thread, 500 messages, one keystroke | 179 ms | 0.8 ms |
| Thread, 500 messages, DOM | 500 rows / 9034 nodes | 30 rows / 578 nodes |
| Thread, 50 messages, one keystroke | 50 bubble renders + 50 Markdown parses, 27 ms | 0 / 0, 1.1 ms |
| Thread, 50 messages, 2 activity frames | 150 / 150, 52 ms | 0 / 0, 8.6 ms |
| Ticket, 300 comments, one keystroke | 300 bubble renders, 34.6 ms | 0, 0.9 ms |
| Ticket, 300 comments, 2 refetches | 600 bubble renders, 132 ms | 0, ~4 ms |
| Ticket, 300 comments, open | 300 rows / 5572 nodes, ~150 ms | 30 rows / 623 nodes, ~27 ms |

### Keystroke isolation

The draft lives in the composer, not the chat around it.
`ThreadDraftComposer` (`ThreadPane.tsx`, used by the Thread and the
ticket) owns the text in its own state. A keystroke re-renders only the
composer. The pane hears `onBlankChange` only when the field turns blank
or non-blank (the send button's colour, the failed row's "Edit"), and it
reads or writes the text on Send and Edit through an `apiRef`
(`get()` / `set()`). Per-room drafts (`composerDrafts.ts`) are written
behind a short quiet.

### Memoized rows and Markdown

- **Rows** (`ThreadRow` / `Bubble`, `TicketCommentRow`) are `React.memo`.
  They are compared by message content, not identity, because a re-read or
  a cache swap hands over new-but-equal objects (`sameRowProps`).
- **Callbacks** reach the rows stable: `useCallback` over a `handlers`
  ref that is updated on every render.
- **Markdown is parsed once per text.** `ChatMessageBody` is memoized and
  keeps its Markdown in `useMemo([text, onFileLink])`. The remark plugins
  are one hoisted array, because a new array rebuilds the processor. The
  body style is one cached object per text size (`bubbleBodyStyle()`), so
  the body itself skips.
- **The lists** take the same approach. `AgentRowContent` (the Agents and
  Home rows) is memoized, comparing `unread` by value and `preview` by
  element props. The row's line two is parsed once per message
  (`lastPreview` caches it per entry), and `RowSnippet` is memoized. The
  Tickets list cards are memoized on what they draw. The Tickets screen
  and the open ticket are memoized with stable callbacks, so the Agents
  list's own re-renders (activity polls, unread) skip them.
- **Store writes that change nothing don't replace objects.** For example,
  a project-chat read keeps `lastAtByKey` when the row's time did not
  move. Every subscriber of a replaced map re-renders, including lists
  hidden behind the chat.

### The render window (30 rows, both ends)

Every message stays in memory (store, cache), but only a window is in the
DOM. The logic is in `threadWindow.ts`, which has one knob:
`WINDOW_ROWS = 30`. ThreadPane runs the window inline;
`useRenderWindow.ts` is the same rules as a hook for the ticket's comments.

- **Pinned by key, not index.** Arrivals at the end and earlier pages at
  the start do not move the window. `lo: null` means from the first
  message in memory, and `hi: null` means through the newest, so arrivals
  draw at once.
- **Spacers.** Rows that leave are replaced by a spacer of their measured
  height (`measureRows`: the distance to the next row's start, margin and
  gap included). The spacer takes back the list's `gap` with a negative
  margin, so `scrollHeight` and the view never move. A row never measured
  counts 0 above (the window's top is then a real edge) and
  `WINDOW_EST_ROW_PX` below (out of view either way).
- **Anchoring.** Every window change captures the first drawn row on
  screen and its `offsetTop`. After the commit, `scrollTop` moves by the
  difference. The anchor is a layout offset, so a glide's `transform` does
  not count. `overflow-anchor: none` keeps the browser out of it.
- **Two ends.**
  - Following the newest: the newest 30 are drawn. Once scrolling has
    been quiet (`WINDOW_IDLE_MS`), the oldest drop off.
  - Scrolled away: within `WINDOW_RESPAWN_SCREENS` of a drawn edge, 30
    more come back on the next frame.
  - Rows more than `WINDOW_KEEP_SCREENS` past the view leave once quiet,
    but only `WINDOW_TRIM_MIN` or more at a time, to avoid churn.
  - A pending idle check is never re-armed by commits. A chat streaming
    frames would otherwise never trim.
- **Memory first.** "Load earlier" (and scrolling up) draws from memory
  above the window first. It fetches only when memory runs out.
- **Back to the newest.** Send, "New message ↓" (when the newest are not
  drawn) and an arrival while following all move the window to the newest
  and stick.
- **Focus targets.** A push-tap target outside the window is drawn with
  `WINDOW_FOCUS_ABOVE` / `WINDOW_FOCUS_BELOW` neighbours
  (`windowAround`).
- **Computed over everything.** Runs, tails, the receipt and arrival
  detection read every message in memory, so the window's edge draws
  exactly as before.
- **Busy means wait.** The window holds off during a send fly, a list
  glide, an interactive keyboard drag or a pending scroll restore.
- **A ticket is top-aligned.** It opens on the brief, so its window starts
  at the oldest comment and grows down as the reader goes. The brief and
  answer cards are outside the window and always drawn. Sends not yet shown
  back are always drawn.
- **The ticket's sizes** (`useRenderWindow.ts`, Rosson 2026-10-18):
  - It opens with `RENDER_WINDOW_OPEN_ROWS` (30) rows. Reading on draws
    `RENDER_WINDOW_STEP` (20) more at a time, up to
    `RENDER_WINDOW_MAX_ROWS` (50).
  - Past 50, each step drops as many rows at the far end (the end the
    reader is moving away from), with a measured spacer in their place.
    Reading back redraws them and drops rows from the other end.
  - Only the edge the reader is scrolling toward grows, because a window
    at the cap would otherwise see-saw between its edges.
  - A row still on screen never drops.
  - Leaving and coming back starts at 30 again.
- **Pages load themselves.** No list has a "Show more" or "Load more"
  button. The Sessions drawer's History loads its next page within 240px
  of the bottom:
  - single-flight;
  - never on the first paint;
  - a small spinner while loading, nothing at the end;
  - "Couldn't load more · Retry" if the page failed.

  The ticket's comments and the Tickets list are not paged: `show` and the
  list return everything, and the window keeps the DOM small.
- The Thread's first paint is also progressive: a chat that opens with
  more than 30 messages draws its newest 15 first and the rest on the next
  frame.

### Hidden-list freeze

The Chats list stays mounted, hidden, behind an open chat, and it was
subscribed to the viewport store. As a result, every step of a keyboard
show, hide or drag re-rendered the whole list.
`useViewportSettledWhile(hidden)` gives a hidden list the viewport only
once it has settled, and not at all if it settled where it was. In jsdom,
one keyboard show with a chat open went from 3 list renders to 0. Apply the
same rule to anything mounted but off screen: it should not subscribe to
per-frame state.

### No layout-property transitions

Do not ease `height`, `min-height`, `padding` or `margin` on the
scrolling column. Each frame becomes a whole-column layout, and anything
that re-sticks every frame adds a `scrollHeight` read and a `scrollTop`
write.

- The composer's bottom-gap spacer and the content's `min-height` take
  their new value at once.
- A following list re-sticks once and plays the difference as a
  `translate` (`easeGapShift`), with the keyboard's duration and curve.
- `translate` composes with the keyboard FLIP's and the glide's
  `transform`.
- Only the bar's own padding still eases, because it sits in the
  absolutely placed dock and causes no column layout.

### Blur budget

Live `backdrop-filter` is the most expensive thing on screen while the
list scrolls under it. The chat header and the composer footer each stack
four masked blur layers. Keep the count fixed, don't animate the blur
radius, and keep blurs off the rows themselves (glass tiles have no blur).
Diagnostics → **Light blur** (`k2.debug.lightBlur`, the `k2-light-blur`
class on `<html>`, off by default) drops each stack to two layers, about
4px with the long soft reach and about 16px for the dense band. It is
there to A/B on a device that still drops frames.

### Benchmarks as tests

- `ThreadPane.renderCost.test.tsx` and `TicketView.renderCost.test.tsx`
  count bubble renders (one `useDeliverBrighten` per bubble render),
  Markdown parses (remark-gfm's attacher runs once per processor) and pane
  renders (one `useKeyboardFlip` per pane render).
  - They assert 0 row renders and 0 parses per keystroke, per refetch or
    activity frame, and per viewport change.
  - They assert that the DOM is capped by the window at 300 to 500
    messages.
  - Timings and DOM sizes are printed as `[render-cost]` lines.
- `ThreadPane.window.test.tsx` and `TicketView.window.test.tsx` drive a
  fake layout (fixed row height, clamped `scrollTop`). They check that
  spacers keep `scrollHeight` and the visible row still, that rows come
  back before the reader reaches them, and that the window moves to the
  newest.

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
- Send (screen-record at 30/60 fps next to iMessage): frame 1 is the whole
  field as a faint blue pill with the placeholder already back; blue solid
  by ~0.1s, shrinking toward the right; text soft while it re-wraps; lands
  with a ~2px settle at ~0.42s, the list in sync; pill ends never squashed
  (clip-path), no hitch if the main thread is busy (clip-path is not
  guaranteed compositor-only in WebKit). Multi-line draft: no jump.
- Delivered: appears under the new bubble when confirmed, leaves the old
  one; Read once the agent starts working; no list movement either way.
  Tails: only the last bubble of a run; crisp at Text Size extremes.
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
