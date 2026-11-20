import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerScope } from "../api/scope";
import { scopedFetch } from "../api/scopedFetch";
import { mountainTime } from "./threadModel";
import {
  blendChatter,
  CHATTER_HINT,
  CHATTER_PAGE,
  CHATTER_REFRESH_MS,
  chatterFromSnapshot,
  chatterLine,
  HEARTBEAT_FIRES_LIMIT,
  HEARTBEAT_FIRES_REFRESH_MS,
  heartbeatRows,
  type ChatterItem,
  type HeartbeatRow,
  type HeartbeatTone,
} from "./threadViews";
import { zenTextPx } from "./zenFont";

// Chatter, the page right of the Thread (threadViews.ts): read-only, under
// the chat header, newest at the bottom. Agent messages and the workspace's
// heartbeat wakes in one timeline (owner 2026-11-11), each re-read on its
// own clock while open (no push for either on the phone).

type Load<T> = { rows: T[]; error: string | null; loading: boolean };

/** GET `path` on `scope` every `everyMs` while mounted; `parse` the body. */
function usePolled<T>(
  scope: ServerScope,
  path: string,
  query: Record<string, string> | null,
  everyMs: number,
  parse: (body: unknown) => T[]
): Load<T> {
  const [state, setState] = useState<Load<T>>({ rows: [], error: null, loading: true });
  const key = query ? JSON.stringify(query) : null;
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const read = useCallback(
    async (alive: () => boolean) => {
      if (!key) return;
      try {
        const out = await scopedFetch(scope, path, { method: "GET", query: JSON.parse(key), priority: "background" });
        if (!alive()) return;
        if (!out.ok) {
          setState((s) => ({
            ...s,
            loading: false,
            error: out.status === 404 ? "This server doesn't have this yet." : `Couldn't load it (${out.status}).`,
          }));
          return;
        }
        setState({ rows: parseRef.current(JSON.parse(out.text)), error: null, loading: false });
      } catch {
        if (alive()) setState((s) => ({ ...s, loading: false, error: "Couldn't reach the server." }));
      }
    },
    [scope, path, key]
  );
  useEffect(() => {
    let on = true;
    const alive = () => on;
    setState({ rows: [], error: null, loading: true });
    void read(alive);
    const id = setInterval(() => void read(alive), everyMs);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, [read, everyMs]);
  return state;
}

/** Stays at the bottom (newest) as rows arrive, unless scrolled up. */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

function PaneShell({
  testid,
  topInset,
  title,
  hint,
  load,
  empty,
  scroll,
  children,
}: {
  testid: string;
  topInset: number;
  title: string;
  hint: string;
  load: Load<unknown>;
  empty: string;
  scroll: ReturnType<typeof useStickToBottom>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={scroll.ref}
      onScroll={scroll.onScroll}
      className="absolute inset-0 overflow-y-auto"
      style={{ paddingTop: topInset + 8, paddingBottom: "calc(24px + var(--safe-bottom, 0px))", WebkitOverflowScrolling: "touch" }}
      data-testid={testid}
    >
      <div style={{ padding: "0 16px 10px" }}>
        <h2 className="font-semibold" style={{ color: "var(--color-text-primary)", fontSize: zenTextPx(17) }}>
          {title}
        </h2>
        <p style={{ color: "var(--color-text-muted)", fontSize: zenTextPx(13) }}>{hint}</p>
      </div>
      {load.loading && load.rows.length === 0 ? (
        <p style={{ padding: "0 16px", color: "var(--color-text-muted)", fontSize: zenTextPx(14) }}>Loading…</p>
      ) : load.error && load.rows.length === 0 ? (
        <p style={{ padding: "0 16px", color: "var(--color-text-muted)", fontSize: zenTextPx(14) }} data-testid={`${testid}-error`}>
          {load.error}
        </p>
      ) : load.rows.length === 0 ? (
        <p style={{ padding: "0 16px", color: "var(--color-text-muted)", fontSize: zenTextPx(14) }} data-testid={`${testid}-empty`}>
          {empty}
        </p>
      ) : (
        <div className="flex flex-col" style={{ gap: 8, padding: "0 12px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function ChatterRow({ item }: { item: ChatterItem }) {
  const [open, setOpen] = useState(false);
  const full = item.body.trim();
  const line = chatterLine(item);
  const more = full.length > 0 && full !== line;
  return (
    <button
      type="button"
      className="k2-tile text-left"
      style={{ borderRadius: 14, padding: "9px 12px", color: "var(--color-text-primary)" }}
      onClick={() => more && setOpen((v) => !v)}
      aria-expanded={more ? open : undefined}
      data-testid="chatter-row"
    >
      <span className="flex items-baseline justify-between" style={{ gap: 8 }}>
        <span className="truncate font-semibold" style={{ fontSize: zenTextPx(13) }}>
          {item.from}
          {item.to ? <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}> → {item.to}</span> : null}
        </span>
        <span className="shrink-0" style={{ color: "var(--color-text-muted)", fontSize: zenTextPx(11) }}>
          {mountainTime(item.at)}
        </span>
      </span>
      <span className="block" style={{ marginTop: 3, fontSize: zenTextPx(15), whiteSpace: open ? "pre-wrap" : undefined, wordBreak: "break-word" }}>
        {open ? full : line}
      </span>
    </button>
  );
}

const TONE_COLOR: Record<HeartbeatTone, string> = {
  ok: "var(--color-status-ok)",
  warn: "var(--color-status-warn)",
  error: "var(--color-status-error)",
  muted: "var(--color-neutral)",
};

/** K2's heartbeat symbol (ThreadDrawerSelector `HeartbeatIcon`): the EKG
 *  line alone, no heart around it (owner 2026-11-14). */
export function HeartbeatIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="heartbeat-icon"
      // Desktop draws this line in plain currentColor; the phone's red was
      // its own (#ff375f), so it takes the palette's status red.
      style={{ flex: "none", color: "var(--color-status-error)" }}
    >
      <path d="M2 12h5l2-5 4 10 2-5h7" />
    </svg>
  );
}

function HeartbeatRowView({ row }: { row: HeartbeatRow }) {
  return (
    <div
      className="k2-tile relative"
      // isolate: the tint (z -1) paints over the row's own fill, under its words.
      style={{ borderRadius: 14, padding: "9px 12px", color: "var(--color-text-primary)", background: "transparent", isolation: "isolate" }}
      data-testid="heartbeat-row"
    >
      {/* The heartbeat tint: the status red at 8% (no color-mix on iOS 15). */}
      <span
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: -1, borderRadius: "inherit", background: "var(--color-status-error)", opacity: 0.08 }}
      />
      <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
        <span className="flex items-center min-w-0 font-semibold" style={{ gap: 5, fontSize: zenTextPx(13) }}>
          <HeartbeatIcon />
          <span className="truncate">Heartbeat · {row.source}</span>
        </span>
        <span className="shrink-0" style={{ color: "var(--color-text-muted)", fontSize: zenTextPx(11) }}>
          {mountainTime(row.at)}
        </span>
      </div>
      <div className="flex items-center" style={{ gap: 6, marginTop: 3, fontSize: zenTextPx(15) }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: TONE_COLOR[row.tone], flex: "none" }} />
        <span>{row.status}</span>
      </div>
      {row.detail ? (
        <div style={{ marginTop: 2, color: "var(--color-text-muted)", fontSize: zenTextPx(13), wordBreak: "break-word" }}>{row.detail}</div>
      ) : null}
    </div>
  );
}

/** Chatter: this agent's messages with other agents (`/cli/chatter`) and
 *  the heartbeats that woke its workspace (`/cli/heartbeat/fires-list`),
 *  in one timeline. Either alone still shows if the other can't load. */
export function ChatterPane({
  scope,
  addr,
  project,
  topInset,
}: {
  scope: ServerScope;
  addr: string | null;
  project: string | null;
  topInset: number;
}) {
  const chatter = usePolled(
    scope,
    "/cli/chatter",
    addr ? { addr, limit: String(CHATTER_PAGE) } : null,
    CHATTER_REFRESH_MS,
    (b) => chatterFromSnapshot(b).items
  );
  const beats = usePolled(
    scope,
    "/cli/heartbeat/fires-list",
    project ? { project, limit: String(HEARTBEAT_FIRES_LIMIT) } : null,
    HEARTBEAT_FIRES_REFRESH_MS,
    heartbeatRows
  );
  const rows = useMemo(() => blendChatter(chatter.rows, beats.rows), [chatter.rows, beats.rows]);
  const load = {
    rows,
    loading: (!!addr && chatter.loading) || (!!project && beats.loading),
    error: rows.length === 0 ? (addr ? chatter.error : "This agent has no address to read Chatter from.") : null,
  };
  const scroll = useStickToBottom(rows.length);
  return (
    <PaneShell
      testid="chatter-pane"
      topInset={topInset}
      title="Chatter"
      hint={CHATTER_HINT}
      load={load}
      empty="No messages with other agents and no heartbeats yet."
      scroll={scroll}
    >
      {rows.map((r) => (r.kind === "chatter" ? <ChatterRow key={r.key} item={r.item} /> : <HeartbeatRowView key={r.key} row={r.row} />))}
    </PaneShell>
  );
}
