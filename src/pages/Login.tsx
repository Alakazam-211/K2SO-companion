import { useState } from "react";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  useServersStore,
  loginAndSaveServer,
  hostLabel,
} from "../stores/servers";
import loginLogo from "../assets/login-logo.png";

// The add/edit-server flow (formerly the app-gating Login page). Reached
// from the Servers home: "Add server" (blank) or a row's edit affordance
// (`?server=<id>`, prefilled). A successful sign-in saves the server (+
// token, + password when "Remember password" is on), makes it active, and
// returns to /servers. The password is stored ONLY when the user opts in.

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get("server");
  const editing = useServersStore((s) =>
    s.servers.find((x) => x.id === editId)
  );
  const hasServers = useServersStore((s) => s.servers.length > 0);

  const [nickname, setNickname] = useState(editing?.nickname ?? "");
  const [serverUrl, setServerUrl] = useState(
    editing ? hostLabel(editing.url) : ""
  );
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(editing?.rememberPassword ?? false);
  const [showPassword, setShowPassword] = useState(false);
  // Keyboard-aware height (the chat-pages idiom): the scroll area is sized
  // to the VISUAL viewport, so with the keyboard open the whole form —
  // including Connect/Remove at the bottom — stays scroll-reachable.
  const containerHeight = useViewportHeight();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid =
    serverUrl.length > 0 && username.length > 0 && password.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
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
      rememberPassword: remember,
    });
    setBusy(false);
    if (result.ok) navigate("/servers", { replace: true });
    else setError(result.error);
  };

  const handleRemove = () => {
    if (!editing) return;
    useServersStore.getState().removeServer(editing.id);
    navigate("/servers", { replace: true });
  };

  const inputClass =
    "w-full min-h-[40px] bg-[var(--surface)] border border-[var(--border-hover)] px-4! text-[var(--text)] text-[14px] focus:outline-none focus:border-[var(--accent)] transition-colors";
  const labelClass =
    "text-[var(--text-muted)] text-[10px] uppercase tracking-wide block";

  return (
    <div className="fixed inset-0 z-40 bg-[var(--background)]">
    <div
      className="flex flex-col"
      style={{
        height: containerHeight,
        paddingTop: "env(safe-area-inset-top)",
        overflow: "hidden",
      }}
    >
    <div className="flex-1 flex flex-col items-center px-6! pt-6! pb-12! overflow-y-auto">
      <div className="w-full max-w-sm flex flex-col items-stretch">
        {/* Back to Servers (the home) — hidden on a truly fresh install
            where there is nothing to go back to yet. */}
        {hasServers && (
          <button
            type="button"
            onClick={() => navigate("/servers")}
            className="flex items-center gap-1.5 self-start text-[var(--text-muted)] text-[11px] py-2 -ml-1 hover:text-[var(--text)] transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Servers
          </button>
        )}

        {/* Logo */}
        <img src={loginLogo} alt="K2 by Alakazam Labs" className="w-44 mx-auto! mb-8! mt-4!" />

        <h1 className="text-[var(--text)] text-[14px] font-semibold mb-6! text-center">
          {editing ? "Edit server" : "Add server"}
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>K2 Connect address</label>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="your-name.k2.dev"
              autoCapitalize="off"
              autoCorrect="off"
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              autoCapitalize="off"
              autoCorrect="off"
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className={`${inputClass} pr-11!`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-0 top-0 h-full w-11 flex items-center justify-center text-[var(--text-muted)]"
              >
                {showPassword ? (
                  /* eye-off */
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  /* eye */
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>Nickname (optional)</label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g. Home Mac"
              className={inputClass}
            />
          </div>

          {/* Remember password — opt-in; enables silent re-login when the
              server restarts and the session token goes stale. */}
          <label className="flex items-center gap-2.5 cursor-pointer pt-1">
            <div
              onClick={(e) => {
                e.preventDefault();
                setRemember(!remember);
              }}
              className={`w-5 h-5 border flex items-center justify-center shrink-0 transition-all duration-150 ${
                remember
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border-hover)]"
              }`}
            >
              {remember && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 6l3 3 5-5" />
                </svg>
              )}
            </div>
            <span className="text-[var(--text-muted)] text-[12px]">
              Remember password (auto re-sign-in on this device)
            </span>
          </label>

          {error && (
            <p className="text-[var(--error)] text-[11px] text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={!isValid || busy}
            className="w-full min-h-[40px] bg-white text-black font-semibold text-[14px] mt-2! disabled:opacity-40 hover:bg-gray-200 transition-colors"
          >
            {busy ? "Connecting..." : "Connect & save"}
          </button>
        </form>

        {editing && (
          <button
            type="button"
            onClick={handleRemove}
            className="w-full border border-[var(--error)]/30 text-[var(--error)] font-semibold text-[13px] py-3 mt-6! hover:border-[var(--error)] hover:bg-[var(--error)]/5 transition-all"
          >
            Remove server
          </button>
        )}

        <p className="text-[var(--text-muted)] text-[10px] text-center mt-9! leading-4">
          Sign in with your K2 Connect account to reach your machine
        </p>
      </div>
    </div>
    </div>
    </div>
  );
}
