/** Companion `GET /cli/fs/read-dir` lists the `path` query as a filesystem
 *  directory. `path=.` is the daemon cwd — on this box that is `/`.
 *  `~` and `~/…` are also unusable: the daemon does not expand them, and
 *  expanding on the phone would be the phone's home. */

export const NO_WORKSPACE_PATH =
  "No usable workspace path. Files are hidden until the path is known.";

export const ROOT_LISTING_HIDDEN =
  "read-dir listed the filesystem root. Files hidden.";

export function usableFsPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.trim();
  if (!s.startsWith("/") || s === "/") return null;
  return s;
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
