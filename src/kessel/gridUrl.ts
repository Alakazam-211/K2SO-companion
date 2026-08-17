// Grid-WS URL + attach policy.
//
// Two origins, do not smash them together:
//   Connect / daemon (`getBaseUrl()` today) → `/cli/sessions/grid`
//     with the Connect `/cli/auth/login` token.
//   Companion tunnel (capabilities `gridProto:["k1"]` + a companion
//     token) → `/companion/sessions/grid` with the `/companion/auth`
//     token. Never put the Connect token on that route (PR0 401s it).
//
// Both attach Watch-default: send nothing that claims.

import { supportsK1Grid } from "./capabilities";

export const COMPANION_GRID_PATH = "/companion/sessions/grid";
export const CLI_GRID_PATH = "/cli/sessions/grid";

export type GridRoute = "companion" | "cli";
export type GridAttach = "watch" | "legacy-claim";

export interface GridDial {
  route: GridRoute;
  attach: "watch";
  tokenKind: "connect" | "companion";
}

/** Pick the grid dial from the capabilities probe + companion token.
 *  Probe miss / 404 / no companion token → Connect `/cli` Watch. */
export function chooseGridDial(opts: {
  capabilities: unknown;
  companionToken?: string | null;
}): GridDial {
  const companionToken = (opts.companionToken ?? "").trim();
  if (supportsK1Grid(opts.capabilities) && companionToken) {
    return { route: "companion", attach: "watch", tokenKind: "companion" };
  }
  return { route: "cli", attach: "watch", tokenKind: "connect" };
}

/** Build the grid WebSocket URL. Companion route requires a companion
 *  token — returns null rather than stamp a Connect token on it. */
export function buildGridWsUrl(
  baseHttp: string,
  sessionId: string,
  token: string,
  route: GridRoute = "cli",
): string | null {
  if (route === "companion" && !token) return null;
  const base = baseHttp.replace(/^http/, "ws");
  const path = route === "companion" ? COMPANION_GRID_PATH : CLI_GRID_PATH;
  return (
    `${base}${path}` +
    `?session=${encodeURIComponent(sessionId)}` +
    `&token=${encodeURIComponent(token)}` +
    `&proto=k1`
  );
}

/**
 * Frames sent on WS open.
 * Watch-default: send nothing that claims — no set_mode, no
 * set_active, no cols/rows. `legacy-claim` is Drive-era only; it is
 * not the capabilities-miss path.
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

/** Size/claim frames are Drive-only. Watch emits none — including after
 *  a daemon `mode:claimer` on a Connect-owner socket. Caller must pass
 *  a measured fit; never the 80×24 spawn fallback. */
export function claimWireActions(
  drive: boolean,
  cols: number,
  rows: number,
): unknown[] {
  if (!drive || cols <= 0 || rows <= 0) return [];
  return [
    { action: "set_active", active: true, cols, rows },
    { action: "resize", cols, rows },
  ];
}

export function releaseWireActions(drive: boolean): unknown[] {
  if (!drive) return [];
  return [{ action: "set_active", active: false }];
}

export function claimPinWireActions(
  drive: boolean,
  cols: number,
  rows: number,
): unknown[] {
  if (!drive || cols <= 0 || rows <= 0) return [];
  return [{ action: "claim_pin", cols, rows }];
}
