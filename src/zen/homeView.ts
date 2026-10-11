import { serverHostKey } from "../lib/hostKey";
import { hostLabel, type ServerEntry } from "../stores/servers";
import { homeAddress, parseHomeAddress, type HomeRow } from "./homes";
import { pinProjectIdForRow, type ServerProject } from "./serverPins";
import type { StubAgent } from "./stubData";
import { posixNormalize } from "./workspacePath";

// Home list + Add Agent picker (multi-server PRD §14 HM3/HM5), one server
// for now. Rows on the ACTIVE server resolve against its Agents list; rows
// on another saved server only name it ("On <server>").
// TODO(multi-server S2/S3): resolve other-server rows from the per-server
// pool (status, avatar, activity) and open them as rooms without switching.

/** One Home row as the list draws it. */
export type HomeRowView =
  /** On the active server and on its Agents list: opens like Agents. */
  | { kind: "here"; row: HomeRow; agent: StubAgent }
  /** On the active server, but its Agents list has no such agent now. */
  | { kind: "missing"; row: HomeRow }
  /** On another server. `server` is null when no saved server matches. */
  | { kind: "remote"; row: HomeRow; server: ServerEntry | null; serverLabel: string };

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

/** The saved server a host key points at (first match). */
export function savedServerForHost(servers: ServerEntry[], host: string): ServerEntry | null {
  return servers.find((s) => serverHostKey(s.url) === host) ?? null;
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
  }
): HomeRowView[] {
  const out: HomeRowView[] = [];
  for (const row of rows) {
    const parsed = parseHomeAddress(row.address);
    if (!parsed) continue;
    if (ctx.activeHostKey && parsed.host === ctx.activeHostKey) {
      const agent = findAgentForRow(row, ctx.agents, ctx.projects);
      out.push(agent ? { kind: "here", row, agent } : { kind: "missing", row });
      continue;
    }
    const server = savedServerForHost(ctx.servers, parsed.host);
    out.push({
      kind: "remote",
      row,
      server,
      serverLabel: server ? serverDisplayName(server) : parsed.host,
    });
  }
  return out;
}

/** Search over a Home row's label and handle (and its agent's name / path). */
export function homeRowMatches(v: HomeRowView, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const parsed = parseHomeAddress(v.row.address);
  const hay = [
    v.row.label,
    parsed?.handle ?? "",
    v.kind === "here" ? v.agent.name : "",
    v.kind === "here" ? v.agent.path ?? "" : "",
    v.kind === "remote" ? v.serverLabel : "",
  ];
  return hay.some((h) => h.toLowerCase().includes(needle));
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
