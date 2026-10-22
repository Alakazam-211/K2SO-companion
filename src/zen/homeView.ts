import { hostLabel, serverHostKey, type ServerEntry } from "../stores/servers";
import { homeAddress, parseHomeAddress, type Home, type HomeRow } from "./homes";
import { entryMatchesHomeHost, homeHostLabel } from "./homeServerIds";
import { workspaceIdForRow } from "./multi/merge";
import { pinProjectIdForRow, type ServerProject } from "./serverPins";
import type { StubAgent } from "./stubData";
import { posixNormalize } from "./workspacePath";

// Home list + Add Agent picker (multi-server PRD §14 HM3/HM5).
//
// Rows on the ACTIVE server resolve against its Agents list. Rows on
// another saved server:
//   - flag off (`zen.multiServer`): only name it ("On <server>"); a tap
//     switches to that server, then opens (today's single-server Home);
//   - flag on (S3b): resolve against THAT server's own lists
//     (`multi/remoteRows`, read on its own scope): the handle wins, the
//     stored `workspaceId` is a rename-repair hint (desktop
//     `lib/home-address.ts`). Status, activity, picture and snippet are
//     added by the list from the S2 pool; a tap opens a room there.

/** One Home row as the list draws it. */
export type HomeRowView =
  /** On the active server and on its Agents list: opens like Agents. */
  | { kind: "here"; row: HomeRow; agent: StubAgent }
  /** On the active server, but its Agents list has no such agent now. */
  | { kind: "missing"; row: HomeRow }
  /** On another server. `server` is null when no saved server matches.
   *  `resolved` is set only with the multi-server flag on. */
  | {
      kind: "remote";
      row: HomeRow;
      server: ServerEntry | null;
      serverLabel: string;
      resolved?: RemoteResolution;
    };

/** A row from another server, resolved on that server's own lists (HM3). */
export interface RemoteResolution {
  /** That server's lists have been read at least once. */
  loaded: boolean;
  /** The agent there (handle wins; the stored workspace id finds a
   *  renamed one). Null when not loaded or not on its list. */
  agent: StubAgent | null;
  /** Its workspace id on that server (status / activity, MA12). */
  workspaceId: string | null;
}

/** What `resolveHomeRows` needs of one other server's lists. */
export interface ServerLists {
  agents: StubAgent[];
  serverProjects: ServerProject[];
  loadedAt: number | null;
}

/** A main chat that can be a Home row (no sidecars, groups, join misses). */
export function isHomeCandidate(a: StubAgent): boolean {
  const addr = (a.addr || "").trim();
  return a.kind !== "group" && !!addr && !addr.includes("/") && !a.joinMiss;
}

/** The address token of an Agents row: its overlay handle. */
export function agentHandle(a: StubAgent): string | null {
  return isHomeCandidate(a) ? (a.addr as string).trim().toLowerCase() : null;
}

/** A saved server's chip text. */
export function serverDisplayName(s: ServerEntry): string {
  return s.nickname || hostLabel(s.url);
}

/** The saved server a row host points at. One host-key rule for the
 *  whole app: `stores/servers` `serverHostKey` (MS1, MA1); a box
 *  `serverId` (K2 0.46.1, `./homeServerIds`) names the saved server that
 *  reported it. Two entries can share a key (MA35): the one holding a
 *  login wins (MS2), else the first. */
export function savedServerForHost(
  servers: ServerEntry[],
  host: string,
  tokens?: Record<string, string>
): ServerEntry | null {
  const hits = servers.filter((s) => entryMatchesHomeHost(s, host));
  if (tokens) {
    const signed = hits.find((s) => (tokens[s.id] ?? "").length > 0);
    if (signed) return signed;
  }
  return hits[0] ?? null;
}

/** Find a row's agent on the active server: handle wins (identity); the
 *  stored workspace id finds a renamed one (repair hint). */
export function findAgentForRow(
  row: HomeRow,
  agents: StubAgent[],
  projects: ServerProject[]
): StubAgent | null {
  const parsed = parseHomeAddress(row.address);
  if (!parsed) return null;
  const mains = agents.filter(isHomeCandidate);
  const byHandle = mains.find((a) => agentHandle(a) === parsed.handle);
  if (byHandle) return byHandle;
  if (row.workspaceId) {
    const p = projects.find((x) => x.id === row.workspaceId);
    if (p?.path) {
      return mains.find((a) => !!a.path && posixNormalize(a.path) === p.path) ?? null;
    }
  }
  return null;
}

export function resolveHomeRows(
  rows: HomeRow[],
  ctx: {
    activeHostKey: string | null;
    agents: StubAgent[];
    projects: ServerProject[];
    servers: ServerEntry[];
    /** Multi-server flag on (HM3/HM8): each other server's own lists, by
     *  server id. Absent (flag off): other-server rows only name it. */
    remote?: {
      byServer: Record<string, ServerLists | undefined>;
      tokens?: Record<string, string>;
    };
  }
): HomeRowView[] {
  const out: HomeRowView[] = [];
  const activeEntries = ctx.activeHostKey
    ? ctx.servers.filter((s) => serverHostKey(s) === ctx.activeHostKey)
    : [];
  for (const row of rows) {
    const parsed = parseHomeAddress(row.address);
    if (!parsed) continue;
    // Either spelling of the active server: host key or box id.
    if (
      ctx.activeHostKey &&
      (parsed.host === ctx.activeHostKey || activeEntries.some((s) => entryMatchesHomeHost(s, parsed.host)))
    ) {
      const agent = findAgentForRow(row, ctx.agents, ctx.projects);
      out.push(agent ? { kind: "here", row, agent } : { kind: "missing", row });
      continue;
    }
    const server = savedServerForHost(ctx.servers, parsed.host, ctx.remote?.tokens);
    const view: HomeRowView = {
      kind: "remote",
      row,
      server,
      serverLabel: server ? serverDisplayName(server) : homeHostLabel(parsed.host),
    };
    if (ctx.remote && server) {
      const lists = ctx.remote.byServer[server.id];
      const loaded = !!lists && lists.loadedAt !== null;
      const agent = loaded ? findAgentForRow(row, lists.agents, lists.serverProjects) : null;
      view.resolved = {
        loaded,
        agent,
        workspaceId: agent ? workspaceIdForRow(agent, lists!.serverProjects) ?? row.workspaceId : row.workspaceId,
      };
    }
    out.push(view);
  }
  return out;
}

/**
 * Rename repair for one server's rows (desktop `repairFromList`): a row on
 * `hostKey` (or on that server's box id `boxId`, K2 0.46.1) whose handle
 * is no longer on that server, while a workspace with its stored
 * `workspaceId` is, moves to that workspace's handle (`handle::boxId`,
 * else `handle::hostKey`) and takes its name. The handle wins: a row
 * whose handle is still listed is never touched. Feed it a list that
 * loaded (an empty or failed read repairs nothing).
 */
export function renameRepairFor(
  hostKey: string,
  projects: ServerProject[],
  agents: StubAgent[] = [],
  boxId: string | null = null
): (row: HomeRow) => HomeRow | null {
  const host = hostKey.trim().toLowerCase();
  const box = (boxId ?? "").trim().toLowerCase();
  const handles = new Set<string>();
  for (const p of projects) if (p.handle) handles.add(p.handle.trim().toLowerCase());
  for (const a of agents) {
    const h = agentHandle(a);
    if (h) handles.add(h);
  }
  return (row) => {
    if (!host || projects.length === 0) return null;
    const parsed = parseHomeAddress(row.address);
    if (!parsed || (parsed.host !== host && (!box || parsed.host !== box))) return null;
    if (handles.has(parsed.handle) || !row.workspaceId) return null;
    const p = projects.find((x) => x.id === row.workspaceId);
    const handle = (p?.handle || "").trim().toLowerCase();
    if (!p || !handle || handle === parsed.handle) return null;
    return { address: homeAddress(handle, box || host), workspaceId: p.id, label: p.name || row.label };
  };
}

/** Search over a Home row's label and handle (and its agent's name / path). */
export function homeRowMatches(v: HomeRowView, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const parsed = parseHomeAddress(v.row.address);
  const hay = [
    v.row.label,
    parsed?.handle ?? "",
    v.kind === "here" ? v.agent.name : v.kind === "remote" ? v.resolved?.agent?.name ?? "" : "",
    v.kind === "here" ? v.agent.path ?? "" : v.kind === "remote" ? v.resolved?.agent?.path ?? "" : "",
    v.kind === "remote" ? v.serverLabel : "",
  ];
  return hay.some((h) => h.toLowerCase().includes(needle));
}

/** A Home search covers every Home: the current Home's rows first, then
 *  the others' in Home order, each address once (the first Home it is on
 *  owns it: its name labels the hit, a Remove takes it off that Home). */
export function rowsAcrossHomes(
  homes: readonly Home[],
  currentId: string
): { rows: HomeRow[]; homeOf: Map<string, { id: string; name: string }> } {
  const ordered = [...homes.filter((h) => h.id === currentId), ...homes.filter((h) => h.id !== currentId)];
  const rows: HomeRow[] = [];
  const homeOf = new Map<string, { id: string; name: string }>();
  for (const h of ordered) {
    for (const r of h.rows) {
      if (homeOf.has(r.address)) continue;
      homeOf.set(r.address, { id: h.id, name: h.name });
      rows.push(r);
    }
  }
  return { rows, homeOf };
}

/** The row an Agents agent adds to a Home on the active server. */
export function homeRowFor(
  a: StubAgent,
  hostKey: string,
  projects: ServerProject[]
): HomeRow | null {
  const handle = agentHandle(a);
  if (!handle) return null;
  return {
    address: homeAddress(handle, hostKey),
    workspaceId: pinProjectIdForRow(a, projects),
    label: a.name,
  };
}

/** Add Agent search: name, path and handle. */
export function candidateMatches(a: StubAgent, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [a.name, a.path ?? "", a.addr ?? ""].some((h) => h.toLowerCase().includes(needle));
}
