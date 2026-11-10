import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ServerScope } from "../api/scope";
import { scopedFetch } from "../api/scopedFetch";
import { useBackHandler } from "../lib/androidBack";
import { useSessionIdentity } from "../lib/useSessionIdentity";
import { agentPermissionRows, agentSettingRows, projectRowOf, type AgentInfoRow } from "./agentSettings";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";

type Loaded = { settings: AgentInfoRow[]; permissions: AgentInfoRow[] };

function Group({ label, rows, testId }: { label: string; rows: AgentInfoRow[]; testId: string }) {
  if (!rows.length) return null;
  return (
    <section style={{ marginTop: 20 }} data-testid={testId}>
      <h2 className="text-[12px] uppercase tracking-wide font-normal" style={{ color: MUTED, padding: "0 16px 6px" }}>
        {label}
      </h2>
      <div className="k2-tile overflow-hidden" style={{ borderRadius: 14 }}>
        {rows.map((r, i) => (
          <div
            key={r.label}
            className="flex items-center justify-between text-[15px]"
            style={{ minHeight: 44, padding: "10px 16px", borderTop: i ? HAIRLINE : undefined, gap: 16 }}
            data-testid="agent-info-row"
          >
            <span className="min-w-0">{r.label}</span>
            <span className="shrink-0 text-right truncate" style={{ color: MUTED, maxWidth: "45%" }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** An agent's settings and permissions, to read (Rosson 2026-11-09),
 *  opened from its profile picture. Changing them stays on the desktop. */
export function AgentSettingsPage({
  scope,
  projectId,
  name,
  onBack,
}: {
  scope: ServerScope;
  projectId: string;
  name: string;
  onBack: () => void;
}) {
  useBackHandler(true, onBack);
  const identity = useSessionIdentity(scope);
  const member = identity?.role === "member";
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    scopedFetch(scope, "/cli/projects/list", { timeoutMs: 15000 })
      .then((r) => {
        if (!live) return;
        const row = r.ok ? projectRowOf(JSON.parse(r.text), projectId) : null;
        if (row) setRaw(row);
        else setFailed(true);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [scope, projectId]);

  const loaded: Loaded | null = raw
    ? { settings: agentSettingRows(raw), permissions: agentPermissionRows(raw, member) }
    : null;

  return createPortal(
    <div
      className="fixed inset-0 flex flex-col zen-font"
      style={{ background: "#000", color: "#fff", zIndex: 76, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="agent-settings-page"
    >
      <div
        className="grid items-center shrink-0"
        style={{ gridTemplateColumns: "1fr minmax(0, auto) 1fr", minHeight: 44, padding: "12px 12px 8px", columnGap: 8 }}
      >
        <button
          type="button"
          className="text-[17px] justify-self-start zen-glass zen-glass-pill"
          style={{ minHeight: 34, padding: "0 14px", color: "#fff" }}
          onClick={onBack}
          data-testid="agent-settings-back"
        >
          Back
        </button>
        <h1 className="text-[17px] font-semibold truncate pointer-events-none" data-testid="agent-settings-title">
          {name}
        </h1>
        <span />
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ padding: "0 16px calc(24px + var(--safe-bottom))", WebkitOverflowScrolling: "touch" }}
      >
        {failed ? (
          <p className="text-[15px] text-center" style={{ color: MUTED, marginTop: 32 }} data-testid="agent-settings-failed">
            Couldn't load this agent's settings.
          </p>
        ) : loaded ? (
          <>
            <Group label="Settings" rows={loaded.settings} testId="agent-settings-group" />
            <Group label="Permissions" rows={loaded.permissions} testId="agent-permissions-group" />
            <p className="text-[13px]" style={{ color: MUTED, padding: "8px 16px 0", lineHeight: 1.35 }}>
              To change these, use K2 on your desktop.
            </p>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
