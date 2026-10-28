import { usableFsPath } from "./workspacePath";

/** POST /cli/fs/upload-binary. 50MB single-shot ceiling.
 *  Companion is an owner token, so `dir` is absolute: the agent's
 *  workspace `.k2/downloads/` (desktop's compose-bar and terminal-drop
 *  destination). The daemon's `write_upload` creates that folder when it
 *  is missing, sanitises the name to its basename and, on a clash, writes
 *  `name (1).ext`, `name (2).ext`, … and returns the path it wrote.
 *  `"."` would be the daemon cwd (`/` on this box: EROFS) and an empty dir
 *  is refused, so a workspace with no usable path cannot attach. */
export const MAX_UPLOAD_BYTES = 50_000_000;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
};

export function extensionForType(type: string): string {
  const t = (type || "").toLowerCase().split(";")[0].trim();
  if (MIME_EXT[t]) return MIME_EXT[t];
  if (t.startsWith("image/") && t.length > 6 && t !== "image/*") {
    return t.slice(6);
  }
  return "";
}

export function safeFilename(name: string): string {
  const base = String(name)
    .split(/[\\/]/)
    .pop()
    ?.replace(/^\.+/, "")
    .trim();
  return (base || "").slice(0, 200);
}

/** Overlay addr `appa/1` uploads into workspace `appa`. */
export function workspaceHandleOf(
  addr: string | null | undefined
): string {
  return (addr || "").trim().split("/")[0] || "";
}

/** Where uploads land inside a workspace (desktop `handle-remote-drop`). */
export const DOWNLOADS_SUBDIR = ".k2/downloads";

/** Upload folder for a workspace: `<workspace>/.k2/downloads`. The
 *  workspace is the agent's own absolute path (a project chat: its PoC
 *  member's). Null for `.` / `` / `/` / relative paths. */
export function uploadDirOf(
  workspacePath: string | null | undefined
): string | null {
  const root = usableFsPath(workspacePath ?? "");
  return root ? `${root}/${DOWNLOADS_SUBDIR}` : null;
}

export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Copy picked files into memory now. Android hands the WebView a
 *  content:// reference whose read grant can lapse before Send (Samsung
 *  Gallery on Android 13: NotReadableError at upload), so the bytes are
 *  read while the pick is fresh. Unreadable files come back by name. */
export async function snapshotFiles(files: File[]): Promise<{ files: File[]; unreadable: string[] }> {
  const out: File[] = [];
  const unreadable: string[] = [];
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      out.push(new File([buf], f.name, { type: f.type, lastModified: f.lastModified }));
    } catch {
      unreadable.push(f.name || "file");
    }
  }
  return { files: out, unreadable };
}

export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromFiles = data.files?.length ? Array.from(data.files) : [];
  if (fromFiles.length) return fromFiles;
  const out: File[] = [];
  const items = data.items;
  if (!items) return out;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

export function uploadFilename(file: File): string {
  const fromName = safeFilename(file.name);
  const ext = extensionForType(file.type);
  if (fromName) {
    if (fromName.includes(".") || !ext) return fromName;
    return `${fromName}.${ext}`;
  }
  if ((file.type || "").startsWith("image/")) return `image.${ext || "png"}`;
  if (ext) return `upload.${ext}`;
  return "upload.bin";
}

// ── Path text, as desktop's compose bar writes it ─────────────────────
// Ports of K2 `external-drop-router.ts` `buildComposeDropPayload`,
// `file-drag.ts` `isImagePath` / `quotePathForImageDrop` and
// `TerminalComposeBar.tsx` `insertIntoDraft`.

const IMAGE_EXTS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif", ".pdf",
];

function isImagePath(p: string): boolean {
  const lower = p.toLowerCase();
  return IMAGE_EXTS.some((ext) => lower.endsWith(ext));
}

/** Images: bare if safe, else single-quoted (Claude Code's image detector
 *  strips quotes but not backslashes). */
function quotePathForImage(p: string): string {
  if (/[^a-zA-Z0-9_\-./]/.test(p)) return "'" + p.replace(/'/g, "'\\''") + "'";
  return p;
}

function shellEscape(p: string): string {
  return p.replace(/[ '"\\()&|;<>$`!#*?[\]{}~]/g, "\\$&");
}

/** Desktop compose payload: each path formatted, space-joined, trailing
 *  space for continued typing. No bracketed paste (plain text field). */
export function composeDropPayload(paths: string[]): string {
  const list = paths.filter(Boolean);
  if (!list.length) return "";
  return list.map((p) => (isImagePath(p) ? quotePathForImage(p) : shellEscape(p))).join(" ") + " ";
}

/** Insert `chunk` at `caret` (null: append), adding a separating space
 *  when needed. Desktop `insertIntoDraft`. */
export function insertIntoDraft(draft: string, chunk: string, caret: number | null): string {
  const piece = chunk.trimEnd() + (chunk.endsWith(" ") ? " " : chunk.length > 0 ? " " : "");
  if (!piece.trim()) return draft;
  if (caret === null || caret < 0 || caret > draft.length) {
    if (!draft) return piece;
    const needSpace = !/\s$/.test(draft) && !/^\s/.test(piece);
    return draft + (needSpace ? " " : "") + piece;
  }
  const before = draft.slice(0, caret);
  const after = draft.slice(caret);
  const needBefore = before.length > 0 && !/\s$/.test(before) && !/^\s/.test(piece);
  return before + (needBefore ? " " : "") + piece + after;
}

/** Uploaded paths put in a draft the way desktop's compose bar does
 *  (the terminal page's `＋`: the user keeps typing, then sends). */
export function attachPathsToDraft(draft: string, paths: string[]): string {
  return insertIntoDraft(draft, composeDropPayload(paths), null);
}

/** The message a thread send posts: caption, then the uploaded paths,
 *  trimmed like desktop's send (`draft.trim()`). */
export function attachmentSendBody(caption: string, paths: string[]): string {
  return attachPathsToDraft(caption.trim(), paths).trim();
}

/** Uploaded paths as an attachment takes them (K2 0.46.3 compose):
 *  workspace-relative, e.g. `.k2/downloads/photo.jpg`. `attachDir` is the
 *  upload folder (`<workspace>/.k2/downloads`). Null when any path is not
 *  inside that workspace (the caller quotes paths in the text instead). */
export function workspaceRelative(
  paths: readonly string[],
  attachDir: string | null | undefined
): string[] | null {
  const suffix = `/${DOWNLOADS_SUBDIR}`;
  if (!paths.length || !attachDir || !attachDir.endsWith(suffix)) return null;
  const root = attachDir.slice(0, -suffix.length);
  const out: string[] = [];
  for (const p of paths) {
    if (p.startsWith(`${DOWNLOADS_SUBDIR}/`)) out.push(p);
    else if (root && p.startsWith(`${root}/`)) out.push(p.slice(root.length + 1));
    else return null;
  }
  return out;
}
