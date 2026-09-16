import { describe, expect, it } from "vitest";
import {
  k2DevApexLabel,
  loginUrlFor,
  LOGIN_404_K2DEV_MESSAGE,
} from "./loginUrl";

describe("loginUrlFor — mapping table", () => {
  const table: Array<[input: string, expected: string, why: string]> = [
    ["https://riley.k2.dev", "https://riley.app.k2.dev/cli/auth/login", "apex k2.dev → edge"],
    ["https://RILEY.K2.DEV", "https://riley.app.k2.dev/cli/auth/login", "uppercase host → lowercased edge"],
    ["https://Riley.k2.dev/", "https://riley.app.k2.dev/cli/auth/login", "trailing slash tolerated"],
    ["https://a.b.k2.dev", "https://a.b.k2.dev/cli/auth/login", "nested label is not a tunnel apex"],
    ["https://riley.app.k2.dev", "https://riley.app.k2.dev/cli/auth/login", "already the edge (hosted web origin)"],
    ["https://app.k2.dev", "https://app.k2.dev/cli/auth/login", "the edge apex itself is reserved"],
    ["https://k2.dev", "https://k2.dev/cli/auth/login", "bare apex has no label"],
    ["http://192.168.1.50:60710", "http://192.168.1.50:60710/cli/auth/login", "LAN ip:port unchanged"],
    ["http://localhost:47800", "http://localhost:47800/cli/auth/login", "loopback unchanged"],
    ["http://riley.k2.dev", "http://riley.k2.dev/cli/auth/login", "plain http never re-routed"],
    ["https://riley.k2.dev:8443", "https://riley.k2.dev:8443/cli/auth/login", "explicit non-443 port unchanged"],
    ["https://k2.example.com", "https://k2.example.com/cli/auth/login", "custom domain unchanged"],
    ["https://riley.k2.dev.evil.com", "https://riley.k2.dev.evil.com/cli/auth/login", "suffix look-alike unchanged"],
    ["https://rileyk2.dev", "https://rileyk2.dev/cli/auth/login", "missing dot is not k2.dev"],
  ];

  for (const [input, expected, why] of table) {
    it(`${why}: ${input}`, () => {
      expect(loginUrlFor(input)).toBe(expected);
    });
  }

  it("never touches the path of a non-edge host (exact suffix)", () => {
    expect(loginUrlFor("http://10.0.0.5:1234").endsWith("/cli/auth/login")).toBe(true);
    expect(loginUrlFor("http://10.0.0.5:1234").startsWith("http://10.0.0.5:1234")).toBe(true);
  });
});

describe("k2DevApexLabel", () => {
  it("returns the lowercase label for an apex hosted host", () => {
    expect(k2DevApexLabel("https://Riley.k2.dev")).toBe("riley");
    expect(k2DevApexLabel("https://my-box-01.k2.dev")).toBe("my-box-01");
  });
  it("returns null for everything else", () => {
    for (const h of [
      "https://a.b.k2.dev",
      "https://app.k2.dev",
      "http://riley.k2.dev",
      "https://riley.k2.dev:8443",
      "https://k2.example.com",
      "http://192.168.1.50:60710",
      "https://riley_k2.k2.dev",
    ]) {
      expect(k2DevApexLabel(h), h).toBeNull();
    }
  });
});

describe("LOGIN_404_K2DEV_MESSAGE", () => {
  it("is the agreed D3 copy", () => {
    expect(LOGIN_404_K2DEV_MESSAGE).toBe(
      "Sign-in through this server's web address failed (404). Make sure both K2 and the server are up to date.",
    );
  });
});
