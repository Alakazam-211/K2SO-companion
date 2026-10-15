// Add Agent → Other servers, one server's section body (HM5, S3b; desktop
// `HomeAddPanels.tsx` `FromServerList` + `SectionStatus`). Only rendered
// with `zen.multiServer` on.
//
// It lists THAT server's agents from `multi/remoteRows`, which reads them
// on the server's own scope with its own saved login — never a switch,
// never the active server (MS7, MS32). Loads share the 4-server cap
// (`MAX_SERVER_LOADS`). The section shows loading, offline (Retry), sign
// in (that server's sheet, no switch), no access, needs an update (the
// floor) or failed (Retry). Tapping a row adds `{handle::hostKey,
// workspaceId, label}` to the Home; tapping a checked row removes it. It
// never creates a workspace.

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { serverHostKey, useServersStore, type ServerEntry } from "../../stores/servers";
import { CandidateRow } from "../AddAgentSheet";
import { homeHasAddress, type Home, type HomeRow } from "../homes";
import { candidateMatches, homeRowFor, isHomeCandidate } from "../homeView";
import { workspaceIdForRow } from "./merge";
import { pickerSectionState, pickerWantsLoad, type PickerSection } from "./homePicker";
import { usePoolEntries } from "./pool";
import { ensureRemoteIcon, remoteIconFor, useRemoteIcons } from "./remoteIcons";
import { loadServerRows, rowsStale, useRemoteRows } from "./remoteRows";

const MUTED = "#8e8e93";

function SectionStatus({
  serverId,
  state,
  label,
  onSignIn,
  onRetry,
}: {
  serverId: string;
  state: Exclude<PickerSection, { kind: "ok" }>;
  label: string;
  onSignIn: () => void;
  onRetry: () => void;
}) {
  const action =
    state.kind === "signin"
      ? { text: "Sign in", aria: `Sign in to ${label}`, run: onSignIn }
      : state.kind === "offline" || state.kind === "failed"
        ? { text: "Retry", aria: `Retry ${label}`, run: onRetry }
        : null;
  const detail = state.kind === "too-old" ? state.detail : state.kind === "signin" ? state.detail : null;
  return (
    <div
      className="k2-tile k2-tile-raised flex items-center"
      style={{ margin: "0 12px", padding: "10px 14px", borderRadius: 12, gap: 10 }}
      data-testid={`add-agent-server-status-${serverId}`}
      data-state={state.kind}
    >
      <p
        className="flex-1 min-w-0 text-[14px] break-words"
        style={{ color: state.kind === "failed" ? "#ff9f0a" : MUTED }}
        title={detail ?? undefined}
      >
        {state.copy}
      </p>
      {action ? (
        <button
          type="button"
          className="shrink-0 zen-glass zen-glass-pill text-[14px] font-semibold"
          style={{ minHeight: 32, padding: "0 12px", color: "#0a84ff" }}
          aria-label={action.aria}
          data-testid={`add-agent-server-action-${serverId}`}
          onClick={action.run}
        >
          {action.text}
        </button>
      ) : null}
    </div>
  );
}

export function OtherServerSection({
  server,
  label,
  q,
  home,
  signingIn,
  onAdd,
  onRemove,
  onSignIn,
  onRetry,
}: {
  server: ServerEntry;
  label: string;
  q: string;
  home: Home;
  /** That server's own sign-in sheet is open. */
  signingIn: boolean;
  onAdd: (row: HomeRow) => void;
  /** Uncheck: take this address off the Home. */
  onRemove: (address: string) => void;
  /** Open sign-in for THIS server (no switch). */
  onSignIn: () => void;
  /** Re-check this server and re-read its lists. */
  onRetry: () => void;
}) {
  const hasLogin = useServersStore(useShallow((s) => (s.tokens[server.id] ?? "").length > 0));
  const entry = usePoolEntries()[server.id];
  const rows = useRemoteRows((s) => s.byServer[server.id]);
  const icons = useRemoteIcons((s) => s.icons);
  const input = { label, hasLogin, signingIn, entry, rows };
  const state = pickerSectionState(input);
  const hostKey = serverHostKey(server);

  // Ask this server for its lists when they are missing or old. Never on
  // its own after a failed read (Retry does that), so a dead server is not
  // asked again on every render.
  const wants = pickerWantsLoad(input, rowsStale(rows, Date.now()));
  useEffect(() => {
    if (wants) void loadServerRows(server.id);
  }, [wants, server.id]);

  // MA24: pictures for rows with no `iconUrl`, asked of THIS server while
  // it is live with a good login.
  const healthy = !!entry && entry.reach === "live" && entry.auth === "ok";
  const agents = state.kind === "ok" ? state.agents : null;
  const projects = state.kind === "ok" ? state.projects : null;
  useEffect(() => {
    if (!healthy || !agents || !projects) return;
    for (const a of agents) {
      if (!isHomeCandidate(a) || a.iconUrl) continue;
      void ensureRemoteIcon(server.id, workspaceIdForRow(a, projects), a.path);
    }
  }, [healthy, agents, projects, server.id]);

  if (state.kind !== "ok") {
    return (
      <SectionStatus serverId={server.id} state={state} label={label} onSignIn={onSignIn} onRetry={onRetry} />
    );
  }
  const candidates = state.agents.filter(isHomeCandidate);
  const shown = candidates.filter((a) => candidateMatches(a, q));
  if (shown.length === 0) {
    return (
      <p className="text-[14px]" style={{ color: MUTED, padding: "4px 16px 8px" }}
        data-testid={`add-agent-server-empty-${server.id}`}>
        {candidates.length === 0 ? "No agents" : "No matches."}
      </p>
    );
  }
  return (
    <div data-testid={`add-agent-server-list-${server.id}`}>
      {shown.map((a) => {
        const row = homeRowFor(a, hostKey, state.projects);
        const added = !!row && homeHasAddress(home, row.address);
        return (
          <CandidateRow
            key={a.id}
            agent={a}
            iconUrl={a.iconUrl || remoteIconFor(icons, server.id, workspaceIdForRow(a, state.projects))}
            homeName={home.name}
            added={added}
            disabled={!row}
            testId={`add-agent-row-${server.id}:${a.id}`}
            onAdd={() => {
              if (row) onAdd(row);
            }}
            onRemove={() => {
              if (row) onRemove(row.address);
            }}
          />
        );
      })}
    </div>
  );
}
