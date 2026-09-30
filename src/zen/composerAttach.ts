/** Skin door: POST /cli/fs/upload-binary. 50MB single-shot ceiling.
 *  `dir` is workspace-relative. Skin room root is `"."`. Empty string
 *  is refused as "Destination Directory is Empty". This is not
 *  read-dir `path=.` (daemon cwd). */
export const MAX_UPLOAD_BYTES = 50_000_000;
export const UPLOAD_DIR = ".";

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

export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
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

/** Caption plus returned workspace paths, one path per line. */
export function attachmentSendBody(caption: string, paths: string[]): string {
  return [caption.trim(), ...paths.filter(Boolean)].filter(Boolean).join("\n");
}
