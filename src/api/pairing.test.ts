import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { isDeviceSessionEnded, normalizePairCode, pairUrlFor, parsePairText } from "./pairing";

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
  });

  it("an ended device session is a 403 device_session_ended, nothing else", () => {
    expect(isDeviceSessionEnded(403, JSON.stringify({ error: "device_session_ended" }))).toBe(true);
    expect(isDeviceSessionEnded(401, "device_session_ended")).toBe(false);
    expect(isDeviceSessionEnded(403, JSON.stringify({ error: "password_change_required" }))).toBe(false);
  });
});
