// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChatMessageBody } from "./ChatMessage";

const SITREP = [
  "| | Item | Status |",
  "|---|---|---|",
  "| ✅ | Add-workspace fix, passports, DB fixes, App doors, split view default, pg_restore, GitHub setup card, signer hardening | on main, pushed |",
  "| ✅ | Client CI pieces, **off by default** (`ciPreview`) | on main, pushed |",
].join("\n");

let wrapWidth = 330;

beforeAll(() => {
  // jsdom has no layout or canvas: a 7px-per-character font and a fixed
  // wrapper width.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        measureText: (t: string) => ({ width: t.length * 7 }),
      }) as unknown as CanvasRenderingContext2D
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("chat-md-table-wrap") ? wrapWidth : 0;
    },
  });
});

afterEach(cleanup);

describe("BalancedTable in a chat message", () => {
  it("wraps the table and gives it balanced fixed column widths", () => {
    wrapWidth = 330;
    const { container } = render(<ChatMessageBody text={SITREP} />);
    const wrap = container.querySelector(".chat-md-table-wrap");
    const table = wrap?.querySelector("table");
    expect(table).not.toBeNull();
    expect(table!.style.tableLayout).toBe("fixed");
    const cols = Array.from(table!.querySelectorAll("colgroup[data-balanced] col")) as HTMLElement[];
    expect(cols).toHaveLength(3);
    const widths = cols.map((c) => parseFloat(c.style.width));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(330, 3);
    // Status fits "pushed" on a line: never one letter wide.
    expect(widths[2]).toBeGreaterThanOrEqual(6 * 7);
  });

  it("leaves a table that fits alone", () => {
    wrapWidth = 330;
    const { container } = render(<ChatMessageBody text={"| a | b |\n|---|---|\n| c | d |"} />);
    const table = container.querySelector("table")!;
    expect(table.style.tableLayout).toBe("");
    expect(table.querySelector("colgroup[data-balanced]")).toBeNull();
  });
});
