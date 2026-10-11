import { fetchProjectGroupShow } from "../api/projectGroups";
import type { StubAgent } from "./stubData";
import { posixNormalize } from "./workspacePath";

/** A project chat's Point of Contact: the member workspace the group's
 *  chat injects into. `row` is that workspace's main-chat row on the
 *  Agents read, when the list has it (name, colour, icon, addr). */
export type GroupPoc = {
  workspaceId: string;
  path: string;
  name: string;
  row: StubAgent | null;
};

/** The PoC's main-chat row: same workspace path, not a sidecar, not a group. */
export function pocMainRow(agents: StubAgent[], path: string): StubAgent | null {
  const want = posixNormalize(path.trim());
  if (!want) return null;
  return (
    agents.find(
      (a) =>
        a.kind !== "group" &&
        posixNormalize((a.path || "").trim()) === want &&
        !(a.addr || "").includes("/")
    ) ?? null
  );
}

/** `GET /cli/project-group/show` → the PoC member's workspace. Null when
 *  the group has no PoC (memberless), the PoC was unregistered (no
 *  path), or the read failed. */
export async function resolveGroupPoc(
  groupId: string,
  agents: StubAgent[]
): Promise<GroupPoc | null> {
  const r = await fetchProjectGroupShow(groupId);
  if (!r.ok || !r.data) return null;
  const pocId = r.data.pocWorkspaceId;
  if (!pocId) return null;
  const member = (r.data.members ?? []).find((m) => m.workspaceId === pocId);
  const path = (member?.path || "").trim();
  if (!member || !path) return null;
  const row = pocMainRow(agents, path);
  const name =
    (row?.name || "").trim() ||
    (member.agentName || "").trim() ||
    (member.name || "").trim() ||
    path.split("/").filter(Boolean).pop() ||
    "Terminal";
  return { workspaceId: pocId, path, name, row };
}
