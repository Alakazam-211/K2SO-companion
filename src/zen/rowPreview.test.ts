import { describe, expect, it } from "vitest";
import {
  NO_MESSAGES_TEXT,
  SECRET_TEXT,
  TABLE_MARKER,
  lastPreview,
  nodesText,
  overlayRowPreview,
  rowPreviewFor,
  rowPreviewText,
  snippetNodes,
  type RowLast,
} from "./rowPreview";
import { JOIN_NO_PROJECT } from "./agentRow";

/** e976d27 rowPreview. Two sidecars both returned this sentence. */
function oldRowPreview(row: {
  kind?: "agent" | "group";
  joinMiss?: string | null;
  addr?: string | null;
  name?: string | null;
  mode?: string | null;
  enabled?: boolean | null;
  live?: boolean | null;
  memberCount?: number | null;
}): string {
  if (row.kind === "group") {
    const n = row.memberCount ?? 0;
    const members = n === 1 ? "1 member" : `${n} members`;
    return `${members} · this server`;
  }
  if (row.joinMiss) return row.joinMiss;
  const addr = (row.addr || "").trim();
  if (addr.includes("/")) return "Sidecar · same workspace, extra chat";
  const mode = (row.mode || "").trim();
  if (mode === "off" || row.enabled === false) return "Off";
  const kind =
    mode === "k2"
      ? "K2"
      : mode === "manager"
        ? "manager"
        : mode === "custom"
          ? "custom"
          : mode || "canonical";
  if (row.live) return `Live · ${kind}`;
  return kind;
}

describe("overlayRowPreview", () => {
  it("a project chat says Project Chat", () => {
    expect(overlayRowPreview({ kind: "group", name: "K2 Companion" })).toBe(
      "Project Chat"
    );
    expect(overlayRowPreview({ kind: "group", name: "K2" })).toBe("Project Chat");
  });

  it("keeps a join miss as the descriptor", () => {
    expect(overlayRowPreview({ joinMiss: JOIN_NO_PROJECT })).toBe(JOIN_NO_PROJECT);
  });

  it("two different sidecars produce two different lines", () => {
    const a = {
      addr: "k2so-companion/1",
      name: "K2 Companion",
      chatTitle: "1",
    };
    const b = { addr: "appa/1", name: "appa", chatTitle: "1" };
    // e976d27 rowPreview: every sidecar got the same category sentence.
    const oldA = oldRowPreview(a);
    const oldB = oldRowPreview(b);
    expect(oldA).toBe("Sidecar · same workspace, extra chat");
    expect(oldB).toBe("Sidecar · same workspace, extra chat");
    expect(oldA).toBe(oldB);
    // Line 2 is the sidecar's own title, not the workspace name.
    expect(overlayRowPreview(a)).toBe("1");
    expect(overlayRowPreview(b)).toBe("1");
    expect(overlayRowPreview({ addr: "appa/1", name: "appa", chatTitle: "reviewer" })).toBe(
      "reviewer"
    );
    expect(overlayRowPreview(a)).not.toBe(a.name);
    expect(
      overlayRowPreview({ addr: "k2so-companion/1", name: "K2 Companion", chatTitle: "1" })
    ).not.toBe(
      overlayRowPreview({ addr: "appa/reviewer", name: "appa", chatTitle: "reviewer" })
    );
  });

  it("a main chat never says main chat", () => {
    expect(overlayRowPreview({ addr: "appa", name: "appa" })).toBe("");
    expect(overlayRowPreview({ addr: "appa", name: "appa" }, null)).toBe(NO_MESSAGES_TEXT);
    expect(rowPreviewFor({ addr: "manager-2", name: "Skydio" })).toEqual({ kind: "loading" });
  });
});

const msg = (text: string, extra: Partial<RowLast> = {}): RowLast => ({
  at: 10,
  seq: 1,
  mine: false,
  kind: "text",
  text,
  ...extra,
});

describe("row snippet", () => {
  it("an agent's message is the snippet, no prefix", () => {
    expect(overlayRowPreview({ addr: "appa" }, msg("All green."))).toBe("All green.");
  });

  it("the owner's own message reads You:", () => {
    expect(overlayRowPreview({ addr: "appa" }, msg("ship it", { mine: true }))).toBe("You: ship it");
  });

  it("a choice card shows its prompt; a secret card never its content", () => {
    expect(overlayRowPreview({ addr: "appa" }, msg("Deploy now?", { kind: "choice" }))).toBe("Deploy now?");
    expect(
      overlayRowPreview({ addr: "appa" }, msg("STRIPE_KEY sk_live_123", { kind: "secret" }))
    ).toBe(SECRET_TEXT);
  });

  it("a blank message is No messages yet, never a blank line", () => {
    expect(overlayRowPreview({ addr: "appa" }, msg("   \n\n "))).toBe(NO_MESSAGES_TEXT);
  });

  it("inline Markdown is kept as nodes", () => {
    expect(snippetNodes("**bold** and *it* and ~~gone~~ and `x()` and [docs](https://k2.dev)")).toEqual([
      { tag: "strong", children: ["bold"] },
      " and ",
      { tag: "em", children: ["it"] },
      " and ",
      { tag: "del", children: ["gone"] },
      " and ",
      { tag: "code", text: "x()" },
      " and ",
      { tag: "link", children: ["docs"] },
    ]);
  });

  it("snake_case, lone stars and unclosed marks stay literal", () => {
    expect(nodesText(snippetNodes("rename my_var_name to 2 * 3 and **open"))).toBe(
      "rename my_var_name to 2 * 3 and **open"
    );
  });

  it("blocks flatten onto one line: heading bold, list ' · ', quote text, fence first line, no image", () => {
    const nodes = snippetNodes(
      "## Status\n\n> quoted *bit*\n\n1. first\n2. second\n\n![shot](a.png)\n```bash\nnpm test\nnpm run build\n```"
    );
    expect(nodes[0]).toEqual({ tag: "strong", children: ["Status"] });
    expect(nodesText(nodes)).toBe("Status quoted bit first · second npm test");
    expect(nodes).toContainEqual({ tag: "code", text: "npm test" });
  });

  it("a table is the marker, never cells", () => {
    const nodes = snippetNodes("Results:\n\n| k | v |\n| --- | --- |\n| a | 1 |\n\nDone.");
    expect(nodesText(nodes)).toBe(`Results: ${TABLE_MARKER} Done.`);
    expect(nodesText(nodes)).not.toContain("|");
  });

  it("a flat server preview: squashed table and fence still read cleanly", () => {
    expect(nodesText(snippetNodes("See: | k | v | |---|---| | a | 1 |", { flat: true }))).toBe(
      `See: ${TABLE_MARKER}`
    );
    expect(snippetNodes("Run ```ts const x = 1 ``` now", { flat: true })).toEqual([
      "Run ",
      { tag: "code", text: "const x = 1" },
      " now",
    ]);
    // A flat heading cannot know where it ends: hashes go, no bold.
    expect(snippetNodes("# Title then body", { flat: true })).toEqual(["Title then body"]);
  });

  it("whitespace collapses and long text is cut at the source, not mid-row", () => {
    const nodes = snippetNodes(`a   b\t\tc ${"word ".repeat(1000)}`);
    const text = nodesText(nodes);
    expect(text.startsWith("a b c word")).toBe(true);
    expect(text).not.toMatch(/\s{2}|\n/);
    expect(text.length).toBeLessThan(1300);
  });

  it("aria text: label, snippet, empty; loading is empty", () => {
    expect(rowPreviewText({ kind: "loading" })).toBe("");
    expect(rowPreviewText(lastPreview(null))).toBe(NO_MESSAGES_TEXT);
    expect(rowPreviewText(lastPreview(msg("**hi**", { mine: true })))).toBe("You: hi");
  });
});
