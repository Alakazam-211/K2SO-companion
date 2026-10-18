// What a room shows when its server cannot be used (multi-server MS36;
// desktop `lib/room-failure.ts`, plus auto reconnect). The banner sits above
// the composer, the last messages stay, and there is at most ONE action,
// scoped to that server — never a switch, retry or reload on another one.
//
//   | state           | copy                                      | action        | input  |
//   |-----------------|-------------------------------------------|---------------|--------|
//   | reconnecting    | Reconnecting to {server}… (spinner)       | —             | queued |
//   | offline         | {server} is offline. We'll keep trying    | Retry now     | queued |
//   | restarting      | {server} is restarting… (spinner)         | Retry now     | queued |
//   | signin-required | Sign in to {server} / Sign in again to …  | Sign in (again)| off   |
//   | rotate-required | Change password on {server}               | Sign in       | off    |
//   | kicked          | Removed from {server}                     | Sign in       | off    |
//   | too-old         | {server} needs an update                  | Open (switch) | off    |
//   | no-access       | No access on {server}                     | (none)        | off    |
//   | removed         | {server} was removed from this phone      | (none)        | off    |
//
// A server that is down reads "Reconnecting to {server}…" for 10 s after it
// went down (or the user's last try: opening the chat, Retry now), and while
// a reconnect runs; then "{server} is offline. We'll keep trying". The app
// keeps checking it (5 s / 15 s / 30 s) and reconnects on its own; sends
// typed meanwhile wait and go out when it is back.
//
// "Checking…" (never checked yet) is NOT a failure: MS30 opens the room at
// once and checks later; a failure found then shows the banner.

import type { PoolEntry } from "../multi/pool";
import { resolveRowStatus, rowFailure, type FailureAction } from "../multi/rowStatus";
import { entryDown, reconnectPhase } from "../multi/serverHealth";

export type RoomFailureState =
  | "reconnecting"
  | "offline"
  | "restarting"
  | "signing-in"
  | "signin-required"
  | "rotate-required"
  | "kicked"
  | "too-old"
  | "no-access"
  | "removed";

export interface RoomFailure {
  state: RoomFailureState;
  copy: string;
  action: FailureAction | null;
  actionLabel: string | null;
  detail: string | null;
  /** A spinner beside the copy (a reconnect is being tried). */
  spinner?: boolean;
  /** Input stays on: sends wait and go out once the server is back. */
  queuesInput?: boolean;
}

export interface RoomFailureInput {
  /** Is the room's server still saved? */
  saved: boolean;
  /** Is a token held for it? */
  hasLogin: boolean;
  /** The pool's entry for it (undefined = never checked). */
  entry: PoolEntry | undefined;
  serverLabel: string;
  /** The user's own sign-in sheet for it is open. */
  signingIn?: boolean;
  now: number;
  /** The room is on the ACTIVE server: the pool reads it boot-only, so its
   *  login comes from `expired`, and it is in trouble only when down. */
  active?: boolean;
  /** Auto reconnect (`serverHealth`): seen down since / the user's last
   *  try / a reconnect running / the login expired. */
  downSince?: number | null;
  retryAt?: number | null;
  reconnecting?: boolean;
  expired?: boolean;
}

/** The down banner: "Reconnecting…" in the grace, then "offline". */
function downFailure(input: RoomFailureInput, restarting: boolean): RoomFailure {
  const label = input.serverLabel;
  if (restarting) {
    return {
      state: "restarting",
      copy: `${label} is restarting…`,
      action: "retry",
      actionLabel: "Retry now",
      detail: null,
      spinner: true,
      queuesInput: true,
    };
  }
  const phase = reconnectPhase({
    now: input.now,
    downSince: input.downSince,
    retryAt: input.retryAt,
    checkedAt: input.entry?.checkedAt ?? null,
    reconnecting: input.reconnecting,
  });
  if (phase === "reconnecting") {
    return {
      state: "reconnecting",
      copy: `Reconnecting to ${label}…`,
      action: null,
      actionLabel: null,
      detail: null,
      spinner: true,
      queuesInput: true,
    };
  }
  return {
    state: "offline",
    copy: `${label} is offline. We'll keep trying`,
    action: "retry",
    actionLabel: "Retry now",
    detail: null,
    queuesInput: true,
  };
}

function signInAgain(label: string): RoomFailure {
  return {
    state: "signin-required",
    copy: `Sign in again to ${label}`,
    action: "sign-in",
    actionLabel: "Sign in again",
    detail: null,
  };
}

/** Pure: the room's failure, or null when it is usable. */
export function roomFailure(input: RoomFailureInput): RoomFailure | null {
  if (!input.saved) {
    return {
      state: "removed",
      copy: `${input.serverLabel} was removed from this phone`,
      action: null,
      actionLabel: null,
      detail: null,
    };
  }
  const down = input.downSince != null || entryDown(input.entry);
  if (input.active) {
    // No login at all: Zen's own "Sign in to {server}" (hydrateAgents).
    if (!input.hasLogin) return null;
    if (input.expired) return signInAgain(input.serverLabel);
    if (!down) return null;
    return downFailure(input, input.entry?.reach === "starting");
  }
  if (input.hasLogin && input.expired && !input.signingIn) return signInAgain(input.serverLabel);
  const status = resolveRowStatus({
    saved: true,
    hasLogin: input.hasLogin,
    entry: input.entry,
    serverLabel: input.serverLabel,
    signingIn: input.signingIn,
    workspaceId: null,
    roomActivity: null,
  });
  const f = rowFailure(status, input.entry, input.serverLabel, input.now);
  if (!f || f.state === "checking") {
    // Never checked, but a read on it already failed: it is down.
    return down && input.hasLogin ? downFailure(input, false) : null;
  }
  if (f.state === "offline" || f.state === "restarting") {
    return downFailure(input, f.state === "restarting");
  }
  return {
    state: f.state,
    copy: f.copy,
    action: f.action,
    actionLabel: f.actionLabel,
    detail: f.detail ?? null,
  };
}
