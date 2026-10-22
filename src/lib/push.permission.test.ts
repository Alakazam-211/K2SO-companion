// Permission-card pushes (K2 0.46.3 phone contract §7) against K2's golden
// push samples (src/test/fixtures/permission-cards-0463/push__*). They are
// ordinary Thread alerts: a tap opens the Thread at the card's seq on the
// server the relay stamped. The sealed plaintext carries its stamp in
// `srv`/`bk`; the NSE (K2PushSealed.shape) folds it back into the same
// userInfo keys, mirrored here.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("./revive", () => ({ connectServer: vi.fn() }));

import legacy from "../test/fixtures/permission-cards-0463/push__permission__legacy.json";
import sealed from "../test/fixtures/permission-cards-0463/push__permission__sealed-plaintext.json";
import { matchTapServer, tapPath, type TapPayload } from "./push";
import type { ServerEntry } from "../stores/servers";

const server = (id: string, url: string): ServerEntry => ({ id, nickname: id, url, username: "rosson", rememberPassword: false });

/** K2PushSealed.shape: string `data`, then the stamp from `srv` / `bk`. */
function unsealedInfo(p: typeof sealed): Record<string, string> {
  const info: Record<string, string> = { ...p.data };
  info.subdomain = p.srv.sub;
  info.instanceId = p.srv.iid;
  info.badgeKey = p.bk;
  if (!info.kind) info.kind = p.kind;
  return info;
}

describe("permission push samples (§7)", () => {
  it("legacy: a Thread tap that opens the card's seq on the stamped server", () => {
    const tap = legacy.data as TapPayload;
    expect(tapPath(tap)).toBe("/zen?addr=billing&seq=1");
    const hit = matchTapServer(tap, [server("a", "https://other.k2.dev"), server("b", "https://rosson.k2.dev")]);
    expect(hit?.id).toBe("b");
    expect(legacy.title).toBe("billing asks for a permission");
    expect(legacy.threadId).toBe(`thread:${legacy.data.conversationId}`);
  });

  it("sealed plaintext unseals to the legacy tap fields, with its group", () => {
    const info = unsealedInfo(sealed);
    for (const k of ["subdomain", "instanceId", "badgeKey", "addr", "seq", "conversationId", "requestId", "permission", "kind"]) {
      expect(info[k], k).toBe((legacy.data as Record<string, string>)[k]);
    }
    expect(tapPath(info as TapPayload)).toBe("/zen?addr=billing&seq=1");
    expect(sealed.group).toBe(legacy.threadId);
  });

  it("neither carries the asker's why, notes or values", () => {
    for (const p of [legacy, sealed]) {
      const text = JSON.stringify(p);
      expect(text).not.toContain("payroll");
      expect(text).not.toContain("40 min");
    }
  });
});
