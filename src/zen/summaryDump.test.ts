import { describe, expect, it } from "vitest";
import { summariseProjectsSummary } from "./summaryDump";

describe("summariseProjectsSummary", () => {
  it("reads a top-level array: status, count, keys, eight name+path samples", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      name: `Agent ${i}`,
      path: `/ws/${i}`,
      color: "#111",
      secret: `LEAK-${i}`,
    }));
    const d = summariseProjectsSummary(200, rows);
    expect(d.status).toBe(200);
    expect(d.top).toBe("array");
    expect(d.rowCount).toBe(10);
    expect(d.rowKeys).toEqual(["id", "name", "path", "color", "secret"]);
    expect(d.samples).toHaveLength(8);
    expect(d.samples[0]).toEqual({ name: "Agent 0", path: "/ws/0" });
    expect(d.samples[7]).toEqual({ name: "Agent 7", path: "/ws/7" });
    expect(JSON.stringify(d)).not.toMatch(/LEAK/);
  });

  it("reads rows from the longest array on an object without dumping other values", () => {
    const d = summariseProjectsSummary(200, {
      ok: true,
      token: "SESSION-SECRET",
      projects: [
        { name: "appa", path: "/Users/Baden/Appa", handle: "appa" },
        { name: "Skin Test A", path: "/Users/Baden/AI Projects/Skin Test A" },
      ],
    });
    expect(d.top).toBe("object keys: ok, token, projects; rows from projects");
    expect(d.rowCount).toBe(2);
    expect(d.rowKeys).toEqual(["name", "path", "handle"]);
    expect(d.samples).toEqual([
      { name: "appa", path: "/Users/Baden/Appa" },
      { name: "Skin Test A", path: "/Users/Baden/AI Projects/Skin Test A" },
    ]);
    expect(JSON.stringify(d)).not.toMatch(/SESSION-SECRET/);
    expect(JSON.stringify(d.samples)).not.toMatch(/handle/);
  });

  it("does not invent name/path when those keys are missing", () => {
    const d = summariseProjectsSummary(200, [{ id: "x", title: "Nope" }]);
    expect(d.samples).toEqual([{ name: "", path: "" }]);
    expect(JSON.stringify(d)).not.toMatch(/Nope/);
  });

  it("reports HTTP status on a failed call without a body", () => {
    const d = summariseProjectsSummary(403, undefined, "HTTP 403");
    expect(d.status).toBe(403);
    expect(d.top).toBe("none");
    expect(d.rowCount).toBeNull();
    expect(d.rowKeys).toEqual([]);
    expect(d.samples).toEqual([]);
    expect(d.note).toBe("HTTP 403");
  });

  it("never copies authorization or token values onto the dump", () => {
    const d = summariseProjectsSummary(200, [
      {
        name: "appa",
        path: "/ws",
        token: "sekrit",
        authorization: "Bearer sekrit",
      },
    ]);
    const blob = JSON.stringify(d);
    expect(blob).not.toMatch(/sekrit/);
    expect(blob).not.toMatch(/Bearer/);
    expect(d.samples[0]).toEqual({ name: "appa", path: "/ws" });
  });
});
