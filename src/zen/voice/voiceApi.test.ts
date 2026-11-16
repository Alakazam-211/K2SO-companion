import { beforeEach, describe, expect, it, vi } from "vitest";

const scopedFetch = vi.hoisted(() => vi.fn());
vi.mock("../../api/scopedFetch", () => ({ scopedFetch: (...a: unknown[]) => scopedFetch(...a) }));

import type { ServerScope } from "../../api/scope";
import { isK2CallId, leaveVoiceSession, SESSION_LEAVE_TIMEOUT_MS } from "./voiceApi";

const scope = { id: "s1" } as unknown as ServerScope;

beforeEach(() => scopedFetch.mockReset());

// K2's answers §4: `session/leave {callId}`, K2's id always, never blocking.
describe("leaveVoiceSession", () => {
  it("posts K2's vc_ id, in the background, with its own deadline", async () => {
    scopedFetch.mockResolvedValue({ ok: true, status: 200, text: '{"ok":true,"left":true,"already":true}' });
    expect(await leaveVoiceSession(scope, "vc_1f2e")).toBe(true);
    expect(scopedFetch).toHaveBeenCalledWith(scope, "/cli/voice/session/leave", {
      method: "POST",
      body: JSON.stringify({ callId: "vc_1f2e" }),
      priority: "background",
      timeoutMs: SESSION_LEAVE_TIMEOUT_MS,
    });
  });

  it("never without K2's id: none, empty or Sew's digits send nothing", async () => {
    for (const id of ["", "4455", "vc_", " vc_1"]) expect(await leaveVoiceSession(scope, id)).toBe(false);
    expect(scopedFetch).not.toHaveBeenCalled();
    expect(isK2CallId("vc_abc")).toBe(true);
    expect(isK2CallId(null)).toBe(false);
  });

  it("a refusal or a network error is only false (fire and forget)", async () => {
    scopedFetch.mockResolvedValueOnce({ ok: false, status: 404, text: '{"error":{"code":"call_not_found"}}' });
    expect(await leaveVoiceSession(scope, "vc_1")).toBe(false);
    scopedFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await leaveVoiceSession(scope, "vc_1")).toBe(false);
  });
});
