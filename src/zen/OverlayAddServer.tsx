import { useState, type CSSProperties, type FormEvent } from "react";
import { hostLabel, loginAndSaveServer, useServersStore } from "../stores/servers";
import { useZenStore } from "./zenStore";
import { useBackHandler } from "../lib/androidBack";

/** Overlay Add / Edit server. Donor is `Login.tsx` / `loginAndSaveServer`.
 *  Zero stored servers lands here. The in-overlay server list reuses it
 *  with `editingId` / `onCancel` so a sign-in never leaves `/zen`. */
export function OverlayAddServer({
  editingId,
  onCancel,
  onSaved,
  activate = true,
  onSignedIn,
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
  // Android Back = Cancel. Without one (no server saved yet) there is
  // nothing to go back to, so Back falls through.
  useBackHandler(Boolean(onCancel), () => onCancel?.());
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
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSignedIn?.(result.id);
    if (activate) await useZenStore.getState().hydrateAgents();
    onSaved?.();
  };

  const field: CSSProperties = {
    width: "100%",
    minHeight: 40,
    padding: "0 14px",
    borderRadius: 10,
    color: "#fff",
    fontSize: 16,
  };

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "#000", color: "#fff" }}
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
            }}
            onClick={onCancel}
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
          {editing ? "Edit server" : "Add server"}
        </h1>
        {onCancel ? <span style={{ width: 72 }} /> : null}
      </header>
      <form
        className="flex-1 min-h-0 overflow-y-auto px-6 pb-8 flex flex-col gap-4"
        onSubmit={(e) => void onSubmit(e)}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>
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
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>
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
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>
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
              style={{ color: "#8e8e93" }}
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>
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
          <p className="text-[13px] text-center" style={{ color: "#ef4444" }}>
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
            background: "#0a84ff",
            color: "#fff",
            opacity: !isValid || busy ? 0.4 : 1,
          }}
        >
          {busy ? "Connecting..." : "Connect & save"}
        </button>
        {editing ? (
          confirmingRemove ? (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-center" style={{ color: "#8e8e93" }}>
                Remove this server from the phone? You will need to sign in again to add it back.
              </p>
              <button
                type="button"
                className="w-full text-[17px] font-semibold"
                style={{ minHeight: 44, color: "#fff", background: "#ef4444", borderRadius: 12 }}
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
                style={{ minHeight: 44, color: "#8e8e93" }}
                onClick={() => setConfirmingRemove(false)}
              >
                Keep server
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="w-full text-[17px]"
              style={{ minHeight: 44, color: "#ef4444" }}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </button>
          )
        ) : null}
        <p className="text-[11px] text-center" style={{ color: "#8e8e93" }}>
          Sign in with your K2 Connect account to reach your machine
        </p>
      </form>
    </div>
  );
}

/** Open eye: password is hidden, tap to show (iOS convention). */
function EyeIcon() {
  return (
    <svg
      data-testid="password-eye-open"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Eye with a slash: password is visible, tap to hide. */
function EyeOffIcon() {
  return (
    <svg
      data-testid="password-eye-off"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.8 3.8" />
      <path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
