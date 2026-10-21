import { beforeEach, describe, expect, it, vi } from "vitest";

type TapListener = (tap: unknown) => void;
const listeners: Record<string, TapListener> = {};
let launchTap: unknown = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "plugin:k2-push|is_available") return { available: true, platform: "apns" };
    if (cmd === "plugin:k2-push|get_launch_tap") return { tap: launchTap };
    throw new Error(`unexpected ${cmd}`);
  }),
  addPluginListener: vi.fn(async (_plugin: string, event: string, cb: TapListener) => {
    listeners[event] = cb;
    return { unregister: vi.fn() };
  }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("../api/cliAuth", () => ({ cliAuthHeaders: vi.fn(() => ({})) }));
vi.mock("../stores/servers", () => ({
  useServersStore: { getState: () => ({ servers: [], tokens: {}, activeServerId: null }) },
  getActiveServer: vi.fn(() => null),
  onServerForget: vi.fn(() => () => {}),
  onServerLeave: vi.fn(),
}));
vi.mock("../api/client", () => ({
  FEATURE_THREAD_PUSH: "thread-push-v1",
  getBootStatus: vi.fn(async () => null),
}));
vi.mock("./revive", () => ({ connectServer: vi.fn() }));

import { attachPushNavigation, tapPath } from "./push";

beforeEach(() => {
  launchTap = null;
  for (const k of Object.keys(listeners)) delete listeners[k];
});

describe("tapPath", () => {
  it("a ticket tap goes to the Zen ticket deep link", () => {
    expect(tapPath({ kind: "ticket", feedbackId: "fb-1" })).toBe("/zen?ticket=fb-1");
  });

  it("legacy kind feedback still routes, same id field", () => {
    expect(tapPath({ kind: "feedback", feedbackId: "fb-2" })).toBe("/zen?ticket=fb-2");
  });

  it("accepts ticketId and id as the ticket key", () => {
    expect(tapPath({ kind: "ticket", ticketId: "t-3" })).toBe("/zen?ticket=t-3");
    expect(tapPath({ kind: "ticket", id: "t-4" })).toBe("/zen?ticket=t-4");
  });

  it("a ticket tap without an id is ignored", () => {
    expect(tapPath({ kind: "ticket" })).toBeNull();
    expect(tapPath({ kind: "ticket", feedbackId: "  " })).toBeNull();
  });

  it("a project tap opens Zen Projects on that group", () => {
    expect(tapPath({ kind: "project", groupId: "g-1" })).toBe("/zen?project=g-1");
  });

  it("an unknown kind is ignored", () => {
    expect(tapPath({ kind: "thread", feedbackId: "x", groupId: "g" })).toBeNull();
    expect(tapPath({ feedbackId: "x" })).toBeNull();
    expect(tapPath(null)).toBeNull();
  });
});

describe("attachPushNavigation", () => {
  it("routes a cold-start ticket tap to the Zen deep link", async () => {
    launchTap = { kind: "ticket", feedbackId: "cold-1" };
    const navigate = vi.fn();
    await attachPushNavigation(navigate);
    expect(navigate).toHaveBeenCalledWith("/zen?ticket=cold-1");
  });

  it("routes warm ticket and project taps to the Zen deep links", async () => {
    const navigate = vi.fn();
    await attachPushNavigation(navigate);
    expect(navigate).not.toHaveBeenCalled();
    listeners.tap({ kind: "ticket", feedbackId: "warm-1" });
    expect(navigate).toHaveBeenLastCalledWith("/zen?ticket=warm-1");
    listeners.tap({ kind: "feedback", feedbackId: "warm-2" });
    expect(navigate).toHaveBeenLastCalledWith("/zen?ticket=warm-2");
    listeners.tap({ kind: "project", groupId: "g-9" });
    expect(navigate).toHaveBeenLastCalledWith("/zen?project=g-9");
  });

  it("ignores an unknown-kind tap", async () => {
    const navigate = vi.fn();
    await attachPushNavigation(navigate);
    listeners.tap({ kind: "mystery", feedbackId: "x" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
