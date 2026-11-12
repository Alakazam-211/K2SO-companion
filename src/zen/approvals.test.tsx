// @vitest-environment jsdom
import pluginBuild from "../../src-tauri/tauri-plugin-k2-push/build.rs?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const core = vi.hoisted(() => ({ invoke: vi.fn(async (..._a: unknown[]) => ({ outcome: "approved" }) as unknown) }));
vi.mock("@tauri-apps/api/core", () => core);

import { approvalCardOf, approvalStatusLine, approverKeyStatus, openApproval } from "./approvals";
import { ApprovalCard } from "./ApprovalCard";
import { normaliseThreadItem } from "./threadModel";

const ID = "ap_0123456789abcdef";

afterEach(() => cleanup());
beforeEach(() => {
  core.invoke.mockClear();
  core.invoke.mockImplementation(async () => ({ outcome: "approved" }));
});

describe("the approval card model (daemon's doc.kind approval)", () => {
  it("reads the daemon's card and nothing to sign", () => {
    const c = approvalCardOf({
      kind: "approval",
      approval: { requestId: ID, status: "waiting", requestedBy: "k2-release", person: "rosson", answerBy: "2026-11-11T14:15:00Z", payloadB64: "x" },
    });
    expect(c).toEqual({ requestId: ID, status: "waiting", requestedBy: "k2-release", answerBy: "2026-11-11T14:15:00Z", device: null, answeredVia: null });
    expect(c && "payloadB64" in c).toBe(false);
  });

  it("takes requestedBy as {agent} too, and refuses a bad id or another kind", () => {
    expect(approvalCardOf({ kind: "approval", approval: { requestId: ID, requestedBy: { agent: "k2" } } })?.requestedBy).toBe("k2");
    expect(approvalCardOf({ kind: "approval", approval: { requestId: "ap_../../x" } })).toBeNull();
    expect(approvalCardOf({ kind: "text", approval: { requestId: ID } })).toBeNull();
    expect(approvalCardOf({ kind: "approval" })).toBeNull();
  });

  it("says each status in words", () => {
    const base = { requestId: ID, requestedBy: null, answerBy: null, device: null, answeredVia: null } as const;
    expect(approvalStatusLine({ ...base, status: "approved", device: "iPhone (iPhone18,4)" })).toBe("Approved on iPhone (iPhone18,4).");
    expect(approvalStatusLine({ ...base, status: "declined" })).toBe("Declined.");
    expect(approvalStatusLine({ ...base, status: "expired" })).toMatch(/Expired/);
    expect(approvalStatusLine({ ...base, status: "cancelled" })).toBe("Withdrawn.");
    expect(approvalStatusLine({ ...base, status: "waiting" })).toMatch(/Waiting for you/);
  });

  it("keeps an approval doc on the Thread even with an empty body", () => {
    const m = normaliseThreadItem(
      { doc: { id: "d1", kind: "approval", from: "k2", body: "", approval: { requestId: ID, status: "waiting" } } } as never,
      "rosson"
    );
    expect(m?.approval?.requestId).toBe(ID);
  });
});

describe("opening the native screen", () => {
  it("passes only the server, its address and the request id", async () => {
    const r = await openApproval("srv1", "https://z3thon.k2.dev", ID);
    expect(core.invoke).toHaveBeenCalledWith("plugin:k2-push|approval_open", {
      server: "srv1",
      url: "https://z3thon.k2.dev",
      requestId: ID,
    });
    expect(r).toEqual({ outcome: "approved" });
  });

  it("an unknown or failed answer is failed", async () => {
    core.invoke.mockImplementationOnce(async () => ({ outcome: "signed-something" }));
    expect((await openApproval("s", "https://x", ID)).outcome).toBe("failed");
    core.invoke.mockImplementationOnce(async () => {
      throw new Error("no plugin");
    });
    expect((await openApproval("s", "https://x", ID)).outcome).toBe("failed");
  });

  it("key status is check + key id only, [] off iOS", async () => {
    core.invoke.mockImplementationOnce(async () => ({ keys: [{ check: "biometric", keyId: "ab" }] }));
    expect(await approverKeyStatus()).toEqual([{ check: "biometric", keyId: "ab" }]);
    core.invoke.mockImplementationOnce(async () => {
      throw new Error("desktop");
    });
    expect(await approverKeyStatus()).toEqual([]);
  });
});

describe("the Thread card", () => {
  const card = { requestId: ID, status: "waiting", requestedBy: "k2", answerBy: null, device: null, answeredVia: null } as const;

  it("Review opens the native screen, then the Thread re-reads", async () => {
    const onClosed = vi.fn();
    render(<ApprovalCard card={card} server="srv1" url="https://z3thon.k2.dev" onClosed={onClosed} />);
    expect(screen.getByTestId("approval-requested-by").textContent).toBe("K2 says k2 asked for this.");
    fireEvent.click(screen.getByTestId("approval-review"));
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(core.invoke).toHaveBeenCalledWith("plugin:k2-push|approval_open", expect.objectContaining({ requestId: ID }));
  });

  it("an answered card has no Review", () => {
    render(<ApprovalCard card={{ ...card, status: "approved", device: "iPhone" }} server="s" url="https://x" onClosed={() => {}} />);
    expect(screen.queryByTestId("approval-review")).toBeNull();
    expect(screen.getByTestId("approval-status").textContent).toBe("Approved on iPhone.");
  });
});

// PRD SA-8 / §9 S1 "fails first": the web view has no sign call. The plugin's
// web-callable commands are listed in build.rs; none signs, and no web code
// invokes anything but the two approval screens.
describe("the web view has no sign call", () => {
  const commands = [...pluginBuild.matchAll(/^\s*"([a-z_]+)",/gm)].map((m) => m[1]);
  const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"], {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;

  it("no web-callable command signs or touches approver keys beyond the two screens", () => {
    expect(commands).toContain("approval_open");
    expect(commands).toContain("approver_keys");
    expect(commands.filter((c) => /sign|approv|attest/.test(c))).toEqual(["approval_open", "approver_keys"]);
  });

  it("no web code invokes a k2-push approval command other than the two screens", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const calls = Object.values(sources).flatMap((t) => [...t.matchAll(/plugin:k2-push\|([a-z_]+)/g)].map((m) => m[1]));
    expect([...new Set(calls.filter((c) => /sign|approv|attest/.test(c)))].sort()).toEqual(["approval_open", "approver_keys"]);
  });
});
