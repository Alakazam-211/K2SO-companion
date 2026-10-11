// MS1 / MA1: the desktop host-key table (K2 `kessel/server-scope.test.ts`
// "host keys are canonical (MS60)"), row for row, minus `local` (the phone
// has no local daemon).

import { describe, expect, it } from "vitest";
import { canonicalHostKey, homeHostKey, tryHostKey } from "./hostKey";

describe("canonicalHostKey — the desktop spelling table", () => {
  it("one https server has one key however it is spelled", () => {
    for (const spelling of [
      "dtl.k2.dev",
      "DTL.k2.dev",
      " dtl.k2.dev ",
      "dtl.k2.dev:443",
      "https://dtl.k2.dev",
      "https://dtl.k2.dev/",
      "https://DTL.k2.dev:443",
      "wss://dtl.k2.dev",
    ]) {
      expect(canonicalHostKey(spelling)).toBe("dtl.k2.dev");
    }
  });

  it("plain http keeps its port, :80 included, so http and https never share a key", () => {
    expect(canonicalHostKey("http://box.lan")).toBe("box.lan:80");
    expect(canonicalHostKey("http://box.lan:80")).toBe("box.lan:80");
    expect(canonicalHostKey("box.lan:80")).toBe("box.lan:80");
    expect(canonicalHostKey("192.168.1.20:38471")).toBe("192.168.1.20:38471");
    expect(canonicalHostKey("http://192.168.1.20:38471/")).toBe("192.168.1.20:38471");
    expect(homeHostKey({ hostname: "box.lan", port: 80, secure: false })).toBe("box.lan:80");
    expect(homeHostKey({ hostname: "box.lan", port: 443, secure: true })).toBe("box.lan");
    expect(homeHostKey({ hostname: "box.lan", port: 8443, secure: true })).toBe("box.lan:8443");
    expect(canonicalHostKey("http://box.lan")).not.toBe(canonicalHostKey("https://box.lan"));
  });

  it("a non-default port gives the same key for http and https (MA1)", () => {
    expect(canonicalHostKey("https://x.lan:8443")).toBe("x.lan:8443");
    expect(canonicalHostKey("http://x.lan:8443")).toBe("x.lan:8443");
    expect(canonicalHostKey("x.lan:8443")).toBe("x.lan:8443");
  });

  it("no scheme means https only with no port or 443", () => {
    expect(canonicalHostKey("box.lan")).toBe("box.lan");
    expect(canonicalHostKey("box.lan:443")).toBe("box.lan");
    expect(canonicalHostKey("box.lan:8080")).toBe("box.lan:8080");
    expect(canonicalHostKey("http://box.lan:443")).toBe("box.lan:443");
  });

  it("IPv6 literals are bracketed with a port", () => {
    expect(homeHostKey({ hostname: "::1", port: 38471, secure: false })).toBe("[::1]:38471");
    expect(homeHostKey({ hostname: "[FE80::1]", port: 443, secure: true })).toBe("[fe80::1]:443");
    expect(canonicalHostKey("http://[::1]:38471")).toBe("[::1]:38471");
    expect(canonicalHostKey("[::1]:38471")).toBe("[::1]:38471");
    expect(canonicalHostKey("https://[::1]")).toBe("[::1]:443");
    expect(canonicalHostKey("::1")).toBe("[::1]:443");
  });

  it("anything that is not a server address throws", () => {
    for (const bad of [
      "",
      "https://",
      "dtl.k2.dev/cli/x",
      "user@dtl.k2.dev",
      "dtl.k2.dev:0",
      "dtl.k2.dev:99999",
      "a b",
      "dtl.k2.dev:abc",
      "[::1",
      "dtl.k2.dev.",
      "dtl.k2.dev?x=1",
      "dtl.k2.dev#frag",
    ]) {
      expect(() => canonicalHostKey(bad)).toThrow("not a host key");
      expect(tryHostKey(bad)).toBeNull();
    }
  });

  it("there is no special `local` key on the phone (it is just a hostname)", () => {
    expect(canonicalHostKey("local")).toBe("local");
    expect(canonicalHostKey("http://localhost:60710")).toBe("localhost:60710");
    expect(canonicalHostKey("http://127.0.0.1:60710")).toBe("127.0.0.1:60710");
  });
});
