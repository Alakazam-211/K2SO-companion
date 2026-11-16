// Home groups (K2 0.46.13): "the person sent something" → a `lastMessagedAt`
// stamp on the rows it is about, for "Most recent at the top". Ported from
// desktop `lib/home-row-stamp.ts` + `lib/user-send-bus.ts` +
// `lib/home-chat/stamp.ts`.
//
// ONLY the person's own accepted sends from this phone stamp a row (brief
// §1.4, §5.5; not the PRD's D11): a Thread post or a card answer for an
// agent (`noteAgentSend`, called by zenStore after the server took it), and
// a Home chat send for a person or a channel (`noteHomeChatSend`: the hook
// the Home chat builder calls after `/cli/home-chat/send` answers ok). A
// message someone else sent never passes through here.
//
// A stamp is a synced row change, so a burst of sends must not become a
// burst of pushes: each target is stamped at most once per
// STAMP_MIN_GAP_MS; a send inside that window is not lost — the latest one
// is stamped when the window ends (one trailing stamp).

import { parseHomeAddress, useHomesStore, type HomeRow } from "../homes";
import { entryMatchesHomeHost } from "../homeServerIds";
import { useServersStore } from "../../stores/servers";

export const STAMP_MIN_GAP_MS = 30_000;

/** What a send was to: an agent's Thread, a person's DM, a channel. */
export type SendTarget =
  | { kind: "agent"; serverId: string; addr: string }
  | { kind: "person"; serverId: string; ext: string }
  | { kind: "channel"; serverId: string; conv: string };

/** The row handle a target names (an agent's handle: a sidecar's `k2/3`
 *  is agent `k2`; a person's external id; a channel's Sew id). */
export function targetHandle(t: SendTarget): string | null {
  const raw = t.kind === "agent" ? t.addr.trim().toLowerCase().split("::")[0].split("/")[0] : t.kind === "person" ? t.ext.trim().toLowerCase() : t.conv.trim();
  return raw || null;
}

/** Does this Home row stand for the target? Same kind, same handle, and
 *  its host (host key or box id) names the target's saved server. */
export function rowMatchesTarget(row: HomeRow, t: SendTarget): boolean {
  const kind = row.kind ?? "agent";
  if (kind !== t.kind) return false;
  const p = parseHomeAddress(row.address);
  const handle = targetHandle(t);
  if (!p || !handle || p.handle !== handle) return false;
  const entry = useServersStore.getState().servers.find((s) => s.id === t.serverId);
  return !!entry && entryMatchesHomeHost(entry, p.host);
}

export interface StamperDeps {
  /** Write the stamp (the Homes store's `stampRowsMessaged`). */
  stamp(target: SendTarget, at: number): void;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
}

const targetKey = (t: SendTarget) => `${t.serverId}|${t.kind}|${targetHandle(t) ?? ""}`;

/** A send listener with the per-target rate limit. */
export function createSendStamper(deps: StamperDeps): (target: SendTarget) => void {
  const last = new Map<string, number>();
  const pending = new Map<string, { at: number; target: SendTarget }>();
  const flush = (key: string): void => {
    const p = pending.get(key);
    pending.delete(key);
    if (!p) return;
    last.set(key, deps.now());
    deps.stamp(p.target, p.at);
  };
  return (target) => {
    if (!target.serverId || !targetHandle(target)) return;
    const key = targetKey(target);
    const now = deps.now();
    const prev = last.get(key);
    if (prev === undefined || now - prev >= STAMP_MIN_GAP_MS) {
      last.set(key, now);
      deps.stamp(target, now);
      return;
    }
    const waiting = pending.has(key);
    pending.set(key, { at: now, target });
    if (!waiting) deps.schedule(() => flush(key), prev + STAMP_MIN_GAP_MS - now);
  };
}

const stamper = createSendStamper({
  stamp: (target, at) => {
    try {
      useHomesStore.getState().stampRowsMessaged((row) => rowMatchesTarget(row, target), at);
    } catch {
      /* a stamp never breaks a send */
    }
  },
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
});

/** The person's post or card answer to agent `addr` on saved server
 *  `serverId` was accepted. */
export function noteAgentSend(serverId: string | null | undefined, addr: string | null | undefined): void {
  if (!serverId || !addr) return;
  stamper({ kind: "agent", serverId, addr });
}

/** HOOK for Home chat (people and channels): call after the person's own
 *  `/cli/home-chat/send` answered ok, with the saved server it went to and
 *  the DM's person (`ext`, e.g. `k2:connect:<uuid>`) or the channel's Sew
 *  id (`conv`). Never for a message someone else sent. */
export function noteHomeChatSend(
  serverId: string | null | undefined,
  target: { kind: "person"; ext: string } | { kind: "channel"; conv: string }
): void {
  if (!serverId) return;
  stamper(target.kind === "person" ? { kind: "person", serverId, ext: target.ext } : { kind: "channel", serverId, conv: target.conv });
}
