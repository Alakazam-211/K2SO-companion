import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { scopeFor } from "../api/scope";
import {
  ADD_ON_DESKTOP_NOTE,
  FORBIDDEN_SWITCH_TEXT,
  STATE_COLORS,
  STATE_LABELS,
  canSwitchTo,
  checkedAgoText,
  exhaustedWindows,
  forbiddenListText,
  formatResetsIn,
  getLlmTokens,
  isApiToken,
  percentUsed,
  pinnedToText,
  refreshLlmTokenUsage,
  splitTool,
  switchBlockReason,
  switchLlmToken,
  tokenName,
  unsupportedText,
  usageCheckedAtSecs,
  visibleTools,
  type LlmToken,
  type LlmTokenTool,
  type LlmTokensDoc,
  type TokensFailureKind,
} from "../api/llmTokens";
import { useBackHandler } from "../lib/androidBack";
import { useSwipeBack } from "../lib/useSwipeBack";
import { LlmIcon } from "./LlmIcon";
import { underHeaderPadding, useMeasuredHeight, ZenHeaderBlur } from "./ZenHeaderBlur";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";
const RED = "#ef4444";
const AMBER = "#f59e0b";
const PILL_H = 36;
/** Resting header content height (below the safe area): title + server. */
export const USAGE_HEADER_PX = 60;
/** How often reset countdowns and "checked … ago" re-render. */
const TICK_MS = 60_000;

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; failure: TokensFailureKind; error: string };

/** Usage (Servers card → gauge): one server's LLM subscriptions and API
 *  tokens, mirroring desktop Settings → LLMs → Tokens — the server default
 *  per tool, every other token, each one's own usage windows and when
 *  they reset — with a Switch on each other signed-in subscription
 *  (`POST /cli/llm/accounts/switch`). Adding a subscription stays on the
 *  desktop. A full page over the Servers sheet: the glass back chevron,
 *  Android Back and the left-edge swipe all go back. */
export function UsagePage({ serverId, onBack }: { serverId: string; onBack: () => void }) {
  const scope = scopeFor(serverId);
  const serverLabel = scope.label;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [doc, setDoc] = useState<LlmTokensDoc | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchDenied, setSwitchDenied] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rowWarnings, setRowWarnings] = useState<Record<string, string[]>>({});
  const [now, setNow] = useState(() => Date.now());
  const [headerRef, headerPx] = useMeasuredHeight(USAGE_HEADER_PX);
  const mounted = useRef(true);
  /** Only the newest list read lands. */
  const loadSeq = useRef(0);
  const hasDoc = useRef(false);

  // Android Back = the back chevron; the left-edge swipe too, while
  // nothing sits over the page. The Servers sheet shows underneath.
  const onTop = useBackHandler(true, onBack);
  const swipeRef = useSwipeBack(onBack, { enabled: onTop });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const r = await getLlmTokens(scopeFor(serverId));
    if (!mounted.current || seq !== loadSeq.current) return;
    if (r.ok) {
      hasDoc.current = true;
      setDoc(r.doc);
      setReloadError(null);
      setPhase({ kind: "ready" });
      return;
    }
    // Keep this server's last list on a failed re-read; say what failed.
    if (hasDoc.current && r.kind === "error") {
      setReloadError(`Couldn't refresh: ${r.error}`);
      return;
    }
    setPhase({ kind: "failed", failure: r.kind, error: r.error });
  }, [serverId]);

  /** Ask the daemon to re-read every token's usage, then re-list. A failed
   *  refresh is not the page's error: each row says how old its numbers are. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshLlmTokenUsage(scopeFor(serverId));
      await load();
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [serverId, load]);

  // Open: the list now, then fresh usage (desktop does the same on open).
  useEffect(() => {
    hasDoc.current = false;
    setDoc(null);
    setPhase({ kind: "loading" });
    let cancelled = false;
    void (async () => {
      await load();
      if (!cancelled && mounted.current && hasDoc.current) void refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [load, refresh]);

  const doSwitch = async (token: LlmToken) => {
    if (switchingId || switchDenied) return;
    setSwitchingId(token.id);
    setRowErrors((m) => {
      const { [token.id]: _drop, ...rest } = m;
      return rest;
    });
    setRowWarnings({});
    const r = await switchLlmToken(scopeFor(serverId), token.id);
    if (!mounted.current) return;
    if (r.ok) {
      if (r.warnings.length > 0) setRowWarnings({ [token.id]: r.warnings });
      await load();
    } else if (r.kind === "forbidden") {
      setSwitchDenied(FORBIDDEN_SWITCH_TEXT);
    } else {
      setRowErrors((m) => ({ ...m, [token.id]: r.error }));
    }
    if (mounted.current) setSwitchingId(null);
  };

  const tools = visibleTools(doc);

  return (
    <div
      ref={swipeRef}
      className="absolute inset-0 flex flex-col min-w-0 overflow-x-hidden"
      style={{ background: "#000", zIndex: 8, fontFamily: "var(--zen-font)" }}
      data-testid="usage-page"
    >
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-testid="usage-header"
        style={{ zIndex: 3, paddingTop: "env(safe-area-inset-top)", pointerEvents: "none" }}
      >
        <ZenHeaderBlur testId="usage-header-blur" />
        <div
          ref={headerRef}
          className="relative w-full min-w-0 grid items-center"
          style={{ gridTemplateColumns: "1fr auto 1fr", padding: "12px 12px 10px", columnGap: 8 }}
          data-testid="usage-header-content"
        >
          <button
            type="button"
            onClick={onBack}
            data-testid="usage-back"
            className="flex items-center justify-center shrink-0 justify-self-start zen-glass zen-glass-pill"
            style={{ width: PILL_H, height: PILL_H, color: "#fff", pointerEvents: "auto" }}
            aria-label="Back to servers"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="min-w-0 flex flex-col items-center zen-header-text pointer-events-none">
            <h1 className="text-[17px] font-semibold leading-tight">Usage</h1>
            <span
              className="text-[12px] truncate max-w-[60vw]"
              style={{ color: MUTED }}
              data-testid="usage-server"
            >
              {serverLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || phase.kind !== "ready"}
            data-testid="usage-refresh"
            className="flex items-center justify-center shrink-0 justify-self-end zen-glass zen-glass-pill disabled:opacity-40"
            style={{ width: PILL_H, height: PILL_H, color: "#fff", pointerEvents: "auto" }}
            aria-label="Refresh usage"
            aria-busy={refreshing || undefined}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className={refreshing ? "animate-spin" : undefined}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
        </div>
      </header>

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          paddingTop: underHeaderPadding(headerPx, 4),
          paddingLeft: 16,
          paddingRight: 16,
          paddingBottom: "calc(24px + var(--safe-bottom))",
          WebkitOverflowScrolling: "touch",
        }}
        data-testid="usage-scroll"
      >
        <div
          className="k2-tile flex"
          style={{ borderRadius: 14, padding: "12px 14px", gap: 10 }}
          role="note"
          data-testid="usage-note"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0" style={{ color: MUTED, marginTop: 1 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <p className="text-[14px]" style={{ lineHeight: 1.4 }}>
            {ADD_ON_DESKTOP_NOTE}
          </p>
        </div>
        {doc?.switchNote ? (
          <p className="text-[13px]" style={{ color: MUTED, padding: "6px 16px 0", lineHeight: 1.35 }} data-testid="usage-switch-note">
            {doc.switchNote}
          </p>
        ) : null}
        {doc?.airgap ? (
          <p className="text-[13px]" style={{ color: MUTED, padding: "6px 16px 0", lineHeight: 1.35 }} data-testid="usage-airgap">
            Air-gap mode is on: this server doesn't check usage. Switching between saved subscriptions still works.
          </p>
        ) : null}

        {switchDenied ? <Banner color={AMBER} testId="usage-switch-denied">{switchDenied}</Banner> : null}
        {reloadError ? <Banner color={RED} testId="usage-reload-error">{reloadError}</Banner> : null}

        {phase.kind === "loading" ? (
          <p className="text-[14px]" style={{ color: MUTED, padding: "24px 16px" }} data-testid="usage-loading">
            Loading subscriptions…
          </p>
        ) : phase.kind === "failed" ? (
          <Banner color={phase.failure === "error" ? RED : MUTED} testId={`usage-${phase.failure}`}>
            {phase.failure === "unsupported"
              ? unsupportedText(serverLabel)
              : phase.failure === "forbidden"
                ? forbiddenListText(serverLabel)
                : `Couldn't load subscriptions from ${serverLabel || "this server"}: ${phase.error}`}
          </Banner>
        ) : tools.length === 0 ? (
          <p className="text-[14px]" style={{ color: MUTED, padding: "24px 16px" }} data-testid="usage-empty">
            No subscriptions on {serverLabel || "this server"} yet.
          </p>
        ) : (
          tools.map((tool) => (
            <ToolSection
              key={tool.tool}
              tool={tool}
              doc={doc}
              now={now}
              switchingId={switchingId}
              switchDenied={switchDenied}
              rowErrors={rowErrors}
              rowWarnings={rowWarnings}
              onSwitch={(t) => void doSwitch(t)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Banner({ color, testId, children }: { color: string; testId: string; children: ReactNode }) {
  return (
    <p
      className="text-[14px]"
      style={{ color, padding: "16px 16px 0", lineHeight: 1.4 }}
      role={color === RED ? "alert" : undefined}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

function ToolSection({
  tool,
  doc,
  now,
  switchingId,
  switchDenied,
  rowErrors,
  rowWarnings,
  onSwitch,
}: {
  tool: LlmTokenTool;
  doc: LlmTokensDoc | null;
  now: number;
  switchingId: string | null;
  switchDenied: string | null;
  rowErrors: Record<string, string>;
  rowWarnings: Record<string, string[]>;
  onSwitch: (t: LlmToken) => void;
}) {
  const { active, others } = splitTool(tool);
  const rows = active ? [active, ...others] : others;
  return (
    <section style={{ marginTop: 22 }} data-testid={`usage-tool-${tool.tool}`}>
      <h2
        className="flex items-center text-[12px] uppercase tracking-wide font-normal"
        style={{ color: MUTED, padding: "0 16px 6px", gap: 6 }}
      >
        <LlmIcon harness={tool.tool} size={14} />
        {tool.display}
      </h2>
      <div className="k2-tile overflow-hidden" style={{ borderRadius: 14 }}>
        {!active ? (
          <p className="text-[13px]" style={{ color: MUTED, padding: "10px 14px", borderBottom: HAIRLINE }}>
            No server default for {tool.display}.
          </p>
        ) : null}
        {rows.map((t, i) => (
          <TokenRow
            key={t.id}
            token={t}
            tool={tool}
            doc={doc}
            now={now}
            first={i === 0 && !!active}
            last={i === rows.length - 1}
            switching={switchingId === t.id}
            busy={switchingId !== null}
            switchDenied={switchDenied}
            error={rowErrors[t.id] ?? null}
            warnings={rowWarnings[t.id] ?? []}
            onSwitch={onSwitch}
          />
        ))}
      </div>
      {active && others.length > 0 ? (
        <p className="text-[12px]" style={{ color: MUTED, padding: "6px 16px 0", lineHeight: 1.35 }}>
          Switching changes the {tool.display} server default for every chat on Server default; running sessions pick it up.
        </p>
      ) : null}
    </section>
  );
}

function TokenRow({
  token,
  tool,
  doc,
  now,
  first,
  last,
  switching,
  busy,
  switchDenied,
  error,
  warnings,
  onSwitch,
}: {
  token: LlmToken;
  tool: LlmTokenTool;
  doc: LlmTokensDoc | null;
  now: number;
  first: boolean;
  last: boolean;
  switching: boolean;
  busy: boolean;
  switchDenied: string | null;
  error: string | null;
  warnings: string[];
  onSwitch: (t: LlmToken) => void;
}) {
  const who = [token.email, token.org].filter(Boolean).join(" · ");
  const pinned = pinnedToText(token);
  const blocked = token.active ? null : switchBlockReason(doc, token);
  const switchable = canSwitchTo(doc, token);
  const usedUp = switchable ? exhaustedWindows(token, now) : [];
  return (
    <div
      style={{ padding: "12px 14px", borderBottom: last ? undefined : HAIRLINE }}
      data-testid={`usage-token-${token.id}`}
      data-active={token.active ? "true" : undefined}
    >
      {first ? (
        <p className="text-[11px] uppercase tracking-wide" style={{ color: "#22c55e", marginBottom: 4, letterSpacing: ".04em" }}>
          Active
        </p>
      ) : null}
      <div className="flex items-center" style={{ gap: 10 }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center min-w-0" style={{ gap: 6 }}>
            <span
              className="shrink-0"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: STATE_COLORS[token.state] ?? STATE_COLORS.unknown,
              }}
            />
            <span className="text-[15px] font-semibold truncate" data-testid={`usage-token-name-${token.id}`}>
              {tokenName(tool.display, token)}
            </span>
          </div>
          <div className="text-[12px] truncate" style={{ color: MUTED, marginTop: 2 }}>
            {token.active ? "Server default · " : ""}
            {STATE_LABELS[token.state] ?? token.state}
            {who ? ` · ${who}` : ""}
          </div>
        </div>
        {switchable ? (
          <button
            type="button"
            className="shrink-0 text-[15px] k2-tile disabled:opacity-40"
            style={{ minHeight: 34, padding: "0 14px", borderRadius: 17, color: "#fff" }}
            disabled={busy || !!switchDenied}
            title={switchDenied ?? undefined}
            aria-busy={switching || undefined}
            aria-label={`Switch ${tool.display} to ${token.label}`}
            data-testid={`usage-switch-${token.id}`}
            onClick={() => onSwitch(token)}
          >
            {switching ? "Switching…" : "Switch"}
          </button>
        ) : null}
      </div>

      {!isApiToken(token) ? <UsageWindows token={token} now={now} /> : null}

      {pinned ? <Line testId={`usage-pinned-${token.id}`}>Used by: {pinned}</Line> : null}
      {token.inUse ? <Line>In use by a chat right now</Line> : null}
      {token.detail && token.state !== "signed_in" ? <Line>{token.detail}</Line> : null}
      {blocked ? (
        <Line testId={`usage-blocked-${token.id}`}>{blocked}</Line>
      ) : null}
      {usedUp.map((w) => (
        <Line key={w} color={AMBER}>
          {w}
        </Line>
      ))}
      {warnings.map((w) => (
        <Line key={w} color={AMBER}>
          {w}
        </Line>
      ))}
      {error ? (
        <Line color={RED} testId={`usage-switch-error-${token.id}`} role="alert">
          Couldn't switch: {error}
        </Line>
      ) : null}
    </div>
  );
}

function Line({
  children,
  color = MUTED,
  testId,
  role,
}: {
  children: ReactNode;
  color?: string;
  testId?: string;
  role?: string;
}) {
  return (
    <p className="text-[12px]" style={{ color, marginTop: 4, lineHeight: 1.35 }} data-testid={testId} role={role}>
      {children}
    </p>
  );
}

/** Each window: "Session 42% · 3h" and a bar (red from 90%), then how old
 *  the reading is and whether the last check failed — the desktop row's
 *  UsageMeter, one window per line. */
function UsageWindows({ token, now }: { token: LlmToken; now: number }) {
  const usage = token.usage;
  if (!usage) return null;
  const age = checkedAgoText(usageCheckedAtSecs(token), now);
  return (
    <div style={{ marginTop: 8 }} data-testid={`usage-windows-${token.id}`}>
      {usage.windows.map((w) => {
        const pct = percentUsed(w.used);
        const until = formatResetsIn(w.resetsAt, now);
        return (
          <div key={w.label} style={{ marginTop: 6 }}>
            <div className="flex items-center justify-between text-[12px]" style={{ gap: 8 }}>
              <span className="truncate" data-testid={`usage-window-${token.id}-${w.label}`}>
                {w.label} {pct}%
              </span>
              {until ? (
                <span className="shrink-0" style={{ color: MUTED }}>
                  {until === "now" ? "resets now" : `resets in ${until}`}
                </span>
              ) : null}
            </div>
            <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,.12)", marginTop: 3 }}>
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  width: `${pct}%`,
                  background: pct >= 90 ? RED : "var(--accent)",
                }}
                role="meter"
                aria-label={`${w.label} used`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              />
            </div>
          </div>
        );
      })}
      <p className="text-[11px]" style={{ color: MUTED, marginTop: 6 }} data-testid={`usage-age-${token.id}`}>
        {usage.windows.length === 0 && usage.status ? `${usage.status} · ` : ""}
        Usage {age}
        {usage.error ? (
          <span style={{ color: AMBER }}> · last check failed ({usage.error})</span>
        ) : null}
      </p>
    </div>
  );
}
