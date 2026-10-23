// One server's Agents rows, built from its four list reads (multi-server
// MS15 as amended by MA7): `GET /cli/agent/list` (singular),
// `/cli/projects/list`, `/cli/project-group/list` (group rows) and
// `/cli/companion/sessions`, plus that server's remembered sidecars.
//
// Pure: the active server's `hydrateAgents` and the S2 per-server loader
// (`multi/remoteRows.ts`) both call it, so a row looks the same whichever
// server it came from.

import type { ApiResponse } from "../api/client";
import type { ProjectGroup } from "../api/projectGroups";
import {
  cliProjectOf,
  joinAgentsWithProjects,
  ownerAgentOf,
  describeShape,
  parseCliProjects,
  parseOwnerAgents,
  sidecarRowId,
  skinInitials,
} from "./agentRow";
import { NO_CHAT_SESSIONS, chatSessionsOf, type ChatSessions } from "./agentActivity";
import { serverProjectsOf, type ServerProject } from "./serverPins";
import {
  extrasFromRemembered,
  mergeSidecarTitles,
  parseCompanionSessions,
  sidecarSuffix,
  sidecarsFromSessions,
  type OverlaySidecar,
  type RememberedSidecar,
} from "./sidecarRows";
import type { StubAgent } from "./stubData";

export function overlaySidecarAgent(
  side: OverlaySidecar,
  parent?: Pick<StubAgent, "color" | "iconUrl" | "mode" | "enabled" | "live" | "projectId"> | null,
  hostLive = true
): StubAgent {
  return {
    id: sidecarRowId(side.path, side.addr),
    name: side.name,
    initial: skinInitials(side.name),
    path: side.path,
    addr: side.addr,
    joinMiss: null,
    kind: "agent",
    mode: parent?.mode ?? null,
    enabled: parent?.enabled ?? null,
    live: parent?.live ?? null,
    chatTitle: side.chatTitle,
    color: parent?.color ?? null,
    iconUrl: parent?.iconUrl ?? null,
    tabId: side.tabId ?? null,
    projectId: side.projectId ?? parent?.projectId ?? null,
    terminalId: side.terminalId ?? null,
    hostLive,
    ...(side.launch ? { launch: side.launch } : {}),
  };
}

export type ServerRowsInput = {
  rAgents: ApiResponse<unknown>;
  rProjects: ApiResponse<unknown>;
  rGroups: ApiResponse<ProjectGroup[]>;
  rSessions: ApiResponse<unknown>;
  /** This server's remembered sidecars (`readRememberedSidecars(id)`). */
  remembered: RememberedSidecar[];
};

export type ServerRowsResult =
  | {
      ok: true;
      /** Group rows first, then workspace rows and sidecars. */
      agents: StubAgent[];
      serverProjects: ServerProject[];
      chatSessions: ChatSessions;
      /** What to write back as this server's remembered sidecars. */
      remember: RememberedSidecar[];
      /** Partial failures, shown under the list. */
      notices: string[];
    }
  | { ok: false; error: string };

/** What an unreadable answer was: its shape, then status, content type and
 *  server when known (K2 2026-10-23: a K2 box never sends these shapes,
 *  so this says what did). */
function answerOf(r: ApiResponse<unknown>): string {
  const m = r.meta;
  const how = m ? [`HTTP ${m.status}`, m.contentType || "no content type", m.via ? `via ${m.via}` : ""].filter(Boolean).join(", ") : "";
  return how ? `${describeShape(r.data)}; ${how}` : describeShape(r.data);
}

/** Fold one server's list reads into its rows. Every read may fail on its
 *  own; only all-empty is an error. */
export function buildServerRows(input: ServerRowsInput): ServerRowsResult {
  const { rAgents, rProjects, rGroups, rSessions } = input;
  const notices: string[] = [];
  let fleet: {
    name: string;
    path: string;
    mode: string | null;
    enabled: boolean | null;
    live: boolean | null;
  }[] = [];
  let book: { name: string; path: string; handle: string | null }[] = [];

  if (!rAgents.ok) {
    notices.push(rAgents.error || "GET /cli/agent/list failed");
  } else {
    const parsed = parseOwnerAgents(rAgents.data);
    if (!parsed) {
      notices.push(
        `This server's agent list came back in a form the app can't read (${answerOf(rAgents)}). ` +
          "Check that the address is your K2 server; if it is, the server may need an update. (GET /cli/agent/list)"
      );
    } else {
      for (const raw of parsed) {
        const row = ownerAgentOf(raw);
        if (row)
          fleet.push({
            name: row.name,
            path: row.path,
            mode: row.mode,
            enabled: row.enabled,
            live: row.live,
          });
      }
    }
  }

  let serverProjects: ServerProject[] = [];
  if (!rProjects.ok) {
    notices.push(rProjects.error || "GET /cli/projects/list failed");
  } else {
    serverProjects = serverProjectsOf(rProjects.data) ?? [];
    const parsed = parseCliProjects(rProjects.data);
    if (!parsed) {
      notices.push(
        `This server's workspace list came back in a form the app can't read (${answerOf(rProjects)}). ` +
          "Check that the address is your K2 server; if it is, the server may need an update. (GET /cli/projects/list)"
      );
    } else {
      for (const raw of parsed) {
        const row = cliProjectOf(raw);
        if (row) book.push(row);
      }
    }
  }

  const groups: StubAgent[] = [];
  if (!rGroups.ok) {
    notices.push(rGroups.error || "GET /cli/project-group/list failed");
  } else {
    for (const g of rGroups.data ?? []) {
      if (!g?.id || !g.name) continue;
      groups.push(groupAgentRow(g));
    }
  }

  if (fleet.length === 0 && book.length === 0 && groups.length === 0) {
    return {
      ok: false,
      error: notices[0] || "No agents on this list. This overlay does not invent a mapping.",
    };
  }

  const joined = joinAgentsWithProjects(fleet, book);
  let mapped: StubAgent[] = joined.map((row) => ({
    id: row.id,
    name: row.name,
    initial: skinInitials(row.name),
    path: row.path,
    addr: row.addr,
    joinMiss: row.joinMiss,
    kind: "agent" as const,
    mode: row.mode,
    enabled: row.enabled,
    live: row.live,
    chatTitle: row.chatTitle,
    color: row.color,
    iconUrl: row.iconUrl,
  }));
  const haveAddr = new Set(
    mapped.map((a) => (a.addr || "").trim()).filter(Boolean)
  );
  const mains = joined.filter(
    (r) => r.addr && !r.addr.includes("/") && !r.joinMiss
  );
  let chatSessions = NO_CHAT_SESSIONS;
  if (rSessions.ok) {
    const parsed = parseCompanionSessions(rSessions.data);
    if (parsed) {
      chatSessions = chatSessionsOf(parsed);
      const sides = sidecarsFromSessions(parsed, mains);
      for (const side of sides) {
        if (haveAddr.has(side.addr)) continue;
        haveAddr.add(side.addr);
        const parent = mapped.find((m) => m.path === side.path);
        mapped.push(overlaySidecarAgent(side, parent, true));
      }
      mapped = mergeSidecarTitles(mapped, sides);
    } else {
      notices.push(
        "GET /cli/companion/sessions returned an unrecognised shape. Sidecars were not listed."
      );
    }
  } else {
    notices.push(rSessions.error || "GET /cli/companion/sessions failed");
  }
  for (const side of extrasFromRemembered(
    input.remembered,
    haveAddr,
    mains
  )) {
    const parent = mapped.find((m) => m.path === side.path);
    mapped.push(overlaySidecarAgent(side, parent, false));
  }
  const remember: RememberedSidecar[] = mapped
      .filter((a) => (a.addr || "").includes("/") && (a.path || "").trim())
      .map((a) => ({
        addr: (a.addr || "").trim(),
        path: (a.path || "").trim(),
        name: a.name,
        chatTitle: a.chatTitle || sidecarSuffix(a.addr || ""),
      }));
  const agents: StubAgent[] = [...groups, ...mapped];
  return {
    ok: true,
    agents,
    serverProjects,
    chatSessions,
    remember,
    notices,
  };
}

/** A project group as a chat row (`kind: "group"`). */
export function groupAgentRow(g: {
  id: string;
  name: string;
  memberCount?: number | null;
  color?: string | null;
}): StubAgent {
  return {
    id: `group:${g.id}`,
    name: g.name,
    initial: skinInitials(g.name),
    addr: null,
    joinMiss: null,
    kind: "group",
    groupId: g.id,
    memberCount: g.memberCount ?? 0,
    // The group's own colour (project settings); its image is fetched
    // per group by GroupChatAvatar.
    color: g.color ?? null,
    iconUrl: null,
  };
}
