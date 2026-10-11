import { useMemo, useState, type ReactNode } from "react";
import type { ServerEntry } from "../stores/servers";
import { homeHasAddress, type Home, type HomeRow } from "./homes";
import { candidateMatches, homeRowFor, isHomeCandidate, serverDisplayName } from "./homeView";
import { rowFocusGroupId, type FocusGroupLite, type ServerProject } from "./serverPins";
import type { StubAgent } from "./stubData";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { CheckIcon } from "./icons";
import { useBackHandler } from "../lib/androidBack";

export type AddAgentSegment = "this" | "other";

type Section = { key: string; title: string | null; dot: string | null; agents: StubAgent[] };

/** This server's candidates, by focus group when groups are on (the
 *  group order, then "No group"); one untitled section otherwise. */
export function groupCandidates(
  agents: StubAgent[],
  projects: ServerProject[],
  groups: FocusGroupLite[] | null
): Section[] {
  if (!groups || groups.length === 0) return [{ key: "all", title: null, dot: null, agents }];
  const by = new Map<string | null, StubAgent[]>();
  for (const a of agents) {
    const gid = rowFocusGroupId(a, projects);
    const known = gid && groups.some((g) => g.id === gid) ? gid : null;
    by.set(known, [...(by.get(known) ?? []), a]);
  }
  const out: Section[] = [];
  for (const g of groups) {
    const list = by.get(g.id);
    if (list?.length) out.push({ key: g.id, title: g.name, dot: g.color, agents: list });
  }
  const none = by.get(null);
  if (none?.length) out.push({ key: "none", title: "No group", dot: null, agents: none });
  return out;
}

function Check() {
  return (
    <CheckIcon size={18} strokeWidth={2.6} testId="add-agent-check" />
  );
}

/** One pickable agent (both segments): avatar, name, handle, and an
 *  empty ring or a check. Rows already on the Home stay checked and a tap
 *  does nothing; a row that cannot be addressed is disabled. */
export function CandidateRow({
  agent: a,
  iconUrl,
  homeName,
  added,
  disabled,
  testId,
  onAdd,
}: {
  agent: StubAgent;
  iconUrl?: string | null;
  homeName: string;
  added: boolean;
  disabled: boolean;
  testId: string;
  onAdd: () => void;
}) {
  return (
    <button
      type="button"
      className="w-full flex items-center text-left bg-transparent border-0"
      style={{ gap: 12, padding: "8px 16px", minHeight: 56, color: "#fff", opacity: disabled ? 0.4 : 1 }}
      aria-pressed={added}
      aria-label={added ? `${a.name}, on ${homeName}` : `Add ${a.name}`}
      disabled={disabled}
      data-testid={testId}
      data-added={added ? "1" : undefined}
      onClick={() => {
        if (disabled || added) return;
        onAdd();
      }}
    >
      <WorkspaceAvatar initial={a.initial} color={a.color} iconUrl={iconUrl ?? a.iconUrl} size={40} fontSize={15} />
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[16px] font-medium">{a.name}</span>
        <span className="block truncate text-[13px]" style={{ color: "#8e8e93" }}>
          {a.addr}
        </span>
      </span>
      <span className="shrink-0 flex items-center justify-center"
        style={{ width: 24, height: 24, color: "#0a84ff" }}>
        {added ? <Check /> : (
          <span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", boxShadow: "inset 0 0 0 1.5px #636366" }} />
        )}
      </span>
    </button>
  );
}

/**
 * Other servers (HM5, multi-server flag on only): one section per saved
 * server that is not the active one. `renderBody(server)` lists that
 * server's agents with its own saved login (no switch, at most 4 loading
 * at once) and its loading / offline / sign-in / no-access /
 * needs-an-update / failed state (`multi/OtherServerSection`).
 */
export function OtherServersSections({
  servers,
  renderBody,
}: {
  servers: ServerEntry[];
  renderBody: (server: ServerEntry) => ReactNode;
}) {
  if (servers.length === 0) {
    return (
      <p className="text-[14px] text-center" style={{ color: "#8e8e93", padding: "18px 16px" }}
        data-testid="add-agent-no-other">
        No other saved servers. Add one from the Servers sheet.
      </p>
    );
  }
  return (
    <>
      {servers.map((s) => (
        <section key={s.id} data-testid={`add-agent-server-${s.id}`} style={{ padding: "4px 0 8px" }}>
          <h3 className="text-[13px] font-semibold uppercase truncate"
            style={{ color: "#8e8e93", padding: "8px 16px 6px", letterSpacing: "0.3px" }}>
            {serverDisplayName(s)}
          </h3>
          {renderBody(s)}
        </section>
      ))}
    </>
  );
}

/**
 * Home `+` (HM5): pick agents to add to the current Home. An evolution of
 * desktop `HomeAddPanels.tsx` + `SearchableAgentList`. Tapping a row adds
 * it (a local `k2.homes.v1` write); rows already on the Home stay checked
 * and a tap does nothing. The sheet stays open for more; Done closes it.
 * Never creates a workspace (desktop H7).
 */
export function AddAgentSheet({
  home,
  hostKey,
  agents,
  projects,
  groups,
  otherServers,
  renderOtherBody,
  onAdd,
  onClose,
}: {
  home: Home;
  /** The active server's host key; null = cannot build addresses. */
  hostKey: string | null;
  agents: StubAgent[];
  projects: ServerProject[];
  /** Focus groups when they are on, else null. */
  groups: FocusGroupLite[] | null;
  otherServers: ServerEntry[];
  /** Multi-server flag on (S3b): one live section body per other server,
   *  under the shared search. Absent (flag off, owner 2026-10): no
   *  This server / Other servers control — the active server's list only. */
  renderOtherBody?: (server: ServerEntry, q: string) => ReactNode;
  onAdd: (row: HomeRow) => void;
  onClose: () => void;
}) {
  const [segmentPick, setSegment] = useState<AddAgentSegment>("this");
  // Android Back = Done.
  useBackHandler(true, onClose);
  const segment: AddAgentSegment = renderOtherBody ? segmentPick : "this";
  const [q, setQ] = useState("");
  const candidates = useMemo(() => agents.filter(isHomeCandidate), [agents]);
  const sections = useMemo(
    () => groupCandidates(candidates.filter((a) => candidateMatches(a, q)), projects, groups),
    [candidates, q, projects, groups]
  );
  const shown = sections.reduce((n, s) => n + s.agents.length, 0);
  const segBtn = (key: AddAgentSegment, label: string) => (
    <button
      type="button"
      className="zen-seg-btn flex-1 text-[14px] font-medium"
      style={{ height: "100%" }}
      aria-pressed={segment === key}
      data-selected={segment === key || undefined}
      data-testid={`add-agent-seg-${key}`}
      onClick={() => setSegment(key)}
    >
      {label}
    </button>
  );
  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 30 }}
      data-no-pin="1"
      data-testid="add-agent"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={`Add agents to ${home.name}`}
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "12px 0 max(12px, var(--safe-bottom))",
          height: "85%",
          color: "#fff",
        }}
      >
        <div className="grid items-center shrink-0"
          style={{ gridTemplateColumns: "1fr auto 1fr", padding: "0 12px 10px" }}>
          <span />
          <h2 className="text-[17px] font-semibold text-center truncate">Add Agent</h2>
          <button
            type="button"
            className="justify-self-end bg-transparent border-0 text-[17px] font-semibold"
            style={{ color: "#0a84ff", minHeight: 44, padding: "0 6px" }}
            onClick={onClose}
            data-testid="add-agent-done"
          >
            Done
          </button>
        </div>
        {renderOtherBody ? (
          <div
            role="group"
            aria-label="Which servers"
            className="zen-seg flex items-center shrink-0 zen-glass zen-glass-pill"
            style={{ position: "relative", height: 34, padding: 2, borderRadius: 17, overflow: "hidden", margin: "0 16px 10px" }}
          >
            <span
              className="zen-seg-thumb"
              aria-hidden
              style={{
                position: "absolute",
                top: 2,
                bottom: 2,
                left: 2,
                width: "calc(50% - 2px)",
                borderRadius: 15,
                transform: segment === "this" ? "translateX(0%)" : "translateX(100%)",
              }}
            />
            {segBtn("this", "This server")}
            {segBtn("other", "Other servers")}
          </div>
        ) : null}
        <label className="zen-glass zen-glass-field flex items-center shrink-0"
          style={{ margin: "0 16px 6px", padding: "8px 14px" }}>
          <span className="sr-only">Search agents</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, path or handle"
            aria-label="Search agents"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[16px]"
            style={{ color: "#fff" }}
            data-testid="add-agent-search"
          />
        </label>
        {segment === "this" ? (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto" data-testid="add-agent-this">
              {shown === 0 ? (
                <p className="text-[14px] text-center" style={{ color: "#8e8e93", padding: "18px 16px" }}
                  data-testid="add-agent-empty">
                  {candidates.length === 0 ? "No agents on this server yet." : "No matches."}
                </p>
              ) : null}
              {sections.map((sec) => (
                <section key={sec.key} data-testid={`add-agent-section-${sec.key}`}>
                  {sec.title ? (
                    <h3 className="flex items-center text-[13px] font-semibold uppercase"
                      style={{ color: "#8e8e93", padding: "10px 16px 4px", gap: 6, letterSpacing: "0.3px" }}>
                      {sec.dot ? (
                        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: sec.dot }} />
                      ) : null}
                      <span className="truncate">{sec.title}</span>
                    </h3>
                  ) : null}
                  {sec.agents.map((a) => {
                    const row = hostKey ? homeRowFor(a, hostKey, projects) : null;
                    const added = !!row && homeHasAddress(home, row.address);
                    return (
                      <CandidateRow
                        key={a.id}
                        agent={a}
                        homeName={home.name}
                        added={added}
                        disabled={!row}
                        testId={`add-agent-row-${a.id}`}
                        onAdd={() => {
                          if (row) onAdd(row);
                        }}
                      />
                    );
                  })}
                </section>
              ))}
            </div>
          </>
        ) : renderOtherBody ? (
          <div className="flex-1 min-h-0 overflow-y-auto" data-testid="add-agent-other">
            <OtherServersSections servers={otherServers} renderBody={(server) => renderOtherBody(server, q)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
