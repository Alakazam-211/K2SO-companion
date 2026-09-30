/** Line-two descriptor. Baseline chats/projects rows are what the thing
 *  IS (`Sidecar · same workspace, extra chat`, `3 members · this server`),
 *  not a last-message snippet. */

export type OverlayPreviewInput = {
  kind?: "agent" | "group";
  joinMiss?: string | null;
  addr?: string | null;
  mode?: string | null;
  enabled?: boolean | null;
  live?: boolean | null;
  memberCount?: number | null;
};

export function overlayRowPreview(row: OverlayPreviewInput): string {
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
