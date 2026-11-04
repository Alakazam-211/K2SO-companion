import { describe, expect, it } from "vitest";

import type { GardenPageBody } from "./gardensApi";
import { screensOf } from "./gardenLayout";
import pagePhone from "./goldens/page-phone.json";
import page from "./goldens/page.json";

// K2's slice A goldens (contract rev 2), copied from
// /Users/Shared/k2-companion/gardens-phone/.
describe("K2's page goldens", () => {
  it("opens a Garden's mobile version: listed widgets only, with their height and frame version", () => {
    const screens = screensOf(pagePhone.body as unknown as GardenPageBody);
    expect(screens.map((s) => [s.label, s.full])).toEqual([["Board", true]]);
    expect(screens[0].slots.map((s) => [s.widget.id, s.run, s.height, s.frameVersion])).toEqual([
      ["b1", "frame", "fill", "<frameVersion>"],
    ]);
  });

  it("opens a Garden with no mobile version in its desktop layout", () => {
    const screens = screensOf(page.body as unknown as GardenPageBody);
    expect(screens.flatMap((s) => s.slots.map((slot) => [slot.widget.id, slot.run, slot.height]))).toEqual([
      ["b1", "frame", undefined],
    ]);
  });
});
