import { invoke, isTauri } from "@tauri-apps/api/core";
import { PUSH_PLUGIN } from "./pushAvailability";
import { MAX_UPLOAD_BYTES } from "../zen/composerAttach";

// The composer's native attach pickers (k2-push plugin, K2Pickers.swift):
// Photo Library opens PHPicker and Choose Files the document picker
// directly, so iOS never shows its own file-input menu and the composer
// keeps its keyboard. iOS only; Android and desktop reject `unsupported`
// and the composer uses the web file input instead.

export type PickedFile = { name: string; mime: string; base64: string };
export type SkippedFile = { name: string; reason: string };
export type PickResponse = {
  files?: PickedFile[];
  skipped?: SkippedFile[];
  cancelled?: boolean;
};

export type PickKind = "media" | "documents";

/** What a pick gave the composer. */
export type PickOutcome = { files: File[]; skipped: SkippedFile[]; cancelled: boolean };

/** Most media items one pick takes (PHPicker selection limit). */
export const PICK_MEDIA_LIMIT = 10;
/** One pick's total (raw bytes): base64 over IPC costs memory, so ten
 *  large videos are capped, and the rest reported as skipped. */
export const PICK_TOTAL_BYTES = 100_000_000;

/** iPhone, iPod or iPad (iPadOS reports a desktop Safari UA). */
export function isIosWebView(nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> = navigator): boolean {
  const ua = nav.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/** Synchronous gate, read inside the tap: false → the web file input
 *  (which must be clicked within the user gesture). */
export function nativePickerAvailable(): boolean {
  try {
    return isTauri() && isIosWebView();
  } catch {
    return false;
  }
}

/** base64 → File (the shape the hidden input hands `onAttach`). */
export function pickedToFile(p: PickedFile): File {
  const bin = atob(p.base64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], p.name || "attachment", {
    type: p.mime || "application/octet-stream",
  });
}

export function pickedToOutcome(res: PickResponse | null | undefined): PickOutcome {
  return {
    files: (res?.files ?? []).map(pickedToFile),
    skipped: res?.skipped ?? [],
    cancelled: Boolean(res?.cancelled),
  };
}

/** True for the plugin's "this platform has no native picker" answer. */
export function isUnsupportedPick(e: unknown): boolean {
  return /unsupported/i.test(String((e as { message?: string })?.message ?? e));
}

/** Open the native picker. Rejects when the platform has none
 *  (`isUnsupportedPick`) or the native layer failed. */
export async function nativePick(kind: PickKind): Promise<PickOutcome> {
  const args =
    kind === "media"
      ? { limit: PICK_MEDIA_LIMIT, maxBytes: MAX_UPLOAD_BYTES, maxTotalBytes: PICK_TOTAL_BYTES }
      : { maxBytes: MAX_UPLOAD_BYTES, maxTotalBytes: PICK_TOTAL_BYTES };
  const cmd = kind === "media" ? "pick_media" : "pick_documents";
  const res = await invoke<PickResponse>(`plugin:${PUSH_PLUGIN}|${cmd}`, args);
  return pickedToOutcome(res);
}

/** One line for the composer's attach error: the files the picker left out. */
export function skippedMessage(skipped: SkippedFile[]): string | null {
  if (!skipped.length) return null;
  const first = skipped[0];
  const why =
    first.reason === "too large"
      ? "is too large (50 MB max)"
      : first.reason === "total size limit"
        ? "was left out (100 MB per pick)"
        : "could not be read";
  const more = skipped.length > 1 ? ` (+${skipped.length - 1} more)` : "";
  return `"${first.name}" ${why}${more}`;
}
