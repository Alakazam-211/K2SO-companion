import { describe, expect, it } from "vitest";
import { overlayRowPreview } from "./rowPreview";
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
    const a = { addr: "k2so-companion/1", name: "k2so-companion / 1" };
    const b = { addr: "appa/1", name: "appa / 1" };
    // e976d27 rowPreview: every sidecar got the same category sentence.
    const oldA = oldRowPreview(a);
    const oldB = oldRowPreview(b);
    expect(oldA).toBe("Sidecar · same workspace, extra chat");
    expect(oldB).toBe("Sidecar · same workspace, extra chat");
    expect(oldA).toBe(oldB);
    expect(overlayRowPreview(a)).toBe("k2so-companion / 1");
    expect(overlayRowPreview(b)).toBe("appa / 1");
    expect(overlayRowPreview(a)).not.toBe(overlayRowPreview(b));
  });

  it("a main chat says the literal words main chat", () => {
    expect(overlayRowPreview({ addr: "appa", name: "appa" })).toBe("main chat");
    expect(overlayRowPreview({ addr: "manager-2", name: "Skydio" })).toBe("main chat");
  });
});
