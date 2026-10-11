import { scopedFetch } from "./scopedFetch";
import type { ServerScope } from "./scope";
import { interpretSendResponse, type SendOutcome } from "../lib/sendMode";

// T3 Safe send — `POST /cli/terminal/send-message` (Bearer) with body
// `{"session_id":"<uuid>","text":"..."}` (the terminalId ChatSession holds
// IS the daemon session uuid — the same `?session=` the grid-WS attaches
// with). The daemon's injector (per-session lock + ESC-sanitize +
// bracketed-paste framing + deterministic submit, workspace_msg.rs) owns
// delivery end-to-end, so the client sends the BARE text: no trailing
// `\r`, ever. Responses are 200 `MsgResponse` even on failure (reason/
// hint); a 403 is the capability gate. Mapping lives in sendMode.ts
// (pure, Node-tested); this module is transport only.
//
// Transport is the shared `scopedFetch` on the caller's scope (MS5/MA4):
// auth-classified rejection → revive THAT server → replay ONCE on the same
// scope only when a fresh token was minted. That layer eats the
// stale-token 403; a 403 that survives it is the
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
  scope: ServerScope,
  sessionId: string,
  text: string
): Promise<SendOutcome> {
  try {
    const out = await scopedFetch(scope, "/cli/terminal/send-message", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, text }),
      timeoutMs: SEND_TIMEOUT_MS,
    });
    return interpretSendResponse(out.status, out.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, message: `Couldn't reach the server: ${msg}` };
  }
}
