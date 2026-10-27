import { describe, expect, it, vi } from "vitest";

const { fetchMock, scoped } = vi.hoisted(() => ({ fetchMock: vi.fn(), scoped: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("./scopedFetch", () => ({ scopedFetch: (...a: unknown[]) => scoped(...a) }));

import {
  checkPairCode,
  isDeviceSessionEnded,
  isK2DevServer,
  normalizePairCode,
  pairDevice,
  pairErrorCode,
  pairUrlFor,
  parsePairText,
  phoneName,
  requestPairCode,
} from "./pairing";

const CODE = "K2P-ABCDE-FGH12-34567-89XYZ";

describe("pairing codes and links", () => {
  it("normalizes a code: any case, dashes and spaces optional, prefix optional", () => {
    expect(normalizePairCode(CODE)).toBe(CODE);
    expect(normalizePairCode("k2pabcdefgh1234567 89xyz")).toBe(CODE);
    expect(normalizePairCode("abcde-fgh12-34567-89xyz")).toBe(CODE);
    expect(normalizePairCode("K2P-ABCDE")).toBeNull();
    expect(normalizePairCode("K2P-ABCDE-FGH12-34567-89XY!")).toBeNull();
  });

  it("reads the QR link, the /pair page's app link, and a bare code", () => {
    expect(parsePairText(`https://rosson.k2.dev/pair#${CODE}`)).toEqual({ serverUrl: "https://rosson.k2.dev", code: CODE });
    expect(parsePairText(`https://rosson.app.k2.dev/pair/#${CODE.toLowerCase()}`)).toEqual({ serverUrl: "https://rosson.k2.dev", code: CODE });
    expect(parsePairText(`k2companion://pair?server=rosson.k2.dev#${CODE}`)).toEqual({ serverUrl: "https://rosson.k2.dev", code: CODE });
    expect(parsePairText(`  ${CODE}  `)).toEqual({ serverUrl: null, code: CODE });
  });

  it("refuses links without a code, other paths, and odd hosts", () => {
    expect(parsePairText("https://rosson.k2.dev/pair")).toBeNull();
    expect(parsePairText(`https://rosson.k2.dev/login#${CODE}`)).toBeNull();
    expect(parsePairText(`k2companion://pair?server=evil host#${CODE}`)).toEqual({ serverUrl: null, code: CODE });
    expect(parsePairText("hello")).toBeNull();
  });

  it("pairs through the edge for a hosted apex, else the server itself", () => {
    expect(pairUrlFor("https://rosson.k2.dev/")).toBe("https://rosson.app.k2.dev/cli/auth/device/pair");
    expect(pairUrlFor("http://192.168.1.50:60710")).toBe("http://192.168.1.50:60710/cli/auth/device/pair");
    expect(pairUrlFor("https://rosson.k2.dev", "/cli/auth/device/pair/check")).toBe(
      "https://rosson.app.k2.dev/cli/auth/device/pair/check"
    );
  });

  it("warns on hosts outside k2.dev", () => {
    expect(isK2DevServer("https://rosson.k2.dev")).toBe(true);
    expect(isK2DevServer("https://k2.dev.evil.com")).toBe(false);
    expect(isK2DevServer("http://192.168.1.50:60710")).toBe(false);
    expect(isK2DevServer("not a url")).toBe(false);
  });

  it("names the phone for the device list", () => {
    expect(phoneName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(phoneName("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("iPad");
    expect(phoneName("Mozilla/5.0 (Linux; Android 15)")).toBe("Android phone");
  });

  it("reads error codes in both shapes", () => {
    expect(pairErrorCode('{"ok":false,"error":{"code":"pair_code_invalid","hint":"…"}}')).toBe("pair_code_invalid");
    expect(pairErrorCode('{"error":"device_session_ended"}')).toBe("device_session_ended");
    expect(pairErrorCode("<html>")).toBe("");
  });

  it("an ended device session is a 403 device_session_ended, nothing else", () => {
    expect(isDeviceSessionEnded(403, JSON.stringify({ error: "device_session_ended" }))).toBe(true);
    expect(isDeviceSessionEnded(403, JSON.stringify({ ok: false, error: { code: "device_session_ended" } }))).toBe(true);
    expect(isDeviceSessionEnded(401, "device_session_ended")).toBe(false);
    expect(isDeviceSessionEnded(403, JSON.stringify({ error: "password_change_required" }))).toBe(false);
  });
});

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe("pairing requests (final contract, K2 m_5ClOC889BH)", () => {
  it("check: who the code pairs as, without using it", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(200, { ok: true, user: "rosson", host: "rosson.k2.dev", expiresInSecs: 540 }));
    expect(await checkPairCode("https://rosson.k2.dev", CODE)).toEqual({
      ok: true,
      user: "rosson",
      host: "rosson.k2.dev",
      expiresInSecs: 540,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://rosson.app.k2.dev/cli/auth/device/pair/check");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: CODE });

    fetchMock.mockResolvedValueOnce(res(401, { ok: false, error: { code: "pair_code_invalid" } }));
    expect(await checkPairCode("https://rosson.k2.dev", CODE)).toMatchObject({ ok: false, kind: "code" });
    fetchMock.mockResolvedValueOnce(res(404, {}));
    expect(await checkPairCode("https://rosson.k2.dev", CODE)).toMatchObject({ ok: false, kind: "unchecked" });
  });

  it("pair: 0.46.6's serverName names the computer", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      res(200, { ok: true, token: "f".repeat(64), username: "rosson", serverName: " Rosson's MacBook Pro ", device: { sessionId: "s-1" } })
    );
    const r = await pairDevice("https://rosson.k2.dev", CODE, { id: "dev-1", name: "iPhone" });
    expect(r).toMatchObject({ ok: true, serverName: "Rosson's MacBook Pro" });
  });

  it("pair: the device body, the session back", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      res(200, {
        ok: true,
        token: "f".repeat(64),
        username: "rosson",
        role: "admin",
        expiresAt: "2026-11-23T00:00:00Z",
        maxExpiresAt: "2027-04-22T00:00:00Z",
        slidingDays: 30,
        maxDays: 180,
        mustChangePassword: false,
        device: { sessionId: "s-1", id: "dev-1", name: "iPhone" },
      })
    );
    const r = await pairDevice("https://rosson.k2.dev", CODE, { id: "dev-1", name: "iPhone" });
    expect(r).toMatchObject({ ok: true, username: "rosson", role: "admin", sessionId: "s-1", maxExpiresAt: "2027-04-22T00:00:00Z" });
    // Before 0.46.6 there is no serverName.
    expect(r).toMatchObject({ serverName: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: CODE, device: { id: "dev-1", name: "iPhone" } });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    fetchMock.mockResolvedValueOnce(res(401, { ok: false, error: { code: "pair_code_invalid" } }));
    expect(await pairDevice("https://rosson.k2.dev", CODE, { id: "d", name: "iPhone" })).toMatchObject({ ok: false, kind: "code" });
    fetchMock.mockResolvedValueOnce(res(429, { ok: false, error: { code: "rate_limited" } }));
    expect(await pairDevice("https://rosson.k2.dev", CODE, { id: "d", name: "iPhone" })).toMatchObject({ ok: false, kind: "refused" });
  });

  it("pair-code: the password once, on the server's own host", async () => {
    scoped.mockReset();
    scoped.mockResolvedValueOnce({ ok: true, status: 200, text: JSON.stringify({ ok: true, code: CODE.toLowerCase(), user: "rosson" }) });
    expect(await requestPairCode({ id: "s1" } as never, "hunter2")).toEqual({ ok: true, code: CODE });
    expect(scoped.mock.calls[0][1]).toBe("/cli/auth/device/pair-code");
    expect(JSON.parse(scoped.mock.calls[0][2].body)).toEqual({ password: "hunter2" });
    expect(scoped.mock.calls[0][2].revive).toBe(false);

    scoped.mockResolvedValueOnce({ ok: false, status: 401, text: JSON.stringify({ ok: false, error: { code: "password_invalid" } }) });
    expect(await requestPairCode({ id: "s1" } as never, "nope")).toMatchObject({ ok: false, kind: "password" });
  });
});
