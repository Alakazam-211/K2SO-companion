// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { HOME_GRID_KEY, homeGridLabel, homeGridSize, readHomeGrid, useHomeGridStore } from "./homeGrid";

beforeEach(() => {
  localStorage.clear();
  useHomeGridStore.setState({ sizes: {} });
});

describe("the Home tab's top grid size (per Home, this phone)", () => {
  it("is 9 unless set; Off is 0", () => {
    expect(homeGridSize({}, "h1")).toBe(9);
    expect(homeGridSize({ h1: 0 }, "h1")).toBe(0);
    expect(homeGridSize({ h1: 3 }, null)).toBe(9);
    expect(homeGridLabel(0)).toBe("Off");
    expect(homeGridLabel(6)).toBe("6");
  });

  it("stores only non-default choices, and reads back only valid ones", () => {
    useHomeGridStore.getState().setSize("h1", 3);
    useHomeGridStore.getState().setSize("h2", 0);
    useHomeGridStore.getState().setSize("h3", 9);
    expect(JSON.parse(localStorage.getItem(HOME_GRID_KEY) ?? "")).toEqual({ h1: 3, h2: 0 });
    localStorage.setItem(HOME_GRID_KEY, JSON.stringify({ a: 6, b: 4, c: "3", d: 0 }));
    expect(readHomeGrid()).toEqual({ a: 6, d: 0 });
    localStorage.setItem(HOME_GRID_KEY, "[1]");
    expect(readHomeGrid()).toEqual({});
  });
});
