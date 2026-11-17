import { useState, type CSSProperties, type FormEvent } from "react";
import {
  hostLabel,
  isPairedServer,
  loginAndSaveServer,
  normalizeServerUrl,
  useServersStore,
} from "../stores/servers";
import type { PairLink } from "../lib/pairLinks";
import { mustChangeHeld } from "../api/scope";
import { PairForm } from "./PairForm";
import { useZenStore } from "./zenStore";
import { useBackHandler } from "../lib/androidBack";
import { pool } from "./multi/pool";
import { EyeIcon, EyeOffIcon } from "./PasswordEye";
import { SetPasswordStep } from "./SetPasswordStep";
import type { SetPasswordTarget } from "./setPasswordFlow";

/** "Set your new password" in this sheet: after a sign-in that answered
 *  `mustChangePassword` (`minted`, the temporary password just typed), or
 *  for a saved login already in that state (`held`, asks for it). */
type Rotation = {
  target: SetPasswordTarget;
  minted: string | null;
  held: string | null;
};

/** A saved password login the server says must change its password. */
function mustChangeOnOpen(serverId: string | null | undefined): Rotation | null {
  if (!serverId) return null;
  const s = useServersStore.getState();
  const server = s.servers.find((x) => x.id === serverId);
  if (!server || isPairedServer(server)) return null;
  const token = s.tokens[serverId] ?? "";
  if (pool.entry(serverId)?.auth !== "rotate-required" && !mustChangeHeld(serverId, token)) return null;
  return {
    target: {
      serverId,
      url: server.url,
      username: server.username,
      nickname: server.nickname,
      activate: false,
    },
    minted: null,
    held: token || null,
  };
}

/** Overlay Add / Edit server. Donor is `Login.tsx` / `loginAndSaveServer`.
 *  Zero stored servers lands here. The in-overlay server list reuses it
 *  with `editingId` / `onCancel` so a sign-in never leaves `/zen`. */
export function OverlayAddServer({
  editingId,
  onCancel,
  onSaved,
  activate = true,
  onSignedIn,
  pairLink,
}: {
  editingId?: string | null;
  onCancel?: () => void;
  onSaved?: () => void;
  /** Make it the active server and reload the list (default). False: a
   *  row's "Sign in" in the multi-server list signs in to THAT server
   *  without switching (MS34, MA3). */
  activate?: boolean;
  /** After a successful sign-in, with the saved server's id. */
  onSignedIn?: (id: string) => void;
  /** Opened from a pair link: start on "Pairing code", filled in. */
  pairLink?: PairLink | null;
} = {}) {
  const editing = useServersStore((s) =>
    editingId ? s.servers.find((x) => x.id === editingId) : undefined
  );
  const [serverUrl, setServerUrl] = useState(editing ? hostLabel(editing.url) : "");
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState(editing?.nickname ?? "");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // K2 0.46.4 pairing: a paired server's way back is a new code, never a
  // password; a password server can switch to pairing here too.
  const [mode, setMode] = useState<"password" | "pair">(
    pairLink || isPairedServer(editing) ? "pair" : "password"
  );
  // A pairing in flight locks Cancel and the tabs; "Paired" hides them
  // (its Done is the way out).
  const [pairPhase, setPairPhase] = useState<"idle" | "busy" | "done" | "password">("idle");
  // "Change password on {server}" opens straight on the new-password step.
  const [rotation, setRotation] = useState<Rotation | null>(() => {
    const r = mustChangeOnOpen(editingId);
    return r ? { ...r, target: { ...r.target, activate } } : null;
  });
  const canCancel = Boolean(onCancel) && (pairPhase === "idle" || pairPhase === "password");
  const hideTabs = pairPhase === "done" || pairPhase === "password" || rotation !== null;
  // Android Back = Cancel. Without one (no server saved yet) there is
  // nothing to go back to, so Back falls through.
  useBackHandler(Boolean(onCancel) && pairPhase !== "busy", () =>
    pairPhase === "done" ? onSaved?.() : onCancel?.()
  );
  const isValid = serverUrl.length > 0 && username.length > 0 && password.length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValid || busy) return;
    setBusy(true);
    setError(null);
    const result = await loginAndSaveServer({
      id: editing?.id,
      nickname,
      url: serverUrl,
      username,
      password,
      rememberPassword: false,
      activate,
    });
    if (!result.ok && result.mustChange) {
      // A temporary password: choose a new one before anything is saved.
      const m = result.mustChange;
      setBusy(false);
      setRotation({
        target: { serverId: m.id, url: m.url, username: m.username, nickname: m.nickname, activate },
        minted: m.token,
        held: null,
      });
      return;
    }
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    // Still "Connecting..." while the server list reloads, until the overlay closes.
    try {
      await done(result.id);
    } finally {
      setBusy(false);
    }
  };

  /** Signed in or paired: tell the caller, reload the list when active. */
  const finish = async (id: string) => {
    onSignedIn?.(id);
    if (activate) await useZenStore.getState().hydrateAgents();
  };
  const done = async (id: string) => {
    await finish(id);
    onSaved?.();
  };

  const field: CSSProperties = {
    width: "100%",
    minHeight: 40,
    padding: "0 14px",
    borderRadius: 10,
    color: "var(--color-text-primary)",
    fontSize: 16,
  };

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "var(--color-bg)", color: "var(--color-text-primary)" }}
      data-testid="overlay-add-server"
    >
      <header
        className={onCancel ? "flex items-center justify-between relative shrink-0" : "shrink-0"}
        style={{
          minHeight: 44,
          padding: "12px 16px 8px",
        }}
      >
        {onCancel ? (
          <button
            type="button"
            className="text-[17px] k2-tile"
            style={{
              minHeight: 34,
              padding: "0 14px",
              borderRadius: 17,
              opacity: canCancel ? 1 : 0.35,
              visibility: pairPhase === "done" ? "hidden" : undefined,
            }}
            disabled={!canCancel}
            onClick={onCancel}
            data-testid="add-server-cancel"
          >
            Cancel
          </button>
        ) : null}
        <h1
          className={
            onCancel
              ? "absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none"
              : "text-center text-[17px] font-semibold"
          }
        >
          {mode === "pair" && isPairedServer(editing) ? "Pair again" : editing ? "Edit server" : "Add server"}
        </h1>
        {onCancel ? <span style={{ width: 72 }} /> : null}
      </header>
      {hideTabs ? null : (
      <div className="shrink-0 px-6 pb-3">
        <div
          className="k2-tile flex"
          role="tablist"
          style={{ borderRadius: 10, padding: 2 }}
          data-testid="add-server-mode"
        >
          {(["pair", "password"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className="flex-1 text-[14px] font-semibold"
              style={{
                minHeight: 32,
                borderRadius: 8,
                color: "var(--color-text-primary)",
                background: mode === m ? "var(--color-wash-3)" : "transparent",
              }}
              disabled={pairPhase !== "idle"}
              onClick={() => setMode(m)}
              data-testid={`add-server-mode-${m}`}
            >
              {m === "pair" ? "Pairing code" : "Password"}
            </button>
          ))}
        </div>
      </div>
      )}
      {rotation ? (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
          <SetPasswordStep
            key={rotation.minted ?? rotation.held ?? "ask"}
            target={rotation.target}
            serverLabel={hostLabel(normalizeServerUrl(rotation.target.url))}
            mintedToken={rotation.minted}
            heldToken={rotation.held}
            initialCurrentPassword={rotation.minted ? password : ""}
            askCurrent={!rotation.minted}
            onDone={async (id) => {
              setPassword("");
              await done(id);
            }}
            onBack={() => {
              setRotation(null);
              setMode("password");
            }}
          />
        </div>
      ) : mode === "pair" ? (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-8">
          <PairForm
            editingId={editing?.id ?? null}
            initialServerUrl={pairLink?.serverUrl ?? null}
            initialCode={pairLink?.code ?? null}
            activate={activate}
            onPaired={finish}
            onDone={() => onSaved?.()}
            onPhase={setPairPhase}
          />
        </div>
      ) : (
      <form
        className="flex-1 min-h-0 overflow-y-auto px-6 pb-8 flex flex-col gap-4"
        onSubmit={(e) => void onSubmit(e)}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
            K2 Connect address
          </span>
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="your-name.k2.dev"
            autoCapitalize="off"
            autoCorrect="off"
            className="k2-tile"
            style={field}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
            Username
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoCapitalize="off"
            autoCorrect="off"
            className="k2-tile"
            style={field}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
            Password
          </span>
          <span className="relative block">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="k2-tile"
              style={{ ...field, paddingRight: 44 }}
            />
            <button
              type="button"
              className="absolute right-0 top-0 flex h-full w-11 items-center justify-center"
              style={{ color: "var(--color-text-muted)" }}
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
            Nickname (optional)
          </span>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="e.g. Home Mac"
            className="k2-tile"
            style={field}
          />
        </label>
        {error ? (
          <p className="text-[13px] text-center" style={{ color: "var(--color-status-error-text)" }}>
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!isValid || busy}
          className="w-full font-semibold"
          style={{
            minHeight: 44,
            borderRadius: 12,
            background: "var(--color-accent-fill)",
            color: "var(--color-on-accent)",
            opacity: !isValid || busy ? 0.4 : 1,
          }}
        >
          {busy ? "Connecting..." : "Connect & save"}
        </button>
        {editing ? (
          confirmingRemove ? (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-center" style={{ color: "var(--color-text-muted)" }}>
                Remove this server from the phone? You will need to sign in again to add it back.
              </p>
              <button
                type="button"
                className="w-full text-[17px] font-semibold"
                style={{ minHeight: 44, color: "var(--color-on-danger)", background: "var(--color-danger)", borderRadius: 12 }}
                onClick={() => {
                  useServersStore.getState().removeServer(editing.id);
                  onCancel?.();
                }}
              >
                Remove server
              </button>
              <button
                type="button"
                className="w-full text-[17px]"
                style={{ minHeight: 44, color: "var(--color-text-muted)" }}
                onClick={() => setConfirmingRemove(false)}
              >
                Keep server
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="w-full text-[17px]"
              style={{ minHeight: 44, color: "var(--color-status-error-text)" }}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </button>
          )
        ) : null}
        <p className="text-[11px] text-center" style={{ color: "var(--color-text-muted)" }}>
          Sign in with your K2 Connect account to reach your machine
        </p>
      </form>
      )}
    </div>
  );
}
