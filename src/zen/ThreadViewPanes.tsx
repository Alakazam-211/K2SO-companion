import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerScope } from "../api/scope";
import { scopedFetch } from "../api/scopedFetch";
import { mountainTime } from "./threadModel";
import {
  CHATTER_PAGE,
  CHATTER_REFRESH_MS,
  chatterFromSnapshot,
  chatterLine,
  HEARTBEAT_FIRES_LIMIT,
  HEARTBEAT_FIRES_REFRESH_MS,
  heartbeatRows,
  THREAD_PANEL_HINT,
  type ChatterItem,
  type HeartbeatRow,
  type HeartbeatTone,
} from "./threadViews";
import { zenTextPx } from "./zenFont";

// Chatter and Heartbeats in place of the Thread (threadViews.ts): read-only
// lists under the chat header, newest at the bottom, each re-read while
// open (no push for either on the phone).

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
        <h2 className="font-semibold" style={{ color: "#fff", fontSize: zenTextPx(17) }}>
          {title}
        </h2>
        <p style={{ color: "#8e8e93", fontSize: zenTextPx(13) }}>{hint}</p>
      </div>
      {load.loading && load.rows.length === 0 ? (
        <p style={{ padding: "0 16px", color: "#8e8e93", fontSize: zenTextPx(14) }}>Loading…</p>
      ) : load.error && load.rows.length === 0 ? (
        <p style={{ padding: "0 16px", color: "#8e8e93", fontSize: zenTextPx(14) }} data-testid={`${testid}-error`}>
          {load.error}
        </p>
      ) : load.rows.length === 0 ? (
        <p style={{ padding: "0 16px", color: "#8e8e93", fontSize: zenTextPx(14) }} data-testid={`${testid}-empty`}>
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
      style={{ borderRadius: 14, padding: "9px 12px", color: "#fff" }}
      onClick={() => more && setOpen((v) => !v)}
      aria-expanded={more ? open : undefined}
      data-testid="chatter-row"
    >
      <span className="flex items-baseline justify-between" style={{ gap: 8 }}>
        <span className="truncate font-semibold" style={{ fontSize: zenTextPx(13) }}>
          {item.from}
          {item.to ? <span style={{ color: "#8e8e93", fontWeight: 400 }}> → {item.to}</span> : null}
        </span>
        <span className="shrink-0" style={{ color: "#8e8e93", fontSize: zenTextPx(11) }}>
          {mountainTime(item.at)}
        </span>
      </span>
      <span className="block" style={{ marginTop: 3, fontSize: zenTextPx(15), whiteSpace: open ? "pre-wrap" : undefined, wordBreak: "break-word" }}>
        {open ? full : line}
      </span>
    </button>
  );
}

/** Messages between this agent and other agents (`/cli/chatter`). */
export function ChatterPane({ scope, addr, topInset }: { scope: ServerScope; addr: string | null; topInset: number }) {
  const load = usePolled(
    scope,
    "/cli/chatter",
    addr ? { addr, limit: String(CHATTER_PAGE) } : null,
    CHATTER_REFRESH_MS,
    (b) => chatterFromSnapshot(b).items
  );
  const scroll = useStickToBottom(load.rows.length);
  return (
    <PaneShell
      testid="chatter-pane"
      topInset={topInset}
      title="Chatter"
      hint={THREAD_PANEL_HINT.chatter}
      load={addr ? load : { rows: [], loading: false, error: "This agent has no address to read Chatter from." }}
      empty="No messages between this agent and other agents yet."
      scroll={scroll}
    >
      {load.rows.map((item) => (
        <ChatterRow key={item.id} item={item} />
      ))}
    </PaneShell>
  );
}

const TONE_COLOR: Record<HeartbeatTone, string> = {
  ok: "#30d158",
  warn: "#ff9f0a",
  error: "#ff453a",
  muted: "#8e8e93",
};

function HeartbeatRowView({ row }: { row: HeartbeatRow }) {
  return (
    <div className="k2-tile" style={{ borderRadius: 14, padding: "9px 12px", color: "#fff" }} data-testid="heartbeat-row">
      <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
        <span className="truncate font-semibold" style={{ fontSize: zenTextPx(13) }}>
          {row.source}
        </span>
        <span className="shrink-0" style={{ color: "#8e8e93", fontSize: zenTextPx(11) }}>
          {mountainTime(row.at)}
        </span>
      </div>
      <div className="flex items-center" style={{ gap: 6, marginTop: 3, fontSize: zenTextPx(15) }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: TONE_COLOR[row.tone], flex: "none" }} />
        <span>{row.status}</span>
      </div>
      {row.detail ? (
        <div style={{ marginTop: 2, color: "#8e8e93", fontSize: zenTextPx(13), wordBreak: "break-word" }}>{row.detail}</div>
      ) : null}
    </div>
  );
}

/** Heartbeat fires that woke this workspace (`/cli/heartbeat/fires-list`). */
export function HeartbeatsPane({ scope, project, topInset }: { scope: ServerScope; project: string | null; topInset: number }) {
  const load = usePolled(
    scope,
    "/cli/heartbeat/fires-list",
    project ? { project, limit: String(HEARTBEAT_FIRES_LIMIT) } : null,
    HEARTBEAT_FIRES_REFRESH_MS,
    heartbeatRows
  );
  const scroll = useStickToBottom(load.rows.length);
  return (
    <PaneShell
      testid="heartbeats-pane"
      topInset={topInset}
      title="Heartbeats"
      hint={THREAD_PANEL_HINT.heartbeats}
      load={project ? load : { rows: [], loading: false, error: "This agent has no workspace to read heartbeats from." }}
      empty="No heartbeats have woken this workspace yet."
      scroll={scroll}
    >
      {load.rows.map((row) => (
        <HeartbeatRowView key={row.id} row={row} />
      ))}
    </PaneShell>
  );
}
