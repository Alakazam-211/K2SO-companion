// The merged Agents list (multi-server S2: MS15, MS16, MS19, MS20, MS35 as
// amended by MA7, MA8 and MA12). Pure.
//
// Identity:
//   - `key = <serverId>|<localId>` — React keys, stores, last-at, pins.
//     `localId` is today's row id on that server (`path`, `path#handle`,
//     `group:<id>`, `agent:<name>`).
//   - `address = <handle>::<hostKey>` — desktop's display address.
//     `handle/N::hostKey` (a sidecar) is a PHONE extension; group rows are
//     `group:<id>::hostKey`. Parse by splitting on the LAST `::`.
//
// Rows are deduped by address (MS16): the same handle on two servers is two
// rows; two saved entries that share a host key (MA35) give one, the first
// source's (active, then signed-in, then A–Z: the entry with a token wins,
// MS2). Pins and focus groups stay per server (MS19): each server's own
// current group filters its own rows, and its pins come from its own
// `projects.pinned`.

import { visibleOverlayAgents } from "../overlayExtras";
import {
  filterByFocus,
  mainAtPath,
  pinProjectIdForRow,
  type FocusState,
  type ServerProject,
} from "../serverPins";
import type { StubAgent } from "../stubData";

export type ServerFilter = "all" | string;

export function rowKey(serverId: string, localId: string): string {
  return `${serverId}|${localId}`;
}

/** Split a row key on its FIRST `|` (server ids never hold one). */
export function parseRowKey(key: string): { serverId: string; localId: string } | null {
  const bar = key.indexOf("|");
  if (bar <= 0) return null;
  return { serverId: key.slice(0, bar), localId: key.slice(bar + 1) };
}

/** The handle half of a row's address. */
export function rowHandle(agent: Pick<StubAgent, "id" | "addr" | "kind" | "groupId">): string {
  if (agent.kind === "group" && agent.groupId) return `group:${agent.groupId}`;
  const addr = (agent.addr || "").trim();
  return addr || agent.id;
}

export function rowAddress(
  agent: Pick<StubAgent, "id" | "addr" | "kind" | "groupId">,
  hostKey: string
): string {
  return `${rowHandle(agent)}::${hostKey}`;
}

/** `handle::hostKey` → parts, splitting on the LAST `::` (an IPv6 host key
 *  is bracketed, so its colons never form `::` outside the brackets… but a
 *  handle never holds `::` either, so last-split is the safe rule). */
export function parseRowAddress(address: string): { handle: string; hostKey: string } | null {
  const at = address.lastIndexOf("::");
  if (at <= 0 || at + 2 >= address.length) return null;
  // `[fe80::1]:443` — a `::` inside brackets belongs to the host key.
  const open = address.lastIndexOf("[", at);
  const close = address.indexOf("]", at);
  if (open >= 0 && close > at && address.lastIndexOf("::", open) > 0) {
    const outer = address.lastIndexOf("::", open);
    return { handle: address.slice(0, outer), hostKey: address.slice(outer + 2) };
  }
  return { handle: address.slice(0, at), hostKey: address.slice(at + 2) };
}

/** The row's workspace id ON ITS SERVER (`projects/list` id, MA12): main
 *  rows by handle, sidecars by their base handle, else the single main
 *  project at the row's path. Group rows: none. */
export function workspaceIdForRow(
  agent: Pick<StubAgent, "id" | "addr" | "kind" | "path">,
  projects: ServerProject[]
): string | null {
  if (agent.kind === "group") return null;
  const direct = pinProjectIdForRow(agent, projects);
  if (direct) return direct;
  const base = (agent.addr || "").trim().split("/")[0];
  const byHandle = base ? projects.find((p) => p.handle === base) : null;
  return byHandle?.id ?? mainAtPath(agent.path, projects)?.id ?? null;
}

/** MS20 / Q2: chips only when more than one server is saved. */
export function showServerChips(savedCount: number): boolean {
  return savedCount > 1;
}

export interface MergedSource {
  serverId: string;
  hostKey: string;
  label: string;
  /** The active (default) server: its rows come from zenStore. */
  active: boolean;
  hasLogin: boolean;
  agents: StubAgent[];
  serverProjects: ServerProject[];
  pinnedIds: string[];
  focus: FocusState;
  hiddenAddrs: string[];
}

export interface MergedRow {
  key: string;
  address: string;
  serverId: string;
  hostKey: string;
  serverLabel: string;
  active: boolean;
  workspaceId: string | null;
  agent: StubAgent;
}

/** Source order: the active server, then servers with a login, then A–Z.
 *  The first source wins a duplicate address. */
export function orderSources<T extends Pick<MergedSource, "active" | "hasLogin" | "label">>(
  sources: T[]
): T[] {
  return sources
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        Number(b.s.active) - Number(a.s.active) ||
        Number(b.s.hasLogin) - Number(a.s.hasLogin) ||
        a.s.label.localeCompare(b.s.label, undefined, { sensitivity: "base" }) ||
        a.i - b.i
    )
    .map((x) => x.s);
}

function hay(a: StubAgent): string {
  return [a.name, a.chatTitle, a.addr].filter(Boolean).join(" ").toLowerCase();
}

/** One server's visible rows: hidden extras out (a search brings them
 *  back), and — not searching — its own focus group applied (MS19). With
 *  chips on, a search also matches the server's chip text (MS20). */
export function visibleServerRows(
  src: MergedSource,
  q: string,
  chips: boolean
): StubAgent[] {
  const query = q.trim().toLowerCase();
  if (query) {
    const chipHit = chips && src.label.toLowerCase().includes(query);
    return src.agents.filter((a) => chipHit || hay(a).includes(query));
  }
  const visible = visibleOverlayAgents(src.agents, "", src.hiddenAddrs);
  return filterByFocus(visible, src.focus, src.serverProjects, src.pinnedIds);
}

function toMerged(src: MergedSource, agent: StubAgent): MergedRow {
  return {
    key: rowKey(src.serverId, agent.id),
    address: rowAddress(agent, src.hostKey),
    serverId: src.serverId,
    hostKey: src.hostKey,
    serverLabel: src.label,
    active: src.active,
    workspaceId: workspaceIdForRow(agent, src.serverProjects),
    agent,
  };
}

/** Rows deduped by address, first source wins. */
export function dedupeByAddress(rows: MergedRow[]): MergedRow[] {
  const seen = new Set<string>();
  const out: MergedRow[] = [];
  for (const r of rows) {
    if (seen.has(r.address)) continue;
    seen.add(r.address);
    out.push(r);
  }
  return out;
}

export interface MergedList {
  /** Every visible row (pinned ones too), deduped; the caller sorts. */
  rows: MergedRow[];
  /** The pin grid: each server's pins in its own server order, servers in
   *  source order. Empty while searching. */
  pinned: MergedRow[];
}

export function buildMergedList(
  sources: MergedSource[],
  opts: { q: string; filter: ServerFilter; chips: boolean }
): MergedList {
  const picked = orderSources(
    opts.filter === "all" ? sources : sources.filter((s) => s.serverId === opts.filter)
  );
  const searching = opts.q.trim().length > 0;
  const rows: MergedRow[] = [];
  const pinned: MergedRow[] = [];
  for (const src of picked) {
    for (const a of visibleServerRows(src, opts.q, opts.chips)) rows.push(toMerged(src, a));
    if (searching) continue;
    for (const id of src.pinnedIds) {
      const a = src.agents.find((x) => x.id === id);
      if (a) pinned.push(toMerged(src, a));
    }
  }
  return { rows: dedupeByAddress(rows), pinned: dedupeByAddress(pinned) };
}

/** Q7 / MA13: which servers keep the 5 s activity snapshot — at most two:
 *  the filter's server (or the default server under "All"), plus the open
 *  room's. In S2 every room opens on the active (default) server. */
export function snapshotServerIds(opts: {
  activeId: string | null;
  filter: ServerFilter;
  roomServerId?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !out.includes(id) && out.length < 2) out.push(id);
  };
  add(opts.filter === "all" ? opts.activeId : opts.filter);
  add(opts.roomServerId ?? opts.activeId);
  return out;
}
