import { describe, expect, it } from "vitest";
import { canonicalHostKey, homeHostKey, serverHostKey } from "./hostKey";

describe("host keys (desktop lib/host-key.ts port)", () => {
  it("https on 443 is the bare hostname; anything else carries its port", () => {
    expect(canonicalHostKey("https://DTL.k2.dev/")).toBe("dtl.k2.dev");
    expect(canonicalHostKey("dtl.k2.dev:443")).toBe("dtl.k2.dev");
    expect(canonicalHostKey("dtl.k2.dev")).toBe("dtl.k2.dev");
    expect(canonicalHostKey("http://box.lan")).toBe("box.lan:80");
    expect(canonicalHostKey("http://192.168.1.20:38471")).toBe("192.168.1.20:38471");
    expect(canonicalHostKey("https://[::1]:8443")).toBe("[::1]:8443");
    expect(homeHostKey({ hostname: "X.k2.dev", port: 443, secure: true })).toBe("x.k2.dev");
  });

  it("serverHostKey never throws", () => {
    expect(serverHostKey("https://example.k2.dev")).toBe("example.k2.dev");
    expect(serverHostKey("not a url/with/path")).toBeNull();
    expect(serverHostKey(null)).toBeNull();
  });
});
