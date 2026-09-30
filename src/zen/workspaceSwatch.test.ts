import { describe, expect, it } from "vitest";
import { workspaceColorOf, workspaceIconOf } from "./workspaceSwatch";

describe("workspaceSwatch", () => {
  it("accepts hex and rgb workspace colours", () => {
    expect(workspaceColorOf("#22c55e")).toBe("#22c55e");
    expect(workspaceColorOf("#abc")).toBe("#abc");
    expect(workspaceColorOf("rgb(34, 197, 94)")).toBe("rgb(34, 197, 94)");
    expect(workspaceColorOf("javascript:alert(1)")).toBeNull();
    expect(workspaceColorOf("")).toBeNull();
  });

  it("accepts http(s) and data image icons", () => {
    expect(workspaceIconOf("https://example.k2.dev/a.png")).toBe(
      "https://example.k2.dev/a.png"
    );
    expect(workspaceIconOf("data:image/png;base64,abc")).toMatch(/^data:image\//);
    expect(workspaceIconOf("javascript:alert(1)")).toBeNull();
    expect(workspaceIconOf("/Users/Baden/icon.png")).toBeNull();
  });
});
