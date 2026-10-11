// What a row from a saved server says (multi-server S2: MS17 as amended by
// MA10, MS18 by MA12, MS35's copy table). A port of desktop K2's
// `lib/home-status.ts` `resolveRowStatus` ("other server" branch), in
// desktop's exact order:
//
//   1. not saved                → offline
//   2. no login held            → sign-in (or signing-in while the user's
//                                 own sign-in sheet is up; NG5: the phone
//                                 never signs in on its own)
//   3. no entry / unknown       → checking
//   4. offline
//   5. starting
//   6. (phone) known version below the floor → too-old (Q9: 0.41.6)
//   7. auth not ok              → sign-in, with the rotate / kicked detail
//   8. role not allowed         → no-access (a null role is ALLOWED)
//   9. the open room's activity, else the summary's by `workspaceId`,
//      else live
//
// "Removed" is a room-only state (MS36, S3). The summary carries no counts,
// so a row whose activity comes from it shows the dot and the word only.

import { versionAtLeast } from "../../api/scope";
import type { ActivityDisplay, RowActivity } from "../agentActivity";
import { roleAllowsRoom, type PoolEntry, type PresenceActivity } from "./pool";

/** Below this the phone's Thread room cannot work (owner compose). */
export const PHONE_FLOOR = "0.41.6";

export type RowStatusKind =
  | "working"
  | "permission"
  | "monitoring"
  | "unverifiable"
  | "review"
  | "idle"
  | "live"
  | "starting"
  | "offline"
  | "signing-in"
  | "sign-in"
  | "no-access"
  | "checking"
  | "too-old";

export interface RowStatus {
  kind: RowStatusKind;
  label: string;
  /** Why, for the row's second line / a11y ("Removed from B. Sign in again."). */
  detail?: string | null;
}

const LABELS: Record<RowStatusKind, string> = {
  working: "Working",
  permission: "Needs you",
  monitoring: "Monitoring",
  unverifiable: "No update",
  review: "Done",
  idle: "Idle",
  live: "Live",
  starting: "Starting",
  offline: "Offline",
  "signing-in": "Signing in…",
  "sign-in": "Sign in",
  "no-access": "No access",
  checking: "Checking…",
  "too-old": "Needs an update",
};

function status(kind: RowStatusKind, detail?: string | null): RowStatus {
  const out: RowStatus = { kind, label: LABELS[kind] };
  if (detail) out.detail = detail;
  return out;
}

/** What a row's agent is doing, in Home words (`waiting` → `permission`). */
export type RoomRowActivity = "working" | "permission" | "monitoring" | "unverifiable" | "idle";

export function homeActivityWord(display: ActivityDisplay): RoomRowActivity {
  return display === "waiting" ? "permission" : display;
}

/** The summary's activity for a row's workspace, by its id ON THAT SERVER
 *  (MA12). Null workspace id → no dots. */
export function activityForWorkspace(
  activity: PresenceActivity[] | null | undefined,
  workspaceId: string | null | undefined
): RoomRowActivity | null {
  if (!activity || !workspaceId) return null;
  const hit = activity.find((a) => a.workspaceId === workspaceId);
  if (!hit) return null;
  return hit.display ? homeActivityWord(hit.display) : hit.status;
}

export interface RowStatusInput {
  /** False when the row's server is no longer saved. */
  saved: boolean;
  /** A token is held for that server. */
  hasLogin: boolean;
  entry: PoolEntry | undefined;
  /** The server's label, for copy. */
  serverLabel?: string;
  /** The user's own sign-in sheet for this server is open. */
  signingIn?: boolean;
  /** Set when the row's room (or a 5 s snapshot of its server) is live:
   *  it wins over the summary, both ways. */
  roomActivity?: RoomRowActivity | null;
  /** The row's workspace id on its server (`projects/list` id). */
  workspaceId?: string | null;
}

/** Pure: fold everything known into what the row shows. */
export function resolveRowStatus(input: RowStatusInput): RowStatus {
  const server = input.serverLabel || "this server";
  if (!input.saved) return status("offline");
  const e = input.entry;
  if (!input.hasLogin) {
    if (input.signingIn) return status("signing-in");
    return status("sign-in", e?.authNote ?? null);
  }
  if (!e || e.reach === "unknown") return status("checking");
  if (e.reach === "offline") return status("offline");
  if (e.reach === "starting") return status("starting");
  const version = e.boot?.version ?? null;
  if (version && !versionAtLeast(version, PHONE_FLOOR)) {
    return status("too-old", `${server} runs K2 ${version}. The phone needs ${PHONE_FLOOR} or later.`);
  }
  if (input.signingIn && e.auth !== "ok") return status("signing-in");
  if (e.auth !== "ok") {
    const detail =
      e.authNote ??
      (e.auth === "rotate-required"
        ? `${server} needs a new password.`
        : e.auth === "kicked"
          ? `Removed from ${server}. Sign in again.`
          : null);
    return status("sign-in", detail);
  }
  if (!roleAllowsRoom(e.role)) {
    return status(
      "no-access",
      `Your login on ${server} is ${e.role || "unknown"}. Ask its owner for Member access.`
    );
  }
  const busy =
    input.roomActivity != null
      ? input.roomActivity
      : activityForWorkspace(e.activity, input.workspaceId ?? null);
  if (busy !== null && busy !== "idle") return status(busy);
  return status("live");
}

/** A row's activity as the list's `RowActivity` (dot + word). Summary
 *  activity has no counts (MA12/MA13): zeros, so no count text shows. */
export function rowActivityOf(s: RowStatus): RowActivity | null {
  const display: ActivityDisplay | null =
    s.kind === "working"
      ? "working"
      : s.kind === "permission"
        ? "waiting"
        : s.kind === "monitoring"
          ? "monitoring"
          : null;
  return display ? { display, counts: { subagents: 0, tools: 0, commands: 0 } } : null;
}

// ─── Failure rows (MS35 copy table, MA10 additions) ───

export type FailureState =
  | "checking"
  | "offline"
  | "restarting"
  | "signing-in"
  | "signin-required"
  | "kicked"
  | "rotate-required"
  | "too-old"
  | "no-access";

/** The ONE action a failure row offers, always scoped to its server. */
export type FailureAction = "retry" | "sign-in" | "switch";

export interface RowFailure {
  state: FailureState;
  /** The trailing state word, e.g. "Offline · retrying in 12 s". */
  copy: string;
  action: FailureAction | null;
  /** The action button's text. */
  actionLabel: string | null;
  detail?: string | null;
}

/** A row's failure, or null when the server is healthy. `now` is for the
 *  offline countdown. */
export function rowFailure(
  s: RowStatus,
  entry: PoolEntry | undefined,
  serverLabel: string,
  now: number
): RowFailure | null {
  const f = (
    state: FailureState,
    copy: string,
    action: FailureAction | null
  ): RowFailure => ({
    state,
    copy,
    action,
    actionLabel:
      action === "retry"
        ? "Retry now"
        : action === "sign-in"
          ? "Sign in"
          : action === "switch"
            ? "Open"
            : null,
    detail: s.detail ?? null,
  });
  switch (s.kind) {
    case "checking":
      return f("checking", "Checking…", null);
    case "offline": {
      const next = entry?.nextAt ?? null;
      const secs = next === null ? null : Math.max(0, Math.ceil((next - now) / 1000));
      return f(
        "offline",
        secs === null ? "Offline" : `Offline · retrying in ${secs} s`,
        "retry"
      );
    }
    case "starting":
      return f("restarting", "Restarting…", "retry");
    case "signing-in":
      return f("signing-in", "Signing in…", null);
    case "sign-in":
      if (entry?.auth === "kicked") return f("kicked", `Removed from ${serverLabel}`, "sign-in");
      if (entry?.auth === "rotate-required") {
        return f("rotate-required", `Change password on ${serverLabel}`, "sign-in");
      }
      return f("signin-required", `Sign in to ${serverLabel}`, "sign-in");
    case "too-old":
      return f("too-old", `${serverLabel} needs an update`, "switch");
    case "no-access":
      return f("no-access", `No access on ${serverLabel}`, null);
    default:
      return null;
  }
}

// ─── A server's own dot + word (filter menu, Servers sheet: MS35, MS38) ───

export interface ServerBadge {
  color: string;
  word: string;
}

const GREEN = "#22c55e";
const AMBER = "#f59e0b";
const RED = "#ef4444";
const GREY = "#8e8e93";

/** The pool's view of a whole server: the row fold with no workspace. */
export function serverBadge(input: Omit<RowStatusInput, "workspaceId" | "roomActivity">): ServerBadge {
  const s = resolveRowStatus({ ...input, workspaceId: null, roomActivity: null });
  switch (s.kind) {
    case "checking":
      return { color: GREY, word: "Checking…" };
    case "offline":
      return { color: RED, word: "Offline" };
    case "starting":
      return { color: AMBER, word: "Restarting…" };
    case "signing-in":
      return { color: AMBER, word: "Signing in…" };
    case "sign-in":
      return {
        color: RED,
        word:
          input.entry?.auth === "kicked"
            ? "Removed"
            : input.entry?.auth === "rotate-required"
              ? "Change password"
              : "Sign in",
      };
    case "too-old":
      return { color: GREY, word: "Needs an update" };
    case "no-access":
      return { color: GREY, word: "No access" };
    default:
      return { color: GREEN, word: "Live" };
  }
}
