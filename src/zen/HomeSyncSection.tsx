import { useEffect, useState, type ReactNode } from "react";
import { hostLabel, useServersStore } from "../stores/servers";
import {
  agoText,
  disableHomesSync,
  dismissHomesSyncNotice,
  enableHomesSync,
  homesSyncStatusText,
  loadHomesDevices,
  probeHomesSync,
  removeHomesSyncDevice,
  useHomesSyncStore,
} from "./homesSync";
import { Switch } from "./ZenSettings";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";
const RED = "#ef4444";

const PLATFORM_LABEL: Record<string, string> = {
  ios: "iOS",
  android: "Android",
  macos: "macOS",
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
  web: "Web",
  desktop: "Desktop",
};

/**
 * Server settings → "Home sync" (K2 0.46.1 `homes-sync-v1`), shown only
 * when this server offers it and this phone is signed in there. The
 * switch makes this server the ONE server the phone's Homes sync through
 * (moving from another asks first); off removes this phone there and
 * keeps the Homes as they are. Below: the status line and the devices
 * syncing from this server, each removable.
 */
export function HomeSyncSection({ serverId, label }: { serverId: string; label: string }) {
  const hasToken = useServersStore((s) => (s.tokens[serverId] ?? "").length > 0);
  const feature = useHomesSyncStore((s) => s.feature[serverId] === true);
  const syncServer = useHomesSyncStore((s) => s.serverId);
  const status = useHomesSyncStore((s) => s.status);
  const error = useHomesSyncStore((s) => s.error);
  const lastSyncAt = useHomesSyncStore((s) => s.lastSyncAt);
  const busy = useHomesSyncStore((s) => s.busy);
  const notice = useHomesSyncStore((s) => s.notice);
  const devices = useHomesSyncStore((s) => s.devices[serverId]);
  const devicesError = useHomesSyncStore((s) => s.devicesError[serverId] ?? null);
  const otherLabel = useServersStore((s) => {
    const e = syncServer && syncServer !== serverId ? s.servers.find((x) => x.id === syncServer) : null;
    return e ? e.nickname || hostLabel(e.url) : null;
  });
  const [confirmMove, setConfirmMove] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const on = syncServer === serverId;

  useEffect(() => {
    if (hasToken) void probeHomesSync(serverId);
  }, [serverId, hasToken]);
  useEffect(() => {
    if (on && hasToken) void loadHomesDevices(serverId);
  }, [on, serverId, hasToken]);

  const myNotice = notice && notice.serverId === serverId ? notice : null;
  // While this IS the sync server the section stays (signed out, or the
  // feature gone), so the switch can always be turned off.
  if (!on && (!hasToken || !feature)) return null;

  const start = async () => {
    setConfirmMove(false);
    setStartError(null);
    const ok = await enableHomesSync(serverId);
    if (!ok) setStartError(useHomesSyncStore.getState().error || "Could not start Home sync");
  };
  const toggle = () => {
    if (busy) return;
    if (on) {
      setStartError(null);
      void disableHomesSync();
      return;
    }
    if (syncServer && syncServer !== serverId) {
      setConfirmMove(true);
      return;
    }
    void start();
  };

  const labelId = `server-settings-homesync-label-${serverId}`;
  const statusText = startError
    ? startError
    : on
      ? homesSyncStatusText({ serverId: syncServer, status, error, lastSyncAt })
      : otherLabel
        ? `Home syncs with ${otherLabel}`
        : "Not synced";
  const statusRed = !!startError || (on && status === "error");

  return (
    <section style={{ marginTop: 20 }} data-testid="server-settings-homesync">
      <h2 className="text-[12px] uppercase tracking-wide font-normal" style={{ color: MUTED, padding: "0 16px 6px" }}>
        Home sync
      </h2>
      <div className="k2-tile overflow-hidden" style={{ borderRadius: 14 }}>
        {myNotice ? (
          <div
            className="flex items-start justify-between"
            style={{ padding: "10px 12px 10px 16px", gap: 12, borderBottom: HAIRLINE }}
            data-testid="homesync-removed-notice"
          >
            <span className="text-[13px]" style={{ color: "#ffd60a", lineHeight: 1.35 }}>
              This phone was removed from Home sync on {myNotice.label}.
            </span>
            <button
              type="button"
              className="shrink-0 text-[13px] font-semibold"
              style={{ color: "#0a84ff" }}
              onClick={dismissHomesSyncNotice}
              data-testid="homesync-removed-notice-ok"
            >
              OK
            </button>
          </div>
        ) : null}
        <div
          className="flex items-center justify-between"
          style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12 }}
          data-testid="server-settings-homesync-row"
        >
          <span className="min-w-0 flex flex-col">
            <span className="text-[17px]" id={labelId}>
              Sync my Home with this server
            </span>
            <span
              className="text-[13px]"
              style={{ color: statusRed ? RED : MUTED, lineHeight: 1.35 }}
              data-testid="homesync-status"
            >
              {busy && !on ? "Syncing…" : statusText}
            </span>
          </span>
          <Switch on={on} disabled={busy} labelledBy={labelId} onToggle={toggle} />
        </div>
        {confirmMove ? (
          <Confirm
            text={`Move Home sync from ${otherLabel ?? "the other server"} to this server?`}
            yes="Move"
            onYes={() => void start()}
            onNo={() => setConfirmMove(false)}
            testId="homesync-move-confirm"
          />
        ) : null}
        {on ? (
          <div style={{ borderTop: HAIRLINE }} data-testid="homesync-devices">
            <p className="text-[13px]" style={{ color: MUTED, padding: "10px 16px 4px" }}>
              Devices syncing from this server
            </p>
            {devicesError ? (
              <p className="text-[13px]" style={{ color: RED, padding: "0 16px 8px" }} data-testid="homesync-devices-error">
                {devicesError}
              </p>
            ) : null}
            {!devices ? (
              <p className="text-[13px]" style={{ color: MUTED, padding: "0 16px 10px" }}>
                …
              </p>
            ) : devices.length === 0 ? (
              <p className="text-[13px]" style={{ color: MUTED, padding: "0 16px 10px" }}>
                None
              </p>
            ) : (
              devices.map((d) => (
                <div key={d.deviceId} data-testid={`homesync-device-${d.deviceId}`}>
                  <div className="flex items-center justify-between" style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12 }}>
                    <span className="min-w-0 flex flex-col">
                      <span className="text-[16px] truncate">
                        {d.name}
                        {d.current ? (
                          <span className="text-[13px]" style={{ color: MUTED }} data-testid="homesync-this-phone">
                            {" "}· This phone
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[12px]" style={{ color: MUTED }}>
                        {[PLATFORM_LABEL[d.platform.toLowerCase()] ?? d.platform, d.lastSyncAt ? `last sync ${agoText(d.lastSyncAt)}` : "never synced"]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-[15px]"
                      style={{ color: RED, minHeight: 36, padding: "0 4px" }}
                      onClick={() => setConfirmRemove(d.deviceId)}
                      aria-label={`Remove ${d.name}`}
                      data-testid={`homesync-device-remove-${d.deviceId}`}
                    >
                      Remove
                    </button>
                  </div>
                  {confirmRemove === d.deviceId ? (
                    <Confirm
                      text={
                        d.current
                          ? "Stop syncing this phone's Home? Your Homes stay on this phone."
                          : `Remove ${d.name} from Home sync? It keeps its Homes but stops syncing.`
                      }
                      yes="Remove"
                      danger
                      onYes={() => {
                        setConfirmRemove(null);
                        void removeHomesSyncDevice(serverId, d.deviceId);
                      }}
                      onNo={() => setConfirmRemove(null)}
                      testId="homesync-device-remove-confirm"
                    />
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
      <p className="text-[12px]" style={{ color: MUTED, padding: "6px 16px 0", lineHeight: 1.35 }}>
        Your Homes stay on this phone and work offline. {label} keeps a copy so your other devices see the same Homes.
      </p>
    </section>
  );
}

function Confirm({
  text,
  yes,
  danger,
  onYes,
  onNo,
  testId,
}: {
  text: ReactNode;
  yes: string;
  danger?: boolean;
  onYes: () => void;
  onNo: () => void;
  testId: string;
}) {
  return (
    <div style={{ padding: "10px 16px 12px", borderTop: HAIRLINE }} data-testid={testId}>
      <p className="text-[13px]" style={{ color: MUTED, lineHeight: 1.35 }}>
        {text}
      </p>
      <div className="flex" style={{ gap: 10, marginTop: 10 }}>
        <button
          type="button"
          className="flex-1 text-[16px] k2-tile"
          style={{ minHeight: 38, borderRadius: 12, color: "#fff" }}
          onClick={onNo}
          data-testid={`${testId}-cancel`}
        >
          Cancel
        </button>
        <button
          type="button"
          className="flex-1 text-[16px] font-semibold"
          style={{ minHeight: 38, borderRadius: 12, color: "#fff", background: danger ? RED : "#0a84ff" }}
          onClick={onYes}
          data-testid={`${testId}-yes`}
        >
          {yes}
        </button>
      </div>
    </div>
  );
}
