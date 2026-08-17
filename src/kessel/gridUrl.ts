// Companion k1 grid-WS URL. Query `token=` is the only JS client path
// (WebSocket cannot set Authorization).

export const COMPANION_GRID_PATH = "/companion/sessions/grid";
export const LEGACY_CLI_GRID_PATH = "/cli/sessions/grid";

export type GridRoute = "companion" | "cli";
export type GridAttach = "watch" | "legacy-claim";

/** Build the grid WebSocket URL. Default route is the public companion path. */
export function buildGridWsUrl(
  baseHttp: string,
  sessionId: string,
  token: string,
  route: GridRoute = "companion",
): string {
  const base = baseHttp.replace(/^http/, "ws");
  const path = route === "cli" ? LEGACY_CLI_GRID_PATH : COMPANION_GRID_PATH;
  return (
    `${base}${path}` +
    `?session=${encodeURIComponent(sessionId)}` +
    `&token=${encodeURIComponent(token)}` +
    `&proto=k1`
  );
}

/**
 * Frames sent on WS open.
 * Watch-default (PRD D3): send nothing that claims — no set_mode,
 * no set_active, no cols/rows. Server identity starts as viewer.
 */
export function attachOpenActions(
  attach: GridAttach,
  claimDims: { cols: number; rows: number } | null,
): unknown[] {
  if (attach === "watch") return [];
  const out: unknown[] = [{ action: "set_mode", mode: "claimer" }];
  if (claimDims) {
    out.push({
      action: "set_active",
      active: true,
      cols: claimDims.cols,
      rows: claimDims.rows,
    });
    out.push({ action: "resize", cols: claimDims.cols, rows: claimDims.rows });
  }
  return out;
}
