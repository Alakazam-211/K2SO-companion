// ── OSC 52 clipboard apply (T5b) ───────────────────────────────────
//
// Companion half of the desktop's kessel-term/oscClipboard.ts. The
// daemon decodes + size-caps the child's OSC 52 STORE and forwards it
// to every attached viewer as `{"event":"clipboard","payload":
// {"text":<plain text>}}` (sessions_grid_ws.rs::clipboard_frame — the
// base64 never reaches the client; the read-back/query form is never
// implemented). Each client decides LOCALLY whether to touch its OS
// clipboard — TerminalView gates on this connection being a claimer
// (wezterm's attached-client model, not tmux's stomp-every-client)
// and dedupes through `shouldApplyOsc52`.
//
// The pure parts run under plain Node (scripts/test-osc-clipboard.mjs);
// `writeClipboard` is the one DOM-touching helper and is honest about
// WKWebView's failure modes.

/** Whether an incoming OSC 52 payload should be written to the OS
 *  clipboard. Empty payloads are refused (a TUI clearing its own
 *  selection must not blank the user's clipboard) and consecutive
 *  identical payloads are refused — claude re-emits the same OSC 52
 *  on every repaint while a selection stays live (5× per selection
 *  observed in the desktop study). A DIFFERENT payload always applies,
 *  including one seen earlier (A→B→A is three real copies). */
export function shouldApplyOsc52(
  lastApplied: string | null,
  incoming: string,
): boolean {
  if (incoming.length === 0) return false;
  return incoming !== lastApplied;
}

/** Extract the text of a grid-WS `clipboard` frame payload. Defensive
 *  against shape drift — anything but `{text: string}` yields "" (which
 *  shouldApplyOsc52 then refuses). */
export function clipboardTextFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const t = (payload as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

export type ClipboardWriteResult = "written" | "unavailable" | "rejected";

/** Write to the OS clipboard, surfacing WKWebView reality instead of
 *  failing silently: `navigator.clipboard.writeText` outside a
 *  user-gesture-adjacent context can reject (NotAllowedError), and the
 *  API can be absent entirely. The caller shows a "Copied" toast on
 *  `written` and a manual-copy fallback pill otherwise — a button tap
 *  there IS a fresh user gesture, so the retry usually succeeds. */
export async function writeClipboard(text: string): Promise<ClipboardWriteResult> {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip || typeof clip.writeText !== "function") return "unavailable";
  try {
    await clip.writeText(text);
    return "written";
  } catch {
    return "rejected";
  }
}
