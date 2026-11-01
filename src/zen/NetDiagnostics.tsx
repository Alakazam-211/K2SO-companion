import { useEffect, useState, useSyncExternalStore } from "react";
import { netStatsVersion, netSummary, subscribeNetStats, type NetEvent, type NetReturn, type NetSummary } from "../lib/netStats";

const MUTED = "#8e8e93";

/** "18 requests, 2 sockets in 10 s after 42 s away (thread ×4, …)". */
export function returnLine(r: NetReturn): string {
  const away = r.awayMs >= 60_000 ? `${Math.round(r.awayMs / 60_000)} min` : `${Math.round(r.awayMs / 1000)} s`;
  const top = Object.entries(r.routes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([route, n]) => `${route.replace(/^\/cli\//, "")} ×${n}`)
    .join(", ");
  const n = (v: number, one: string) => `${v} ${one}${v === 1 ? "" : "s"}`;
  return `${n(r.requests, "request")}, ${n(r.opens, "socket")} after ${away} away${top ? ` (${top})` : ""}`;
}

/** "07:41:05 viewing_ok rev 812 (current)": seconds, for lining up logs. */
export function eventLine(e: NetEvent): string {
  const d = new Date(e.at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${e.text}`;
}

export function summaryLines(s: NetSummary): string[] {
  const opens = Object.entries(s.opens)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return [
    `${s.requestsPerMin}/min now · ${s.total} requests this session` + (s.errors ? ` · ${s.errors} failed` : ""),
    `Sockets opened: ${opens || "none"} · ${s.framesPerMin} frames/min`,
    `Top routes: ${s.topRoutes.map((r) => `${r.route.replace(/^\/cli\//, "")} ${r.count}`).join(", ") || "—"}`,
    `Top frames: ${s.topFrames.map((f) => `${f.kind} ${f.count}`).join(", ") || "—"}`,
  ];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Server settings → Diagnostics → "Network": this server's requests and
 *  sockets this session, and what each return to the app cost. */
export function NetRow({ serverUrl }: { serverUrl: string }) {
  const [open, setOpen] = useState(false);
  useSyncExternalStore(subscribeNetStats, netStatsVersion, netStatsVersion);
  // Frames don't notify: refresh while open.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [open]);
  const s = open ? netSummary(hostOf(serverUrl)) : null;
  return (
    <div data-testid="server-settings-net">
      <button
        type="button"
        className="w-full flex items-center justify-between text-left text-[15px]"
        style={{ minHeight: 40, padding: "9px 16px", color: MUTED }}
        aria-expanded={open}
        data-testid="server-settings-net-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Network</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {open ? (
        <div className="text-[12px]" style={{ padding: "0 16px 10px", color: MUTED, lineHeight: 1.45 }} data-testid="server-settings-net-panel">
          {s ? (
            <>
              {summaryLines(s).map((l) => (
                <div key={l} style={{ marginBottom: 4 }}>
                  {l}
                </div>
              ))}
              <div style={{ color: "#fff", marginTop: 6 }}>Returns to the app (all servers, first 10 s)</div>
              {s.returns.length === 0 ? (
                <div>None yet this session.</div>
              ) : (
                s.returns.map((r) => (
                  <div key={r.at} data-testid="net-return-row">
                    {returnLine(r)}
                  </div>
                ))
              )}
              {s.events.length ? (
                <>
                  <div style={{ color: "#fff", marginTop: 6 }}>Events</div>
                  {s.events.map((e, i) => (
                    <div key={`${e.at}-${i}`} data-testid="net-event-row">
                      {eventLine(e)}
                    </div>
                  ))}
                </>
              ) : null}
            </>
          ) : (
            <span>No requests to this server yet this session.</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
