import { useEffect, useState } from "react";
import { subdomainOfServerUrl } from "../lib/avatarCache";
import {
  badgeTotalsSupported,
  getBadgeDiagnostics,
  summarizeBadgeDiagnostics,
  type BadgeDiagnosticsSummary,
} from "../lib/badgeTotals";
import { useServersStore } from "../stores/servers";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";

/** "Oct 17, 3:04 PM"-style local time, or "Never". */
export function formatLastReceived(ms: number | null): string {
  if (ms === null) return "Never";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Server settings → Notifications → "Diagnostics": how many badge pushes
 *  this phone actually received from the server (silent badge pushes and
 *  alert pushes carrying totals; APNs may throttle or drop the silent
 *  ones, so only the phone can tell). Read-only, collapsed by default,
 *  shown only where badge totals work (push available on iOS) and for a
 *  `<label>.k2.dev` server. Counts load when opened. */
export function BadgeDiagnosticsRow({ serverId }: { serverId: string }) {
  const url = useServersStore((s) => s.servers.find((x) => x.id === serverId)?.url ?? null);
  const subdomain = subdomainOfServerUrl(url);
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<BadgeDiagnosticsSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    void badgeTotalsSupported().then((ok) => {
      if (live) setSupported(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!open || !subdomain) return;
    let live = true;
    setLoading(true);
    void getBadgeDiagnostics().then((d) => {
      if (!live) return;
      setSummary(summarizeBadgeDiagnostics(d, subdomain));
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [open, subdomain]);

  if (!supported || !subdomain) return null;
  const panelId = `server-settings-badge-diag-${serverId}`;
  return (
    <div style={{ borderTop: HAIRLINE }} data-testid="server-settings-badge-diagnostics">
      <button
        type="button"
        className="w-full flex items-center justify-between text-left text-[15px]"
        style={{ minHeight: 40, padding: "9px 16px", color: MUTED }}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="server-settings-badge-diagnostics-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Diagnostics</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke={MUTED}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {open ? (
        <div
          id={panelId}
          className="text-[13px]"
          style={{ padding: "0 16px 10px", color: MUTED, lineHeight: 1.5 }}
          data-testid="server-settings-badge-diagnostics-panel"
        >
          {loading || !summary ? (
            <span>Loading…</span>
          ) : (
            <>
              <DiagLine
                label="Today"
                value={`${summary.today.silent} silent · ${summary.today.alert} alert`}
                testId="badge-diag-today"
              />
              <DiagLine
                label="Last 7 days"
                value={`${summary.week.silent} silent · ${summary.week.alert} alert`}
                testId="badge-diag-week"
              />
              <DiagLine
                label="Last received"
                value={formatLastReceived(summary.lastAt)}
                testId="badge-diag-last"
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DiagLine({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex justify-between" style={{ gap: 12 }}>
      <span>{label}</span>
      <span className="text-right" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
