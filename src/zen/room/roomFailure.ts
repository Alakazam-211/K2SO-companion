// What a room on another server shows when it cannot be used (multi-server
// MS36; desktop `lib/room-failure.ts`). The banner sits above the composer,
// the last messages stay, input is off, and there is exactly ONE action,
// scoped to that server — never a switch, retry or reload on another one.
//
// The copy is the list's (§6.8 as finalised by MA41), so a row and its room
// always say the same thing:
//
//   | state           | copy                               | action        |
//   |-----------------|------------------------------------|---------------|
//   | offline         | Offline · retrying in N s           | Retry now     |
//   | restarting      | Restarting…                         | Retry now     |
//   | signin-required | Sign in to {server}                 | Sign in       |
//   | rotate-required | Change password on {server}         | Sign in       |
//   | kicked          | Removed from {server}               | Sign in       |
//   | too-old         | {server} needs an update            | Open (switch) |
//   | no-access       | No access on {server}               | (none)        |
//   | removed         | {server} was removed from this phone| (none)        |
//
// "Checking…" (never checked yet) is NOT a failure: MS30 opens the room at
// once and checks later; a failure found then shows the banner.

import type { PoolEntry } from "../multi/pool";
import { resolveRowStatus, rowFailure, type FailureAction } from "../multi/rowStatus";

export type RoomFailureState =
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
  if (!f || f.state === "checking") return null;
  return {
    state: f.state,
    copy: f.copy,
    action: f.action,
    actionLabel: f.actionLabel,
    detail: f.detail ?? null,
  };
}
