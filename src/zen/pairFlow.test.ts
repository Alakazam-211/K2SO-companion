// Switch to pairing reports each step for its progress line (Rosson,
// 2026-10-27: a long pairing must never look like it did nothing).
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/pairing", () => ({
  phoneName: () => "iPhone",
  requestPairCode: vi.fn(async () => ({ ok: true, code: "K2P-ABCDE-FGH12-34567-89XYZ" })),
  pairDevice: vi.fn(async () => ({ ok: true, token: "dev", username: "rosson" })),
}));
vi.mock("../api/scope", () => ({ scopeFor: (id: string) => ({ serverId: id }) }));
vi.mock("../lib/push", () => ({ getDeviceId: async () => "install-1" }));
vi.mock("../stores/servers", () => ({
  useServersStore: { getState: () => ({ servers: [{ id: "a", url: "https://a.k2.dev" }] }) },
  commitPairedSession: vi.fn(async (input: { onStep?: (s: "leave" | "save") => void }) => {
    input.onStep?.("leave");
    input.onStep?.("save");
    return { ok: true, id: "a" };
  }),
}));

import { switchToPairing } from "./pairFlow";

describe("switchToPairing", () => {
  it("reports code → pair → leave → save", async () => {
    const steps: string[] = [];
    const r = await switchToPairing("a", "pw", (s) => steps.push(s));
    expect(r).toEqual({ ok: true, id: "a", username: "rosson" });
    expect(steps).toEqual(["code", "pair", "leave", "save"]);
  });
});
