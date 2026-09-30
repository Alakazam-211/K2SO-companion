/** Line-two descriptor. Three cases only: main chat, the sidecar's
 *  own title, Project Chat. Not mode/kind, not a category label. */

export type OverlayPreviewInput = {
  kind?: "agent" | "group";
  joinMiss?: string | null;
  addr?: string | null;
  name?: string | null;
};

export function overlayRowPreview(row: OverlayPreviewInput): string {
  if (row.kind === "group") return "Project Chat";
  if (row.joinMiss) return row.joinMiss;
  const addr = (row.addr || "").trim();
  if (addr.includes("/")) {
    const title = (row.name || "").trim();
    return title || addr;
  }
  return "main chat";
}
