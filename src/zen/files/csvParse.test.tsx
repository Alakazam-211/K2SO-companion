// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { parseDelimited } from "./csvParse";
import { CsvView } from "./CsvView";

afterEach(() => cleanup());

describe("parseDelimited", () => {
  it("splits rows and fields", () => {
    expect(parseDelimited("a,b\n1,2\n").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quotes, doubled quotes, embedded commas and newlines", () => {
    const { rows } = parseDelimited('name,note\n"Smith, J","said ""hi""\nthen left"\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
    ]);
  });

  it("handles CRLF and a missing final newline", () => {
    expect(parseDelimited("a,b\r\n1,2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty fields and parses TSV", () => {
    expect(parseDelimited("a\t\tc", { delimiter: "\t" }).rows).toEqual([["a", "", "c"]]);
  });

  it("caps rows and flags truncation", () => {
    const r = parseDelimited("h\n1\n2\n3\n", { maxRows: 2 });
    expect(r.rows).toEqual([["h"], ["1"]]);
    expect(r.truncated).toBe(true);
  });

  it("empty input → no rows", () => {
    expect(parseDelimited("")).toEqual({ rows: [], truncated: false });
  });
});

describe("CsvView", () => {
  it("renders a table with a sticky-header thead and numbered rows", () => {
    render(<CsvView content={"city,pop\nDayton,137000\nAkron,190000\n"} filePath="/ws/c.csv" />);
    const table = screen.getByTestId("file-csv").querySelector("table")!;
    const heads = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(heads).toEqual(["#", "city", "pop"]);
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent)
    );
    expect(rows).toEqual([
      ["2", "Dayton", "137000"],
      ["3", "Akron", "190000"],
    ]);
    // Sticky header + both-axis scroll live in the viewer sheet.
    expect(table.className).toContain("fv-table");
    expect(screen.getByTestId("file-csv").className).toContain("overflow-auto");
    expect(screen.getByText(/3 rows · 2 cols · CSV/)).toBeTruthy();
  });

  it("pads ragged rows and reads TSV", () => {
    render(<CsvView content={"a\tb\tc\n1\n"} filePath="/ws/t.tsv" />);
    const cells = Array.from(document.querySelectorAll("tbody td")).map((td) => td.textContent);
    expect(cells).toEqual(["2", "1", "", ""]);
    expect(screen.getByText(/TSV/)).toBeTruthy();
  });

  it("an empty file says so", () => {
    render(<CsvView content="" filePath="/ws/e.csv" />);
    expect(screen.getByText("Empty CSV file")).toBeTruthy();
  });
});
