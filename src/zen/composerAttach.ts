/** Skin door: POST /cli/fs/upload-binary. 50MB single-shot ceiling. */
export const MAX_UPLOAD_BYTES = 50_000_000;

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
  if (fromName) return fromName;
  if ((file.type || "").startsWith("image/")) return "image.png";
  return "upload";
}

/** Caption plus returned workspace paths, one path per line. */
export function attachmentSendBody(caption: string, paths: string[]): string {
  return [caption.trim(), ...paths.filter(Boolean)].filter(Boolean).join("\n");
}
