import { describe, expect, it } from "vitest";

import { supportsK1Grid } from "./capabilities";
import {
  CLI_GRID_PATH,
  COMPANION_GRID_PATH,
  attachOpenActions,
  buildGridWsUrl,
  chooseGridDial,
} from "./gridUrl";

describe("chooseGridDial", () => {
  it("uses Connect /cli Watch when capabilities miss (never legacy-claim)", () => {
    expect(supportsK1Grid(undefined)).toBe(false);
    expect(chooseGridDial({ capabilities: undefined, companionToken: "" })).toEqual({
      route: "cli",
      attach: "watch",
      tokenKind: "connect",
    });
    expect(chooseGridDial({ capabilities: {}, companionToken: "ctok" })).toEqual({
      route: "cli",
      attach: "watch",
      tokenKind: "connect",
    });
    expect(chooseGridDial({ capabilities: { gridProto: [] } })).toEqual({
      route: "cli",
      attach: "watch",
      tokenKind: "connect",
    });
  });

  it("does not put a Connect token on the companion route when k1 is live but no companion token", () => {
    expect(
      chooseGridDial({
        capabilities: { gridProto: ["k1"] },
        companionToken: "",
      }),
    ).toEqual({ route: "cli", attach: "watch", tokenKind: "connect" });
  });

  it("uses companion Watch only when k1 is advertised AND a companion token exists", () => {
    expect(
      chooseGridDial({
        capabilities: { gridProto: ["k1"] },
        companionToken: "companion-tok",
      }),
    ).toEqual({
      route: "companion",
      attach: "watch",
      tokenKind: "companion",
    });
  });
});

describe("buildGridWsUrl", () => {
  it("defaults to Connect /cli/sessions/grid with the Connect token", () => {
    expect(
      buildGridWsUrl("http://127.0.0.1:8080", "abc", "connect-tok"),
    ).toBe(
      "ws://127.0.0.1:8080/cli/sessions/grid?session=abc&token=connect-tok&proto=k1",
    );
    expect(CLI_GRID_PATH).toBe("/cli/sessions/grid");
  });

  it("opens the companion k1 route only with a companion token", () => {
    expect(
      buildGridWsUrl("https://box.k2.dev", "sess-1", "tok&x", "companion"),
    ).toBe(
      "wss://box.k2.dev/companion/sessions/grid?session=sess-1&token=tok%26x&proto=k1",
    );
    expect(COMPANION_GRID_PATH).toBe("/companion/sessions/grid");
    expect(buildGridWsUrl("https://box.k2.dev", "sess-1", "", "companion")).toBe(
      null,
    );
  });
});

describe("attachOpenActions", () => {
  it("sends nothing that claims on Watch-default attach", () => {
    expect(attachOpenActions("watch", { cols: 80, rows: 24 })).toEqual([]);
    expect(attachOpenActions("watch", null)).toEqual([]);
  });
});
