import type { StubFile } from "./stubData";
import { isUnderWorkspace, posixNormalize, usableFsPath } from "./workspacePath";

/** Files pane empty state. Also shown when the server has no resources
 *  route (pre-0.45) and for project chats, which have no workspace. */
export const RESOURCES_EMPTY_TITLE = "No Workspace Resources yet";
export const RESOURCES_EMPTY_LINE =
  "Ask your agent to add files to Workspace Resources to see them here.";

/** Muted second line: the folder the file sits in, relative to the
 *  workspace. Null at the workspace root. A file pinned from outside the
 *  workspace shows its absolute folder. */
export function resourceHint(filePath: string, workspace: string): string | null {
  const file = posixNormalize(filePath);
  if (!file) return null;
  const folder = file.slice(0, file.lastIndexOf("/"));
  const root = posixNormalize(workspace);
  if (root && isUnderWorkspace(file, root)) {
    return folder.length > root.length ? folder.slice(root.length + 1) : null;
  }
  return folder || null;
}

/** `GET /cli/workspace/resources` → Files rows, in the daemon's order.
 *  Null when the body is not a resources answer (no `docs` array). */
export function parseWorkspaceResources(
  data: unknown,
  workspace: string
): StubFile[] | null {
  const docs =
    data && typeof data === "object" ? (data as { docs?: unknown }).docs : undefined;
  if (!Array.isArray(docs)) return null;
  const seen = new Set<string>();
  const rows: StubFile[] = [];
  for (const raw of docs) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Record<string, unknown>;
    const id = usableFsPath(d.filePath);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof d.fileName === "string" && d.fileName.trim()
        ? d.fileName.trim()
        : id.slice(id.lastIndexOf("/") + 1);
    rows.push({
      id,
      name,
      body: "",
      hint: resourceHint(id, workspace),
      missing: d.missing === true,
    });
  }
  return rows;
}
