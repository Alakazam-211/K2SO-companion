// Change icon sheet: write the workspace look, optimistically.
//
// Patch every Zen row at the workspace path (header, Agents list, pins,
// terminal header, Sessions drawer all read `useZenStore.agents`), send
// `POST /cli/projects/update`, then re-read `/cli/projects/list` so the rows
// carry exactly what the server stored. A refusal puts the old look back.

import { getCliProjectsList, updateProjectLook } from "../api/client";
import { cliProjectOf } from "./agentRow";
import { serverProjectsOf } from "./serverPins";
import {
  iconErrorText,
  withWorkspaceLook,
  type IconTarget,
  type WorkspaceLook,
} from "./workspaceIcon";
import { useZenStore } from "./zenStore";
import { zenScope } from "./zenScope";
import { queueServerAvatars } from "../lib/avatarCache";

/** The `projects/update` body fields for `before` → `next`. Icon `""` clears. */
export function lookUpdateBody(
  before: WorkspaceLook,
  next: WorkspaceLook
): { iconUrl?: string; color?: string } {
  const body: { iconUrl?: string; color?: string } = {};
  if (next.iconUrl !== before.iconUrl) body.iconUrl = next.iconUrl ?? "";
  if (next.color && next.color !== before.color) body.color = next.color;
  return body;
}

export async function saveWorkspaceLook(
  target: IconTarget,
  before: WorkspaceLook,
  next: WorkspaceLook
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = lookUpdateBody(before, next);
  if (body.iconUrl === undefined && body.color === undefined) return { ok: true };
  const shown: WorkspaceLook = {
    iconUrl: next.iconUrl,
    color: body.color ?? before.color,
  };
  const patch = (from: WorkspaceLook, to: WorkspaceLook) =>
    useZenStore.setState((s) => ({ agents: withWorkspaceLook(s.agents, target.path, from, to) }));

  // Captured once: the write and the re-read both go to the room's server.
  const scope = zenScope();
  patch(before, shown);
  let r: Awaited<ReturnType<typeof updateProjectLook>>;
  try {
    r = await updateProjectLook(scope, target.projectId, body);
  } catch (e) {
    r = { ok: false, error: e instanceof Error ? e.message : String(e || "") };
  }
  if (!r.ok) {
    patch(shown, before);
    return { ok: false, error: iconErrorText(r.error, r.status) };
  }

  // Settle on the server's copy (it may have normalised the colour).
  try {
    const list = await getCliProjectsList(scope);
    if (list.ok && Array.isArray(list.data)) {
      queueServerAvatars(scope.id, list.data);
      const raw = (list.data as Record<string, unknown>[]).find(
        (p) => p && typeof p === "object" && p.id === target.projectId
      );
      const row = raw ? cliProjectOf(raw) : null;
      if (row) patch(shown, { iconUrl: row.iconUrl, color: row.color ?? shown.color });
      const projects = serverProjectsOf(list.data);
      if (projects) useZenStore.setState({ serverProjects: projects });
    }
  } catch {
    /* keep the optimistic look */
  }
  return { ok: true };
}
