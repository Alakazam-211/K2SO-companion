import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getBaseUrl, getToken } from "./client";
import { useServersStore } from "../stores/servers";
import { isPossibleAuthFailure, reviveServerSession } from "../lib/revive";
import { interpretSendResponse, type SendOutcome } from "../lib/sendMode";

// T3 Safe send — `POST /cli/terminal/send-message?token=<tok>` with body
// `{"session_id":"<uuid>","text":"..."}` (the terminalId ChatSession holds
// IS the daemon session uuid — the same `?session=` the grid-WS attaches
// with). The daemon's injector (per-session lock + ESC-sanitize +
// bracketed-paste framing + deterministic submit, workspace_msg.rs) owns
// delivery end-to-end, so the client sends the BARE text: no trailing
// `\r`, ever. Responses are 200 `MsgResponse` even on failure (reason/
// hint); a 403 is the capability gate. Mapping lives in sendMode.ts
// (pure, Node-tested); this module is transport only.
//
// client.ts doesn't export its request wrapper, so this carries the same
// minimal fetch with the SAME stale-session contract as feedback.ts:
// auth-classified rejection → revive (single-flight whoami + silent
// re-login) → replay ONCE only when a fresh token was actually minted.
// That layer eats the stale-token 403; a 403 that survives it is the
// remote-instruct decline, which interpretSendResponse surfaces as
// "This workspace hasn't enabled remote instruction for your role."
//
// Timeout: the injector intentionally sleeps ~520ms across its settle
// windows and may wait on the per-session lock behind an agent
// injection, so this uses a longer budget than the default 15s reads.

const SEND_TIMEOUT_MS = 30000;

/** Deliver `text` to the live session via the daemon's safe injector.
 *  Never throws — every failure comes back as `{ok:false, message}`
 *  ready for the composer's accessory row. */
export async function sendMessageToSession(
  sessionId: string,
  text: string
): Promise<SendOutcome> {
  const attempt = async (): Promise<{ status: number; text: string }> => {
    const base = getBaseUrl();
    if (!base) throw new Error("Not connected");
    const token = getToken();
    const url =
      `${base}/cli/terminal/send-message` +
      (token ? `?token=${encodeURIComponent(token)}` : "");
    const res = await Promise.race([
      tauriFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, text }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), SEND_TIMEOUT_MS)
      ),
    ]);
    return { status: res.status, text: await res.text() };
  };

  try {
    let out = await attempt();
    if (isPossibleAuthFailure(out.status, out.text)) {
      const serverId = useServersStore.getState().activeServerId;
      if (serverId) {
        const outcome = await reviveServerSession(serverId);
        // 'revived' = a NEW token was minted; replay once so a daemon
        // restart doesn't surface as a phantom permission decline. Any
        // other outcome keeps the original response (a still-valid
        // token that 403s here is the real remote-instruct gate).
        if (outcome === "revived") out = await attempt();
      }
    }
    return interpretSendResponse(out.status, out.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, message: `Couldn't reach the server: ${msg}` };
  }
}
