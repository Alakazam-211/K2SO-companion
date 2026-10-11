import { describe, expect, it } from "vitest";
import KT_SRC from "../../src-tauri/tauri-plugin-k2-push/android/src/main/java/com/alakazamlabs/k2so/push/K2PushPlugin.kt?raw";
import SWIFT_SRC from "../../src-tauri/tauri-plugin-k2-push/ios/Sources/K2PushPlugin.swift?raw";

// The Android tap bridge copies only allow-listed extras into the JS tap
// payload. A Thread tap needs every key below or it cannot route.

function tapKeys(src: string): string[] {
  const m = src.match(/val TAP_KEYS = listOf\(([\s\S]*?)\)/);
  if (!m) throw new Error("TAP_KEYS not found");
  return Array.from(m[1].matchAll(/"([^"]+)"/g), (x) => x[1]);
}

describe("Android TAP_KEYS", () => {
  it("keeps the ticket/project keys and adds every Thread key", () => {
    const keys = tapKeys(KT_SRC);
    for (const k of [
      "kind",
      "feedbackId",
      "ticketId",
      "id",
      "groupId",
      "subdomain",
      "instanceId",
      "addr",
      "conversationId",
      "seq",
      "projectId",
      "agentName",
      "msgKind",
      "count",
      "principal",
    ]) {
      expect(keys).toContain(k);
    }
  });

  it("iOS forwards every String userInfo value (no allow-list to update)", () => {
    const src = SWIFT_SRC;
    expect(src).toMatch(/for \(key, value\) in userInfo/);
    expect(src).toMatch(/if let value = value as\? String/);
  });
});
