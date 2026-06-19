import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/auth";
import loginLogo from "../assets/login-logo.png";

// Saved server connection points — server URL + username + a nickname.
// The PASSWORD is never stored; it's always entered fresh at sign-in.
const STORE_KEY = "k2_connections";
const LEGACY_KEY = "k2so_remember"; // single {serverUrl,username} from <2.0

interface Conn {
  id: string;
  nickname: string;
  serverUrl: string;
  username: string;
}

function cid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}`;
}

function loadConnections(): Conn[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as Conn[];
    // One-time migrate the legacy single "remember" entry into the list.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const { serverUrl, username } = JSON.parse(legacy) as { serverUrl?: string; username?: string };
      if (serverUrl && username) {
        const migrated: Conn[] = [{ id: cid(), nickname: serverUrl, serverUrl, username }];
        localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
  } catch { /* ignore */ }
  return [];
}

function persist(conns: Conn[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(conns));
}

export function Login() {
  const { login, isLoading, error, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [connections, setConnections] = useState<Conn[]>(() => loadConnections());
  const first = connections[0];
  const [selectedId, setSelectedId] = useState<string | null>(first?.id ?? null);
  const [nickname, setNickname] = useState(first?.nickname ?? "");
  const [serverUrl, setServerUrl] = useState(first?.serverUrl ?? "");
  const [username, setUsername] = useState(first?.username ?? "");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(true);

  useEffect(() => {
    if (isAuthenticated) navigate("/sessions", { replace: true });
  }, [isAuthenticated, navigate]);

  const isValid = serverUrl.length > 0 && username.length > 0 && password.length > 0;

  const selectConn = (c: Conn) => {
    setSelectedId(c.id);
    setNickname(c.nickname);
    setServerUrl(c.serverUrl);
    setUsername(c.username);
    setPassword(""); // never stored — always re-enter
  };

  const deleteConn = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const next = connections.filter((c) => c.id !== id);
    setConnections(next);
    persist(next);
    if (selectedId === id) setSelectedId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    if (save) {
      const nick = nickname.trim() || serverUrl;
      // Upsert by (serverUrl, username) so re-saving the same connection
      // updates its nickname instead of duplicating it.
      const idx = connections.findIndex(
        (c) => c.serverUrl === serverUrl && c.username === username
      );
      let next: Conn[];
      if (idx >= 0) {
        next = connections.slice();
        next[idx] = { ...next[idx], nickname: nick, serverUrl, username };
      } else {
        next = [{ id: cid(), nickname: nick, serverUrl, username }, ...connections];
      }
      setConnections(next);
      persist(next);
    }

    await login(serverUrl, username, password);
  };

  const inputClass =
    "w-full bg-[var(--surface)] border border-[var(--border-hover)] px-4 py-3.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent)] transition-colors";
  const labelClass =
    "text-[var(--text-muted)] text-[10px] uppercase tracking-wide block";

  return (
    <div className="flex flex-col min-h-full px-6 py-10 pb-safe overflow-y-auto">
      <div className="m-auto w-full max-w-sm flex flex-col">
        {/* Logo */}
        <img src={loginLogo} alt="K2 by Alakazam Labs" className="w-44 mx-auto mb-10" />

        {/* Saved servers — pick one to fill the form */}
        {connections.length > 0 && (
          <div className="mb-7">
            <label className={`${labelClass} mb-2`}>Saved servers</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <select
                  value={selectedId ?? ""}
                  onChange={(e) => {
                    const c = connections.find((x) => x.id === e.target.value);
                    if (c) selectConn(c);
                  }}
                  className="w-full appearance-none bg-[var(--surface)] border border-[var(--border-hover)] pl-4 pr-10 py-3.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent)] transition-colors truncate"
                >
                  <option value="" disabled>Select a saved server…</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nickname} — {c.username}@{c.serverUrl}
                    </option>
                  ))}
                </select>
                <svg className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-muted)]" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 5l4 4 4-4" />
                </svg>
              </div>
              {selectedId && (
                <button
                  type="button"
                  onClick={() => deleteConn(selectedId)}
                  aria-label="Remove saved server"
                  className="w-12 h-12 flex items-center justify-center border border-[var(--border-hover)] text-[var(--text-muted)] shrink-0 hover:border-[var(--error)] hover:text-[var(--error)] transition-colors"
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 4h11M6 4V2.5h4V4M5 4l.5 9h5l.5-9M6.5 6.5v4M9.5 6.5v4" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Divider between saved + a new sign-in */}
        {connections.length > 0 && (
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-[var(--border)]" />
            <span className="text-[var(--text-muted)] text-[10px] uppercase tracking-wide">or sign in</span>
            <div className="flex-1 h-px bg-[var(--border)]" />
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>K2 Connect address</label>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => { setServerUrl(e.target.value); setSelectedId(null); }}
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
              onChange={(e) => { setUsername(e.target.value); setSelectedId(null); }}
              placeholder="Username"
              autoCapitalize="off"
              autoCorrect="off"
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className={inputClass}
            />
          </div>

          {/* Save this server (URL + username only — never the password) */}
          <div className="flex flex-col gap-3 pt-1">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <div
                onClick={() => setSave(!save)}
                className={`w-5 h-5 border flex items-center justify-center shrink-0 transition-all duration-150 ${
                  save ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)]"
                }`}
              >
                {save && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </div>
              <span className="text-[var(--text-muted)] text-[12px]">Save this server (not the password)</span>
            </label>

            {save && (
              <div className="flex flex-col gap-1.5">
                <label className={labelClass}>Save as</label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Nickname (e.g. Home Mac)"
                  className={inputClass}
                />
              </div>
            )}
          </div>

          {error && <p className="text-[var(--error)] text-[11px] text-center">{error}</p>}

          <button
            type="submit"
            disabled={!isValid || isLoading}
            className="w-full bg-white text-black font-semibold text-[13px] py-3.5 mt-1 disabled:opacity-40 hover:bg-gray-200 transition-colors"
          >
            {isLoading ? "Connecting..." : "Connect"}
          </button>
        </form>

        <p className="text-[var(--text-muted)] text-[10px] text-center mt-9 leading-4">
          Sign in with your K2 Connect account to reach your machine
        </p>
      </div>
    </div>
  );
}
