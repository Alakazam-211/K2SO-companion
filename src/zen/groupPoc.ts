import type { ServerScope } from "../api/client";
import { fetchProjectGroupShow } from "../api/projectGroups";
import { usableFsPath } from "./workspacePath";

/** A project chat has no folder of its own. Its files (the Files tree,
 *  chat links, uploads) live in its PoC member's workspace. */
export type GroupPoc = {
  /** The PoC workspace's absolute path, or null. */
  path: string | null;
  /** The PoC workspace's handle (upload `workspace`), or null. */
  handle: string | null;
  /** Why there is no path, when there is none. */
  note: string | null;
};

/** Read the PoC member from `project-group/show` on the room's server. */
export async function loadGroupPoc(scope: ServerScope, groupId: string): Promise<GroupPoc> {
  try {
    const r = await fetchProjectGroupShow(scope, groupId);
    const poc = r.ok ? r.data?.pocWorkspaceId : null;
    const member = r.data?.members?.find((m) => m.workspaceId === poc);
    const path = usableFsPath(member?.path ?? "");
    if (path) {
      const handle = (member?.name || member?.workspaceId || "").trim() || null;
      return { path, handle, note: null };
    }
    return {
      path: null,
      handle: null,
      note: r.ok ? "This project has no PoC folder yet." : r.error || "Could not read the project",
    };
  } catch (e) {
    return { path: null, handle: null, note: e instanceof Error ? e.message : String(e) };
  }
}
