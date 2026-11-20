// Swipe between Home groups (K2 0.46.13, adapted for touch; brief §1.5,
// §1.6; K2 Design's touch note): a native horizontal page swipe over the
// Home list. The list follows the finger 1:1; on release it commits past
// 33 % of the width or on a flick (500 px/s), else it glides back. Past the
// first or last group it moves a third as far and springs back: NO wrap,
// and one swipe moves at most one group. A plain slide: no peek tile
// naming the next group (owner). The only other sign is the group bar's
// accent blend, tied to the progress (`useGroupSwipeStore`).
//
// The back gesture owns the screen's left edge: a swipe that starts on the
// list arms only past EDGE_ARM_PX from the left (the same edge
// `swipeBack.ts` arms inside). One that starts on the group bar arms
// anywhere on it.
//
// Direction: the finger moving left goes to the next group (it slides in
// from the right), right goes back.
//
// Pure decisions here; `useGroupSwipe.ts` is the plumbing.

import { create } from "zustand";
import { EDGE_ARM_PX, FLICK_MIN_DX_PX } from "../../lib/swipeBack";

export type GroupSwipeDirection = "next" | "prev";
export type GroupSwipePhase = "armed" | "tracking" | "rejected";

export const GROUP_SWIPE = {
  /** On release, travel past this share of the width commits. */
  commitAt: 0.33,
  /** A flick this fast (px/ms; 500 px/s) commits short of commitAt… */
  flickPxPerMs: 0.5,
  /** …once it has travelled this far (no twitch flicks). */
  flickMinPx: FLICK_MIN_DX_PX,
  /** The axis locks once the touch has moved this far (px). */
  axisLockPx: 10,
  /** Past the first or last group the list moves this share of the travel. */
  rubberBand: 1 / 3,
} as const;

/** The glide after a release (desktop's): no bounce, its length scaled by
 *  how far is left to go. */
export const GLIDE_MIN_MS = 180;
export const GLIDE_MAX_MS = 280;
export const GLIDE_EASE = "cubic-bezier(0.25, 1, 0.5, 1)";

/** Whether a touch at `startX` may start a group swipe. On the bar:
 *  anywhere. On the list: never inside the back gesture's left edge. */
export function canArmGroupSwipe(startX: number, onBar: boolean, edgePx: number = EDGE_ARM_PX): boolean {
  return onBar || startX > edgePx;
}

/** Lock the axis: sideways is a swipe, up / down is the list's scroll.
 *  One-way: once tracking or rejected, the phase holds. */
export function groupSwipePhase(phase: GroupSwipePhase, dx: number, dy: number): GroupSwipePhase {
  if (phase !== "armed") return phase;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay > GROUP_SWIPE.axisLockPx && ay >= ax) return "rejected";
  if (ax > GROUP_SWIPE.axisLockPx && ax > ay) return "tracking";
  return "armed";
}

/** Which way a finger travel `dx` goes. */
export function swipeDirection(dx: number): GroupSwipeDirection {
  return dx < 0 ? "next" : "prev";
}

/** The list's offset (px) for a finger travel `dx`: 1:1 toward a group
 *  that exists, a third as far where there is none; never past the width. */
export function groupSwipeOffset(dx: number, width: number, can: { prev: boolean; next: boolean }): number {
  const dir = swipeDirection(dx);
  const allowed = dir === "next" ? can.next : can.prev;
  const raw = allowed ? dx : dx * GROUP_SWIPE.rubberBand;
  return Math.max(-width, Math.min(width, raw));
}

/** How far the swipe has gone toward a group that exists (0–1), for the
 *  bar's accent blend. 0 where there is no group that way. */
export function groupSwipeProgress(dx: number, width: number, can: { prev: boolean; next: boolean }): number {
  const allowed = swipeDirection(dx) === "next" ? can.next : can.prev;
  if (!allowed || width <= 0) return 0;
  return Math.max(0, Math.min(1, Math.abs(dx) / width));
}

/** On release: commit or glide back. `velocity` is px/ms, positive
 *  rightward. A flick the way the finger went commits; a flick back
 *  cancels; else past `commitAt` of the width commits. Never where there
 *  is no group that way. */
export function groupSwipeRelease(
  dx: number,
  velocity: number,
  width: number,
  can: { prev: boolean; next: boolean }
): { outcome: "commit" | "cancel"; direction: GroupSwipeDirection } {
  const direction = swipeDirection(dx);
  const allowed = direction === "next" ? can.next : can.prev;
  if (!allowed || dx === 0) return { outcome: "cancel", direction };
  const toward = Math.abs(dx);
  const v = direction === "next" ? -velocity : velocity; // speed the way it went
  if (v <= -GROUP_SWIPE.flickPxPerMs) return { outcome: "cancel", direction };
  if (v >= GROUP_SWIPE.flickPxPerMs && toward >= GROUP_SWIPE.flickMinPx) return { outcome: "commit", direction };
  return { outcome: toward >= width * GROUP_SWIPE.commitAt ? "commit" : "cancel", direction };
}

/** The glide's length for `remaining` (0–1 of the width) left to go. */
export function glideMs(remaining: number): number {
  const r = Math.max(0, Math.min(1, remaining));
  return Math.round(GLIDE_MIN_MS + (GLIDE_MAX_MS - GLIDE_MIN_MS) * r);
}

/** The group a committed swipe lands on (no wrap), or null. */
export function neighbourIndex(index: number, count: number, direction: GroupSwipeDirection): number | null {
  const next = direction === "next" ? index + 1 : index - 1;
  return next >= 0 && next < count ? next : null;
}

/** What the group bar reads while a swipe is under way: how far (0–1) and
 *  which way. The bar blends the current icon's accent into the target's
 *  in step with it. Null at rest. */
export interface GroupSwipeState {
  swipe: { progress: number; direction: GroupSwipeDirection } | null;
  set: (swipe: { progress: number; direction: GroupSwipeDirection } | null) => void;
}

export const useGroupSwipeStore = create<GroupSwipeState>((set) => ({
  swipe: null,
  set: (swipe) => set({ swipe }),
}));

/** How much of the accent a bar icon wears (0–1): the current group's
 *  fades out and the target's fades in as the swipe goes. */
export function accentShare(
  index: number,
  currentIndex: number,
  count: number,
  swipe: GroupSwipeState["swipe"]
): number {
  if (!swipe || swipe.progress <= 0) return index === currentIndex ? 1 : 0;
  const target = neighbourIndex(currentIndex, count, swipe.direction);
  if (target === null) return index === currentIndex ? 1 : 0;
  if (index === currentIndex) return 1 - swipe.progress;
  if (index === target) return swipe.progress;
  return 0;
}
