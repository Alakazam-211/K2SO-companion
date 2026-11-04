import { invoke } from "@tauri-apps/api/core";
import { isIosWebView } from "./nativePicker";

// A copy of each server's login token in the iOS Keychain, for native code
// that runs with the webview asleep (the voice call's join and renewal; gap
// list §7). The servers store stays the source; every change to its tokens
// rewrites the whole set (a handful of servers), so a missed write heals on
// the next one or at the next launch.

const SYNC_DELAY_MS = 300;

let timer: ReturnType<typeof setTimeout> | null = null;
let latest: Record<string, string> | null = null;
let lastSent: string | null = null;

export function syncSecureTokens(tokens: Record<string, string>, ios = isIosWebView()): void {
  if (!ios) return;
  latest = tokens;
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    const send = latest ?? {};
    latest = null;
    const key = JSON.stringify(send);
    if (key === lastSent) return;
    void invoke<{ ok?: boolean }>("plugin:k2-push|token_op", { op: "sync", tokens: send }).then(
      (r) => {
        // Not readable yet (before the first unlock): the next change or launch tries again.
        if (r?.ok) lastSent = key;
      },
      () => {}
    );
  }, SYNC_DELAY_MS);
}

export function __resetSecureTokensForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  latest = null;
  lastSent = null;
}
