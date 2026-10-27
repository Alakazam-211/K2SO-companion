import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { parsePairText } from "../api/pairing";
import { PUSH_PLUGIN } from "./pushAvailability";
import { isIosWebView } from "./nativePicker";

// Pair links and the QR scanner (K2 0.46.4 `companion-pairing-v1`):
//
//   links    `https://<label>.k2.dev/pair#<code>` (universal link) and
//            `k2companion://pair?server=<host>#<code>` (the /pair page's
//            Open button) wait natively (lib.rs `ios_links`) until taken
//            here: at start, on `k2-open-url`, and on return to the
//            foreground. A link only ever opens the pairing confirm; it
//            never pairs by itself (K2's security review).
//   scanner  the k2-push plugin's camera (K2QrScanner.swift), iOS only.

export type PairLink = { serverUrl: string | null; code: string };

type PairLinkState = {
  /** The link waiting for the user's confirm, or null. */
  pending: PairLink | null;
  set: (link: PairLink | null) => void;
};

export const usePairLinkStore = create<PairLinkState>((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
}));

/** The pair links among opened URLs (others ignored); the last one wins. */
export function pairLinkOf(urls: string[]): PairLink | null {
  let found: PairLink | null = null;
  for (const u of urls) found = parsePairText(u) ?? found;
  return found;
}

async function takeOpenUrls(): Promise<string[]> {
  try {
    const urls = await invoke<string[]>("take_open_urls");
    return Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

let started = false;

/** Start taking pair links (once per app run). */
export function watchPairLinks(): void {
  if (started) return;
  started = true;
  try {
    if (!isTauri()) return;
  } catch {
    return;
  }
  const drain = () => {
    void takeOpenUrls().then((urls) => {
      const link = pairLinkOf(urls);
      if (link) usePairLinkStore.getState().set(link);
    });
  };
  drain();
  void listen("k2-open-url", drain).catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") drain();
  });
}

/** The scanner is there (the iOS app). */
export function qrScannerAvailable(): boolean {
  try {
    return isTauri() && isIosWebView();
  } catch {
    return false;
  }
}

export type ScanOutcome =
  | { kind: "text"; text: string }
  | { kind: "cancelled" }
  | { kind: "denied" }
  | { kind: "failed"; error: string };

/** Open the camera and read one QR code. */
export async function scanQr(): Promise<ScanOutcome> {
  try {
    const r = await invoke<{ text?: string; cancelled?: boolean; denied?: boolean }>(`plugin:${PUSH_PLUGIN}|scan_qr`);
    if (r?.denied) return { kind: "denied" };
    if (r?.text) return { kind: "text", text: r.text };
    return { kind: "cancelled" };
  } catch (e) {
    return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}
