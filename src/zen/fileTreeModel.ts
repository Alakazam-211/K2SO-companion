import type { FsDirEntry } from "../api/client";
import { isUnderWorkspace, posixNormalize } from "./workspacePath";

/** Big generated folders. Listed only while hidden files are shown
 *  (the eye is open), collapsed and dimmed; they load on expand like
 *  any folder. `.git` is a dotfile, so it follows the same switch. */
export const HEAVY_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  "vendor",
  ".next",
  "Pods",
  "DerivedData",
  "__pycache__",
]);

/** Rows drawn per folder before a "N more" line. */
export const TREE_ROW_CAP = 300;

export const SHOW_HIDDEN_KEY = "k2.zen.files.showHidden";

export function readShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowHidden(on: boolean): void {
  try {
    localStorage.setItem(SHOW_HIDDEN_KEY, on ? "1" : "0");
  } catch {
    /* per-device convenience only */
  }
}

/** Workspace Resources open or folded, per device. Default open. */
export const RESOURCES_COLLAPSED_KEY = "k2.zen.files.resourcesCollapsed";

export function readResourcesCollapsed(): boolean {
  try {
    return localStorage.getItem(RESOURCES_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeResourcesCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RESOURCES_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* per-device convenience only */
  }
}

export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

export function isHeavyDir(entry: Pick<FsDirEntry, "name" | "isDirectory">): boolean {
  return entry.isDirectory && HEAVY_DIRS.has(entry.name);
}

/** Folders first, then files, A–Z (case-insensitive). Dotfiles and
 *  heavy folders only while `showHidden`. */
export function treeEntries(entries: FsDirEntry[], showHidden: boolean): FsDirEntry[] {
  return entries
    .filter((e) => e && typeof e.name === "string" && typeof e.path === "string")
    .filter((e) => showHidden || (!isHiddenName(e.name) && !isHeavyDir(e)))
    .slice()
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentDir(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** `root` itself reads as its folder name; anything under it as `name/rel`. */
export function displayPathUnder(path: string, root: string): string {
  const rootName = baseName(root);
  if (path === root) return rootName;
  if (isUnderWorkspace(path, root)) return `${rootName}/${path.slice(root.length + 1)}`;
  return path;
}

/** A name for a new folder or a rename. Null when it is fine. */
export function validateEntryName(
  raw: string,
  siblings: string[],
  opts?: { current?: string }
): string | null {
  const name = raw.trim();
  if (!name) return "Enter a name.";
  if (/[\\/]/.test(name)) return "Names cannot contain slashes.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (name.includes("\0")) return "That name is not allowed.";
  if (opts?.current && name === opts.current) return "That is the current name.";
  const lower = name.toLowerCase();
  const clash = siblings.some(
    (s) => s.toLowerCase() === lower && !(opts?.current && s === opts.current)
  );
  if (clash) return "Something with that name is already here.";
  return null;
}

/** The part of a name a rename selects: the stem, not `.ext`. */
export function renameSelection(name: string, isDirectory: boolean): [number, number] {
  if (isDirectory) return [0, name.length];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [0, dot] : [0, name.length];
}

/** What a drop (or a file link) puts in the message: the path relative
 *  to the workspace in backticks, the inline-code form the chat renderer
 *  turns into a file link (`looksLikeFileRef`) and an agent reads as a
 *  path. Outside the workspace (a pinned resource elsewhere) it is the
 *  absolute path. A path with spaces becomes a markdown link with a
 *  percent-encoded target, which `fileRefFromHref` decodes. */
export function fileRefText(absPath: string, root: string | null): string {
  const abs = posixNormalize(absPath) ?? absPath;
  const rel =
    root && isUnderWorkspace(abs, root) && abs !== root ? abs.slice(root.length + 1) : abs;
  if (/\s/.test(rel) || rel.includes("`")) {
    const href = rel
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `[${baseName(rel)}](${href})`;
  }
  return `\`${rel}\``;
}

/** Add a reference to a draft: its own word, separated by one space. */
export function appendRef(draft: string, ref: string): string {
  if (!draft) return `${ref} `;
  const sep = /\s$/.test(draft) ? "" : " ";
  return `${draft}${sep}${ref} `;
}
