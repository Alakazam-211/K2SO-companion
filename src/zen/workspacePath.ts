/** Companion `GET /cli/fs/read-dir` lists the `path` query as a filesystem
 *  directory. `path=.` is the daemon cwd — on this box that is `/`.
 *  `~` and `~/…` are also unusable: the daemon does not expand them, and
 *  expanding on the phone would be the phone's home.
 *
 *  Allow-list (appa 2026-09-30): the path we request must equal this
 *  agent's own `path` from its own `/cli/agent/list` row. Layer 2 still
 *  hides a root listing on HTTP 200. */

export const NO_WORKSPACE_PATH =
  "No usable workspace path. Files are hidden until the path is known.";

export const PATH_NOT_OWNED =
  "Path is not this agent's workspace. Files hidden.";

export const ROOT_LISTING_HIDDEN =
  "read-dir listed the filesystem root. Files hidden.";

/** Collapse `.` / `..` / duplicate slashes. Null if the result is `/`
 *  or the path climbed above root (`/tmp/..`, `/Users/..`). */
export function posixNormalize(p: string): string | null {
  if (!p.startsWith("/")) return null;
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length === 0) return null;
  return `/${out.join("/")}`;
}

export function usableFsPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.trim();
  if (!s.startsWith("/") || s === "/") return null;
  return posixNormalize(s);
}

/** Request only this agent's own row path. `dir` must equal `agentPath`. */
export function ownedWorkspacePath(
  dir: string,
  agentPath: unknown
): string | null {
  const owned = typeof agentPath === "string" ? agentPath.trim() : "";
  if (!owned || dir !== owned) return null;
  return usableFsPath(owned);
}

export function isUnderWorkspace(filePath: string, workspace: string): boolean {
  return filePath === workspace || filePath.startsWith(`${workspace}/`);
}

/** QA saw etc/home/tmp/var (root symlinks) labelled LIVE FILES. */
export function looksLikeRootListing(
  entries: { name: string; path?: string }[]
): boolean {
  const names = new Set(entries.map((e) => e.name));
  if (names.has("etc") && names.has("home") && names.has("tmp")) return true;
  if (names.has("Applications") && names.has("Users") && names.has("bin")) {
    return true;
  }
  return entries.some(
    (e) =>
      e.path === "/Applications" || e.path === "/Users" || e.path === "/bin"
  );
}
