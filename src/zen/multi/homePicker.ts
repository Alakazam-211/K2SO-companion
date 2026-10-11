// Add Agent → Other servers (multi-server PRD §14 HM5, S3b). Pure.
//
// One section per other saved server, each listing THAT server's agents
// with its own saved login (`scopeFor(server)`, via `multi/remoteRows`) —
// never a switch, never the active server's token (MS7, MS32). A port of
// desktop `HomeAddPanels.tsx` `FromServerList`, on the phone's pool:
//
//   1. no login held            → sign in (signing in while its sheet is up)
//   2. pool: offline            → offline (Retry)
//   3. pool: starting           → loading ("Restarting…")
//   4. known version < 0.41.6   → needs an update (the floor, Q9)
//   5. pool: auth not ok        → sign in (kicked / rotate detail)
//   6. pool: role not allowed   → no access
//   7. its lists were read      → the agents
//   8. the read failed          → offline / sign in / no access / failed
//                                 (desktop `listingForError`); a server
//                                 that answered with nothing is "No agents"
//   9. else                     → loading
//
// A server whose lists were read once keeps showing them after a later
// failed refresh (MS39), unless the pool now says it is in trouble.

import { serverHostKey, type ServerEntry } from "../../stores/servers";
import { versionAtLeast } from "../../api/scope";
import type { StubAgent } from "../stubData";
import type { ServerProject } from "../serverPins";
import { roleAllowsRoom, type PoolEntry } from "./pool";
import type { RemoteRows } from "./remoteRows";
import { PHONE_FLOOR } from "./rowStatus";

export type PickerSection =
  | { kind: "loading"; copy: string }
  | { kind: "signin"; copy: string; detail: string | null }
  | { kind: "signing-in"; copy: string }
  | { kind: "offline"; copy: string }
  | { kind: "no-access"; copy: string }
  | { kind: "too-old"; copy: string; detail: string }
  | { kind: "failed"; copy: string }
  | { kind: "ok"; agents: StubAgent[]; projects: ServerProject[] };

export interface PickerSectionInput {
  label: string;
  hasLogin: boolean;
  signingIn: boolean;
  entry: PoolEntry | undefined;
  rows: Pick<RemoteRows, "status" | "agents" | "serverProjects" | "loadedAt" | "error" | "errorKind"> | undefined;
}

function signIn(input: PickerSectionInput, detail: string | null = null): PickerSection {
  if (input.signingIn) return { kind: "signing-in", copy: "Signing in…" };
  return { kind: "signin", copy: `Sign in to ${input.label} to list its agents.`, detail };
}

/** One Other servers section's state. */
export function pickerSectionState(input: PickerSectionInput): PickerSection {
  const { label, entry: e, rows } = input;
  if (!input.hasLogin) return signIn(input);
  if (e?.reach === "offline") return { kind: "offline", copy: "Offline" };
  if (e?.reach === "starting") return { kind: "loading", copy: "Restarting…" };
  const version = e?.boot?.version ?? null;
  if (version && !versionAtLeast(version, PHONE_FLOOR)) {
    return {
      kind: "too-old",
      copy: `${label} needs an update`,
      detail: `${label} runs K2 ${version}. The phone needs ${PHONE_FLOOR} or later.`,
    };
  }
  if (e && e.reach === "live" && e.auth !== "ok") {
    return signIn(
      input,
      e.authNote ??
        (e.auth === "kicked"
          ? `Removed from ${label}. Sign in again.`
          : e.auth === "rotate-required"
            ? `${label} needs a new password.`
            : null)
    );
  }
  if (e && e.reach === "live" && e.auth === "ok" && !roleAllowsRoom(e.role)) {
    return { kind: "no-access", copy: "Your login can’t list agents here" };
  }
  if (rows && rows.loadedAt !== null) {
    return { kind: "ok", agents: rows.agents, projects: rows.serverProjects };
  }
  if (rows?.status === "error") {
    switch (rows.errorKind) {
      case "offline":
        return { kind: "offline", copy: "Offline" };
      case "signin":
        return signIn(input);
      case "no-access":
        return { kind: "no-access", copy: "Your login can’t list agents here" };
      case "empty":
        return { kind: "ok", agents: [], projects: [] };
      default:
        return { kind: "failed", copy: `Couldn’t list agents: ${rows.error || "unknown error"}` };
    }
  }
  return { kind: "loading", copy: "Loading agents…" };
}

/** Should the picker ask this server for its lists now? Only with a login,
 *  never while the pool knows it cannot answer (offline, restarting, below
 *  the floor, signed out, no access), never on its own after a failed read
 *  (Retry asks), and only when its lists are missing or stale. */
export function pickerWantsLoad(input: PickerSectionInput, stale: boolean): boolean {
  if (!stale || !input.hasLogin || input.rows?.error) return false;
  if (input.entry?.reach === "starting") return false;
  const s = pickerSectionState(input);
  return s.kind === "loading" || s.kind === "ok";
}

/**
 * The saved servers the Other servers segment lists: every one but the
 * active server, deduped by host key (two entries for one daemon are one
 * section: the one holding a login wins, MS2/MA35), minus the active
 * server's own host key. A–Z by label, like desktop.
 */
export function otherServersForPicker(
  servers: ServerEntry[],
  activeId: string | null,
  tokens: Record<string, string>,
  labelOf: (s: ServerEntry) => string
): ServerEntry[] {
  const active = servers.find((s) => s.id === activeId) ?? null;
  const activeKey = active ? serverHostKey(active) : null;
  const byKey = new Map<string, ServerEntry>();
  for (const s of servers) {
    if (s.id === activeId) continue;
    const key = serverHostKey(s);
    if (activeKey && key === activeKey) continue;
    const prev = byKey.get(key);
    if (!prev || (!(tokens[prev.id] ?? "") && (tokens[s.id] ?? ""))) byKey.set(key, s);
  }
  return [...byKey.values()].sort((a, b) =>
    labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: "base" })
  );
}
