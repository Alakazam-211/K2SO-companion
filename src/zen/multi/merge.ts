// The Agents tab's per-server list (multi-server S2: MS15, MS19, MS20,
// MS35 as amended by MA7, MA8 and MA12; owner 2026-10: the Agents tab is
// always ONE server, Home is the cross-server list). Pure.
//
// Identity:
//   - `key = <serverId>|<localId>` — React keys, stores, last-at, pins.
//     `localId` is today's row id on that server (`path`, `path#handle`,
//     `group:<id>`, `agent:<name>`).
//   - `address = <handle>::<hostKey>` — desktop's display address.
//     `handle/N::hostKey` (a sidecar) is a PHONE extension; group rows are
//     `group:<id>::hostKey`. Parse by splitting on the LAST `::`.
//
// Pins and focus groups are per server (MS19): the server's own current
// group filters its rows, and its pins come from its own `projects.pinned`.

import { visibleOverlayAgents } from "../overlayExtras";
import {
  filterByFocus,
  mainAtPath,
  pinProjectIdForRow,
  type FocusState,
  type ServerProject,
} from "../serverPins";
import type { StubAgent } from "../stubData";

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

function hay(a: StubAgent): string {
  return [a.name, a.chatTitle, a.addr].filter(Boolean).join(" ").toLowerCase();
}

/** One server's visible rows: hidden extras out (a search brings them
 *  back), and — not searching — its own focus group applied (MS19). */
export function visibleServerRows(src: MergedSource, q: string): StubAgent[] {
  const query = q.trim().toLowerCase();
  if (query) return src.agents.filter((a) => hay(a).includes(query));
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

export interface MergedList {
  /** Every visible row (pinned ones too); the caller sorts. */
  rows: MergedRow[];
  /** The pin grid: the server's pins in its own server order. Empty
   *  while searching. */
  pinned: MergedRow[];
}

/** The Agents tab's list: ONE server's rows and pins (the active server).
 *  No source (signed out, not loaded yet): empty. */
export function buildServerList(src: MergedSource | null, opts: { q: string }): MergedList {
  if (!src) return { rows: [], pinned: [] };
  const rows = visibleServerRows(src, opts.q).map((a) => toMerged(src, a));
  if (opts.q.trim()) return { rows, pinned: [] };
  const pinned: MergedRow[] = [];
  for (const id of src.pinnedIds) {
    const a = src.agents.find((x) => x.id === id);
    if (a) pinned.push(toMerged(src, a));
  }
  return { rows, pinned };
}

/** Q7 / MA13: which servers keep the 5 s activity snapshot — at most two:
 *  the Agents tab's server, plus the open room's (else the default's). */
export function snapshotServerIds(opts: {
  activeId: string | null;
  selectedId: string | null;
  roomServerId?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !out.includes(id) && out.length < 2) out.push(id);
  };
  add(opts.selectedId ?? opts.activeId);
  add(opts.roomServerId ?? opts.activeId);
  return out;
}
