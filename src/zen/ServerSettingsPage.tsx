import { useEffect, useState, type ReactNode } from "react";
import { scopeFor } from "../api/scope";
import { useBackHandler } from "../lib/androidBack";
import { readBackPreviews, setServerPreviews } from "../lib/push";
import { useSwipeBack } from "../lib/useSwipeBack";
import { useSessionIdentity } from "../lib/useSessionIdentity";
import { serverBellStatus, useNotifyPrefsStore } from "../stores/notifyPrefs";
import { usePushPreviewsStore } from "../stores/pushPreviews";
import { hostLabel, signOutServer, useServersStore, type RecoveryState } from "../stores/servers";
import { RECOVERY_DOT, STATE_LABEL } from "./serverList";
import { ServerUpdateSection } from "./ServerUpdateSection";
import { Switch } from "./ZenSettings";
import { underHeaderPadding, useMeasuredHeight, ZenHeaderBlur } from "./ZenHeaderBlur";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";
const RED = "#ef4444";
const PILL_H = 36;
/** Resting header content height (below the safe area): title + subtitle. */
export const SERVER_SETTINGS_HEADER_PX = 60;

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** whoami role, else "owner" for the host token on a daemon without roles. */
export function identityRole(
  identity: { owner: boolean; role?: string | null } | null
): string | null {
  if (!identity) return null;
  if (identity.role) return identity.role;
  return identity.owner ? "owner" : null;
}

/** Server settings (Servers card → gear): one saved server's nickname,
 *  address, who this phone is signed in as and with which role, its
 *  connection state, its K2 version and remote update (`ServerUpdateSection`,
 *  Owner / Admin), shortcuts to its notifications and Usage, and
 *  sign out / remove. A full page over the Servers sheet like Usage: the
 *  glass back chevron, Android Back and the left-edge swipe all go back. */
export function ServerSettingsPage({
  serverId,
  onBack,
  onOpenUsage,
}: {
  serverId: string;
  onBack: () => void;
  onOpenUsage: () => void;
}) {
  const scope = scopeFor(serverId);
  const entry = useServersStore((s) => s.servers.find((x) => x.id === serverId));
  const token = useServersStore((s) => s.tokens[serverId] ?? "");
  const state: RecoveryState = useServersStore((s) => s.recovery[serverId] ?? "signin-required");
  const identity = useSessionIdentity(scope);
  const role = token ? identityRole(identity) : null;
  const [headerRef, headerPx] = useMeasuredHeight(SERVER_SETTINGS_HEADER_PX);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Android Back = the back chevron; the left-edge swipe too, while
  // nothing (Usage) sits over the page. The Servers sheet shows underneath.
  const onTop = useBackHandler(true, onBack);
  const swipeRef = useSwipeBack(onBack, { enabled: onTop });

  // Removed elsewhere while open: nothing left to show.
  const gone = !entry;
  useEffect(() => {
    if (gone) onBack();
  }, [gone, onBack]);
  if (!entry) return null;

  const label = entry.nickname || hostLabel(entry.url);
  const dot = RECOVERY_DOT[state];
  const stateText = state === "connected" ? "Connected" : STATE_LABEL[state];

  return (
    <div
      ref={swipeRef}
      className="absolute inset-0 flex flex-col min-w-0 overflow-x-hidden"
      style={{ background: "#000", zIndex: 7, fontFamily: "var(--zen-font)" }}
      data-testid="server-settings-page"
    >
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-testid="server-settings-header"
        style={{ zIndex: 3, paddingTop: "env(safe-area-inset-top)", pointerEvents: "none" }}
      >
        <ZenHeaderBlur testId="server-settings-header-blur" />
        <div
          ref={headerRef}
          className="relative w-full min-w-0 grid items-center"
          style={{ gridTemplateColumns: "1fr auto 1fr", padding: "12px 12px 10px", columnGap: 8 }}
        >
          <button
            type="button"
            onClick={onBack}
            data-testid="server-settings-back"
            className="flex items-center justify-center shrink-0 justify-self-start zen-glass zen-glass-pill"
            style={{ width: PILL_H, height: PILL_H, color: "#fff", pointerEvents: "auto" }}
            aria-label="Back to servers"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="min-w-0 flex flex-col items-center zen-header-text pointer-events-none">
            <h1
              className="text-[17px] font-semibold leading-tight truncate max-w-[60vw]"
              data-testid="server-settings-title"
            >
              {label}
            </h1>
            <span className="text-[12px]" style={{ color: MUTED }}>
              Server settings
            </span>
          </div>
          <span />
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
        data-testid="server-settings-scroll"
      >
        <Group label="Server" testId="server-settings-server">
          <NicknameRow serverId={serverId} hostFallback={hostLabel(entry.url)} />
          <ValueRow label="Address" value={hostLabel(entry.url)} testId="server-settings-address" divider />
          {token ? (
            <>
              <ValueRow
                label="Signed in as"
                value={identity?.username ?? entry.username}
                testId="server-settings-username"
                divider
              />
              <ValueRow
                label="Role"
                value={role ? ROLE_LABEL[role] ?? role : identity ? "Unknown" : "…"}
                testId="server-settings-role"
                divider
              />
            </>
          ) : (
            <ValueRow label="Signed in as" value="Signed out" testId="server-settings-username" divider />
          )}
          <ValueRow
            label="Status"
            divider
            testId="server-settings-status"
            value={
              <span className="inline-flex items-center" style={{ gap: 8, color: dot }}>
                <span
                  className="shrink-0"
                  style={{ width: 8, height: 8, borderRadius: "50%", background: dot }}
                  aria-hidden
                />
                {stateText}
              </span>
            }
          />
        </Group>

        <Group label="K2 version" testId="server-settings-version">
          <ServerUpdateSection serverId={serverId} scope={scope} role={role} />
        </Group>

        <ShortcutsGroup serverId={serverId} label={label} hasToken={!!token} onOpenUsage={onOpenUsage} />

        <Group label="Danger zone" testId="server-settings-danger">
          {token ? (
            <button
              type="button"
              className="w-full text-left text-[17px]"
              style={{ minHeight: 44, padding: "11px 16px", color: RED }}
              data-testid="server-settings-signout"
              onClick={() => {
                signOutServer(serverId);
                onBack();
              }}
            >
              Sign out
            </button>
          ) : null}
          {confirmingRemove ? (
            <div
              style={{ padding: "12px 16px", borderTop: token ? HAIRLINE : undefined }}
              data-testid="server-settings-remove-confirm"
            >
              <p className="text-[13px]" style={{ color: MUTED, lineHeight: 1.35 }}>
                Remove {label} from this phone? You will need to sign in again to add it back.
              </p>
              <div className="flex" style={{ gap: 10, marginTop: 10 }}>
                <button
                  type="button"
                  className="flex-1 text-[17px] k2-tile"
                  style={{ minHeight: 40, borderRadius: 12, color: "#fff" }}
                  data-testid="server-settings-remove-cancel"
                  onClick={() => setConfirmingRemove(false)}
                >
                  Keep server
                </button>
                <button
                  type="button"
                  className="flex-1 text-[17px] font-semibold"
                  style={{ minHeight: 40, borderRadius: 12, color: "#fff", background: RED }}
                  data-testid="server-settings-remove-confirm-button"
                  onClick={() => {
                    useServersStore.getState().removeServer(serverId);
                    onBack();
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="w-full text-left text-[17px]"
              style={{
                minHeight: 44,
                padding: "11px 16px",
                color: RED,
                borderTop: token ? HAIRLINE : undefined,
              }}
              data-testid="server-settings-remove"
              onClick={() => setConfirmingRemove(true)}
            >
              Remove server
            </button>
          )}
        </Group>
      </div>
    </div>
  );
}

/** Nickname, edited in place (`upsertServer` with the same id and URL).
 *  Saved on Return or when the field loses focus; blank falls back to the
 *  host, as on the Add server form. */
function NicknameRow({ serverId, hostFallback }: { serverId: string; hostFallback: string }) {
  const nickname = useServersStore(
    (s) => s.servers.find((x) => x.id === serverId)?.nickname ?? ""
  );
  const [draft, setDraft] = useState(nickname);
  useEffect(() => setDraft(nickname), [nickname]);

  const commit = () => {
    const next = draft.trim();
    const store = useServersStore.getState();
    const current = store.servers.find((x) => x.id === serverId);
    if (!current || next === current.nickname) {
      setDraft(current?.nickname ?? "");
      return;
    }
    store.upsertServer({ ...current, nickname: next });
  };

  return (
    <label
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "6px 16px", gap: 16 }}
    >
      <span className="shrink-0">Nickname</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder={hostFallback}
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="done"
        className="flex-1 min-w-0 text-right bg-transparent outline-none"
        style={{ color: MUTED, fontSize: 17 }}
        aria-label="Nickname"
        data-testid="server-settings-nickname"
      />
    </label>
  );
}

/** Notifications (the Servers card bell's toggle, hidden where the bell
 *  is) and Usage (the card's gauge, shown with a session token). */
function ShortcutsGroup({
  serverId,
  label,
  hasToken,
  onOpenUsage,
}: {
  serverId: string;
  label: string;
  hasToken: boolean;
  onOpenUsage: () => void;
}) {
  const pushOn = useNotifyPrefsStore((s) => s.threadPush[serverId] === true);
  const prefs = useNotifyPrefsStore((s) => s.prefs[serverId]);
  const error = useNotifyPrefsStore((s) => s.errors[serverId] ?? null);
  const previewsFeature = usePushPreviewsStore((s) => s.feature[serverId] === true);
  useEffect(() => {
    if (pushOn) void readBackPreviews(serverId);
  }, [serverId, pushOn]);
  const showBell = pushOn && !!prefs;
  if (!showBell && !hasToken) return null;
  const labelId = `server-settings-notify-label-${serverId}`;
  return (
    <Group label="Shortcuts" testId="server-settings-shortcuts">
      {showBell && prefs ? (
        <div
          className="flex items-center justify-between"
          style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12 }}
          data-testid="server-settings-notify"
        >
          <span className="min-w-0 flex flex-col">
            <span className="text-[17px]" id={labelId}>
              Notifications
            </span>
            <span
              className="text-[13px] truncate"
              style={{ color: error ? RED : MUTED }}
              data-testid="server-settings-notify-status"
            >
              {error ? `Could not save: ${error}` : serverBellStatus(prefs)}
            </span>
          </span>
          <Switch
            on={prefs.server.enabled}
            disabled={false}
            labelledBy={labelId}
            onToggle={() =>
              void useNotifyPrefsStore
                .getState()
                .setServerEnabled(serverId, !prefs.server.enabled)
            }
          />
        </div>
      ) : null}
      {showBell && prefs?.server.enabled && previewsFeature ? (
        <PreviewsRow serverId={serverId} />
      ) : null}
      {hasToken ? (
        <button
          type="button"
          className="w-full flex items-center justify-between text-left text-[17px]"
          style={{
            minHeight: 44,
            padding: "11px 16px",
            borderTop: showBell ? HAIRLINE : undefined,
          }}
          aria-label={`Usage on ${label}`}
          data-testid="server-settings-usage"
          onClick={onOpenUsage}
        >
          <span>Usage</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      ) : null}
    </Group>
  );
}

/** Notifications sub-row (K2 0.46.1 `push-previews-v1`): this phone's
 *  "Show message previews" pref for the server. Toggling re-registers
 *  with the server (`setServerPreviews`). The owner's master switch
 *  (`previewsAllowed` false) locks it off. */
function PreviewsRow({ serverId }: { serverId: string }) {
  const pref = usePushPreviewsStore((s) => s.previews[serverId] ?? true);
  const allowed = usePushPreviewsStore((s) => s.allowed[serverId] !== false);
  const error = usePushPreviewsStore((s) => s.errors[serverId] ?? null);
  const labelId = `server-settings-previews-label-${serverId}`;
  const status =
    error ??
    (allowed
      ? "Show the first lines of new messages in notifications."
      : "Turned off by the server owner");
  return (
    <div
      className="flex items-center justify-between"
      style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12, borderTop: HAIRLINE }}
      data-testid="server-settings-previews"
    >
      <span className="min-w-0 flex flex-col">
        <span className="text-[17px]" id={labelId}>
          Show message previews
        </span>
        <span
          className="text-[13px]"
          style={{ color: error ? RED : MUTED, lineHeight: 1.35 }}
          data-testid="server-settings-previews-status"
        >
          {status}
        </span>
      </span>
      <Switch
        on={allowed && pref}
        disabled={!allowed}
        labelledBy={labelId}
        onToggle={() => void setServerPreviews(serverId, !pref)}
      />
    </div>
  );
}

function Group({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 20 }} data-testid={testId}>
      <h2
        className="text-[12px] uppercase tracking-wide font-normal"
        style={{ color: MUTED, padding: "0 16px 6px" }}
      >
        {label}
      </h2>
      <div className="k2-tile overflow-hidden" style={{ borderRadius: 14 }}>
        {children}
      </div>
    </section>
  );
}

function ValueRow({
  label,
  value,
  divider,
  testId,
}: {
  label: string;
  value: ReactNode;
  divider?: boolean;
  testId?: string;
}) {
  return (
    <div
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "11px 16px", borderTop: divider ? HAIRLINE : undefined, gap: 16 }}
    >
      <span className="shrink-0">{label}</span>
      <span className="truncate text-right" style={{ color: MUTED }} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
