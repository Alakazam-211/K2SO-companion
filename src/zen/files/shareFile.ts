// Hand a file's bytes to the person: the iOS Share sheet (Save to Files,
// AirDrop, another app) where the web view offers `navigator.share` with
// files; otherwise a plain download of a Blob URL.

import { bytesToObjectUrl } from "./fileBytes";

export type ShareOutcome = "shared" | "downloaded" | "cancelled" | "failed";

export async function shareOrSaveBytes(
  bytes: Uint8Array,
  name: string,
  mime: string
): Promise<ShareOutcome> {
  const type = mime || "application/octet-stream";
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (nav && typeof nav.share === "function" && typeof nav.canShare === "function" && typeof File === "function") {
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const file = new File([copy], name || "file", { type });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: name });
        return "shared";
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "cancelled";
      // Fall through to a download.
    }
  }
  try {
    const url = bytesToObjectUrl(bytes, type);
    const a = document.createElement("a");
    a.href = url;
    a.download = name || "file";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "downloaded";
  } catch {
    return "failed";
  }
}
