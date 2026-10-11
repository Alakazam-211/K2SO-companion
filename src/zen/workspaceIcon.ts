// Change icon sheet (Zen chat header avatar): pure helpers.
//
// Desktop K2 stores one icon per workspace (`projects.icon_url`), shown for
// the workspace's agent and inherited by its sidecar chats. Desktop's
// Settings → Workspaces picker offers Upload (crop to a square, 128px PNG),
// Detect (favicon/logo in the repo) and Remove, plus a colour palette. No
// emoji or built-in icon set. Writes:
//   POST /cli/projects/update {id, iconUrl: "data:image/…"}  (Member)
//   POST /cli/projects/update {id, iconUrl: ""}  clears (same as clear-icon)
// The daemon checks no format or size; the icon rides every
// /cli/projects/list row, so the phone keeps it small.

import { canCreateWorkspace } from "./newWorkspace";
import { mainAtPath, pinProjectIdForRow, type ServerProject } from "./serverPins";
import { isOverlayExtraAddr } from "./overlayExtras";
import { posixNormalize } from "./workspacePath";
import type { StubAgent } from "./stubData";

/** Square output edge. Desktop saves 128px; 256 stays sharp at 3x. */
export const ICON_PX = 256;
/** Prefer PNG up to this many data-URL chars, then try JPEG. */
export const ICON_BUDGET_CHARS = 160 * 1024;
/** Refuse above this (the icon is sent with every projects/list row). */
export const ICON_MAX_CHARS = 512 * 1024;
/** JPEG qualities tried in order once PNG is over budget. */
export const ICON_JPEG_QUALITIES = [0.85, 0.7, 0.55] as const;

/** `projects/update` is Member in K2 `route_policy.rs`. */
export const ICON_ROLE = "member";

/** Can this whoami change workspace icons? Unknown role is allowed (the
 *  daemon has the last word); a known role below Member is not. */
export function canChangeIcon(
  identity: { owner?: boolean; role?: string | null } | null
): boolean {
  return canCreateWorkspace(identity, ICON_ROLE);
}

/** Centre square crop of a `w`×`h` image. */
export function centreSquare(w: number, h: number): { sx: number; sy: number; side: number } {
  const side = Math.max(0, Math.min(w, h));
  return { sx: Math.max(0, (w - side) / 2), sy: Math.max(0, (h - side) / 2), side };
}

export type IconCanvas = {
  width: number;
  height: number;
  getContext(kind: "2d"): Pick<CanvasRenderingContext2D, "drawImage" | "clearRect"> | null;
  toDataURL(type?: string, quality?: number): string;
};

/** Encode the canvas: PNG when it fits the budget, else the first JPEG
 *  quality that does, else the smallest if under the hard cap. */
export function encodeIcon(canvas: Pick<IconCanvas, "toDataURL">): string {
  const png = canvas.toDataURL("image/png");
  if (png.startsWith("data:image/png") && png.length <= ICON_BUDGET_CHARS) return png;
  let best = png.startsWith("data:image/") ? png : "";
  for (const q of ICON_JPEG_QUALITIES) {
    const jpg = canvas.toDataURL("image/jpeg", q);
    if (!jpg.startsWith("data:image/jpeg")) continue;
    if (jpg.length <= ICON_BUDGET_CHARS) return jpg;
    if (!best || jpg.length < best.length) best = jpg;
  }
  if (best && best.length <= ICON_MAX_CHARS) return best;
  throw new Error("That image is too large for an icon");
}

export type IconImage = { width: number; height: number; source: CanvasImageSource };

export type IconDeps = {
  readAsDataUrl: (file: Blob) => Promise<string>;
  loadImage: (src: string) => Promise<IconImage>;
  makeCanvas: () => IconCanvas;
};

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read that image"));
    reader.onerror = () => reject(new Error("Could not read that image"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<IconImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, source: img });
    img.onerror = () => reject(new Error("That file is not an image this phone can open"));
    img.src = src;
  });
}

const DOM_DEPS: IconDeps = {
  readAsDataUrl,
  loadImage,
  makeCanvas: () => document.createElement("canvas") as unknown as IconCanvas,
};

/** Picked file → centre-cropped `ICON_PX` square data URL. */
export async function iconFromFile(file: Blob, deps: IconDeps = DOM_DEPS): Promise<string> {
  if (file.type && !file.type.startsWith("image/")) throw new Error("Pick an image");
  const src = await deps.readAsDataUrl(file);
  const img = await deps.loadImage(src);
  if (!img.width || !img.height) throw new Error("That image is empty");
  const { sx, sy, side } = centreSquare(img.width, img.height);
  const canvas = deps.makeCanvas();
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This phone cannot resize images");
  ctx.clearRect(0, 0, ICON_PX, ICON_PX);
  ctx.drawImage(img.source, sx, sy, side, side, 0, 0, ICON_PX, ICON_PX);
  return encodeIcon(canvas);
}

/** The workspace an agent row's icon belongs to. A sidecar chat edits its
 *  parent workspace (one icon per workspace). Null: group, unmatched row. */
export type IconTarget = { projectId: string; path: string; name: string };

export function iconTargetFor(
  row: StubAgent | null | undefined,
  projects: ServerProject[]
): IconTarget | null {
  if (!row || row.kind === "group" || !row.path) return null;
  const main = mainAtPath(row.path, projects);
  const id = isOverlayExtraAddr(row.addr) ? main?.id ?? null : pinProjectIdForRow(row, projects);
  if (!id) return null;
  const project = projects.find((p) => p.id === id) ?? main;
  const path = posixNormalize(row.path.trim()) ?? row.path;
  return { projectId: id, path, name: (project?.name || row.name || "").trim() || row.name };
}

export type WorkspaceLook = { iconUrl: string | null; color: string | null };

function samePath(a: string | undefined, key: string): boolean {
  if (!a) return false;
  return (posixNormalize(a.trim()) ?? a) === key;
}

/** The look the workspace shows now: its main chat row, else `row`. */
export function workspaceLookOf(
  agents: StubAgent[],
  path: string,
  row?: StubAgent | null
): WorkspaceLook {
  const key = posixNormalize(path.trim()) ?? path;
  const main = agents.find(
    (a) => a.kind !== "group" && samePath(a.path, key) && !isOverlayExtraAddr(a.addr)
  );
  const src = main ?? row ?? null;
  return { iconUrl: src?.iconUrl ?? null, color: src?.color ?? null };
}

/** Rows at the workspace path still showing `from` move to `to`. A sidecar
 *  with its own icon keeps it. Used for optimistic save and rollback. */
export function withWorkspaceLook(
  agents: StubAgent[],
  path: string,
  from: WorkspaceLook,
  to: WorkspaceLook
): StubAgent[] {
  const key = posixNormalize(path.trim()) ?? path;
  let changed = false;
  const out = agents.map((a) => {
    if (a.kind === "group" || !samePath(a.path, key)) return a;
    const icon = (a.iconUrl ?? null) === from.iconUrl ? to.iconUrl : a.iconUrl ?? null;
    const color = (a.color ?? null) === from.color ? to.color : a.color ?? null;
    if (icon === (a.iconUrl ?? null) && color === (a.color ?? null)) return a;
    changed = true;
    return { ...a, iconUrl: icon, color };
  });
  return changed ? out : agents;
}

/** Inline error for a refused write. */
export function iconErrorText(error: string | undefined, status?: number): string {
  const e = (error || "").trim();
  if (e === "role_required" || status === 403) {
    return "Your account can’t change icons on this server.";
  }
  if (status === 413) return "That image is too large for the server";
  return e || "Could not save the icon";
}
