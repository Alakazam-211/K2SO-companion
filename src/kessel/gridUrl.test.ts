import { describe, expect, it } from "vitest";

import {
  COMPANION_GRID_PATH,
  attachOpenActions,
  buildGridWsUrl,
} from "./gridUrl";

describe("buildGridWsUrl", () => {
  it("opens the companion k1 route with query token (default)", () => {
    expect(
      buildGridWsUrl("https://box.k2.dev", "sess-1", "tok&x"),
    ).toBe(
      "wss://box.k2.dev/companion/sessions/grid?session=sess-1&token=tok%26x&proto=k1",
    );
    expect(COMPANION_GRID_PATH).toBe("/companion/sessions/grid");
  });

  it("keeps the legacy /cli/sessions/grid path for today's painter", () => {
    expect(
      buildGridWsUrl("http://127.0.0.1:8080", "abc", "t", "cli"),
    ).toBe(
      "ws://127.0.0.1:8080/cli/sessions/grid?session=abc&token=t&proto=k1",
    );
  });
});

describe("attachOpenActions", () => {
  it("sends nothing that claims on Watch-default attach", () => {
    expect(attachOpenActions("watch", { cols: 80, rows: 24 })).toEqual([]);
    expect(attachOpenActions("watch", null)).toEqual([]);
  });

  it("preserves today's claimer-on-open for the legacy painter", () => {
    expect(attachOpenActions("legacy-claim", { cols: 40, rows: 12 })).toEqual([
      { action: "set_mode", mode: "claimer" },
      { action: "set_active", active: true, cols: 40, rows: 12 },
      { action: "resize", cols: 40, rows: 12 },
    ]);
    expect(attachOpenActions("legacy-claim", null)).toEqual([
      { action: "set_mode", mode: "claimer" },
    ]);
  });
});
