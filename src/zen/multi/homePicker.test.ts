// Add Agent → Other servers section states (multi-server S3b, HM5).
import { describe, expect, it } from "vitest";
import type { ServerEntry } from "../../stores/servers";
import { otherServersForPicker, pickerSectionState, pickerWantsLoad, type PickerSectionInput } from "./homePicker";
import { blankEntry, type PoolEntry } from "./pool";
import { emptyRemoteRows, type RemoteRows } from "./remoteRows";

const live = (extra: Partial<PoolEntry> = {}): PoolEntry => ({
  ...blankEntry("b", "bravo.k2.dev"),
  reach: "live",
  auth: "ok",
  role: "member",
  boot: { phase: "ready", ready: true, version: "0.45.3", protocol: 1, instanceId: "i", features: [], at: 1 },
  ...extra,
});
const loaded = (extra: Partial<RemoteRows> = {}): RemoteRows => ({
  ...emptyRemoteRows(),
  status: "live",
  agents: [{ id: "/d", name: "docs", initial: "D", path: "/d", addr: "docs", kind: "agent" }],
  loadedAt: 1,
  ...extra,
});
const input = (extra: Partial<PickerSectionInput> = {}): PickerSectionInput => ({
  label: "Bravo",
  hasLogin: true,
  signingIn: false,
  entry: live(),
  rows: loaded(),
  ...extra,
});

describe("pickerSectionState", () => {
  it("covers every state in desktop order", () => {
    expect(pickerSectionState(input({ hasLogin: false })).kind).toBe("signin");
    expect(pickerSectionState(input({ hasLogin: false, signingIn: true })).kind).toBe("signing-in");
    expect(pickerSectionState(input({ entry: live({ reach: "offline" }) })).kind).toBe("offline");
    expect(pickerSectionState(input({ entry: live({ reach: "starting" }) }))).toEqual({ kind: "loading", copy: "Restarting…" });
    const old = pickerSectionState(input({ entry: live({ boot: { ...live().boot!, version: "0.41.5" } }) }));
    expect(old).toMatchObject({ kind: "too-old", copy: "Bravo needs an update" });
    const kicked = pickerSectionState(input({ entry: live({ auth: "kicked" }) }));
    expect(kicked).toMatchObject({ kind: "signin", detail: "Removed from Bravo. Sign in again." });
    expect(pickerSectionState(input({ entry: live({ role: "viewer" }) })).kind).toBe("no-access");
    expect(pickerSectionState(input()).kind).toBe("ok");
    expect(pickerSectionState(input({ entry: undefined, rows: undefined })).kind).toBe("loading");
  });

  it("a never-loaded server's failed read says why; a loaded one keeps its list", () => {
    const failed = (errorKind: RemoteRows["errorKind"]) =>
      pickerSectionState(input({ entry: undefined, rows: { ...emptyRemoteRows(), status: "error", error: "HTTP 502", errorKind } })).kind;
    expect(failed("offline")).toBe("offline");
    expect(failed("signin")).toBe("signin");
    expect(failed("no-access")).toBe("no-access");
    expect(failed("failed")).toBe("failed");
    expect(failed("empty")).toBe("ok");
    expect(pickerSectionState(input({ rows: loaded({ error: "HTTP 502" }) })).kind).toBe("ok");
  });

  it("asks for lists only when missing or stale, never after a failed read or while the pool says no", () => {
    expect(pickerWantsLoad(input({ entry: undefined, rows: undefined }), true)).toBe(true);
    expect(pickerWantsLoad(input(), true)).toBe(true);
    expect(pickerWantsLoad(input(), false)).toBe(false);
    expect(pickerWantsLoad(input({ hasLogin: false, rows: undefined }), true)).toBe(false);
    expect(pickerWantsLoad(input({ entry: live({ reach: "offline" }), rows: undefined }), true)).toBe(false);
    expect(pickerWantsLoad(input({ entry: live({ reach: "starting" }), rows: undefined }), true)).toBe(false);
    expect(pickerWantsLoad(input({ rows: { ...emptyRemoteRows(), status: "error", error: "x", errorKind: "failed" } }), true)).toBe(false);
    expect(pickerWantsLoad(input({ entry: live({ role: "viewer" }), rows: undefined }), true)).toBe(false);
  });
});

describe("otherServersForPicker", () => {
  const sv = (id: string, url: string, nickname = id): ServerEntry => ({ id, nickname, url, username: "u", rememberPassword: false });
  it("every server but the active one, one per host key (login wins), A–Z", () => {
    const out = otherServersForPicker(
      [
        sv("a", "https://alpha.k2.dev", "Alpha"),
        sv("a2", "https://ALPHA.k2.dev:443", "Alpha twin"),
        sv("c", "https://charlie.k2.dev", "charlie"),
        sv("b1", "https://bravo.k2.dev", "Bravo"),
        sv("b2", "https://bravo.k2.dev", "Bravo signed"),
      ],
      "a",
      { b2: "tok" },
      (s) => s.nickname
    );
    expect(out.map((s) => s.id)).toEqual(["b2", "c"]);
  });
});
