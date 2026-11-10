// What an agent's profile shows of its settings and permissions: the
// desktop's Settings → Workspaces → Agent tab, read from that workspace's
// `/cli/projects/list` row. A field an older server doesn't send has no row.

export type AgentInfoRow = { label: string; value: string };

type Row = Record<string, unknown>;

/** The `/cli/projects/list` row for this workspace, or null. */
export function projectRowOf(data: unknown, projectId: string): Row | null {
  if (!Array.isArray(data)) return null;
  const row = data.find((r) => r && typeof r === "object" && (r as Row).id === projectId);
  return (row as Row | undefined) ?? null;
}

const has = (v: unknown) => v !== undefined && v !== null;
const on = (v: unknown) => v === true || v === 1 || v === "1";
const onOff = (v: unknown) => (on(v) ? "On" : "Off");
const orElse = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);

export function agentSettingRows(p: Row): AgentInfoRow[] {
  const rows: AgentInfoRow[] = [];
  if (typeof p.handle === "string" && p.handle) rows.push({ label: "Handle", value: p.handle });
  rows.push({ label: "Default agent", value: orElse(p.defaultAgent, "Server default") });
  rows.push({ label: "Default model", value: orElse(p.defaultModel, "Agent's default") });
  if (has(p.forceModelOnResume)) rows.push({ label: "Use this model on resume", value: onOff(p.forceModelOnResume) });
  if (has(p.completionSoundEnabled)) rows.push({ label: "Completion sound", value: onOff(p.completionSoundEnabled) });
  return rows;
}

const DATABASE: Record<string, string> = { off: "Off", read: "Read only", write: "On" };

/** In the desktop's order. `member`: a Member doesn't see Operate compute,
 *  as on the desktop. */
export function agentPermissionRows(p: Row, member: boolean): AgentInfoRow[] {
  const toggles: [string, string][] = [
    ["Let agents on other servers message this agent", "allowRemoteInstruct"],
    ["Manage DNS", "dnsManageEnabled"],
    ["Manage hosted mail", "mailManageEnabled"],
  ];
  const later: [string, string][] = [
    ["Build and run Apps", "agentsCanManageSkin"],
    ["Manage its Apps end to end", "agentsCanManageAppsFull"],
    ["Manage its Apps' users", "agentsCanManageAppUsers"],
    ["Hire and manage agents", "agentsCanManageAgents"],
    ["Server-wide secrets", "agentsCanManageVault"],
    ["Use compute nodes", "agentsCanUseCompute"],
    ...(member ? [] : ([["Operate compute", "agentsCanOperateCompute"]] as [string, string][])),
    ["Manage compute", "agentsCanManageCompute"],
    ["Upgrade Postgres", "agentsCanUpgradePostgres"],
    ["Manage K2 projects", "agentsCanManageProjects"],
    ["Manage Gardens and data sources", "agentsCanManageGardens"],
    ["Refresh its pinned chat", "agentsCanRefreshChat"],
    ["Create connections", "agentsCanCreateConnections"],
  ];
  const row = ([label, key]: [string, string]) => (has(p[key]) ? [{ label, value: onOff(p[key]) }] : []);
  const db = typeof p.dbAgentAccess === "string" ? DATABASE[p.dbAgentAccess] : undefined;
  return [
    ...toggles.flatMap(row),
    ...(db ? [{ label: "Create databases", value: db }] : []),
    ...later.flatMap(row),
  ];
}
