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

  const deleteConn = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
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

  return (
    <div className="flex flex-col items-center justify-center min-h-full px-6 py-8 pb-safe overflow-y-auto">
      <div className="text-center mb-6">
        <img src={loginLogo} alt="K2 by Alakazam Labs" className="w-44 mx-auto" />
      </div>

      {/* Saved servers — tap to switch */}
      {connections.length > 0 && (
        <div className="w-full max-w-sm mb-4">
          <label className="text-[var(--text-muted)] text-[10px] mb-1.5 block">Saved servers</label>
          <div className="flex flex-col gap-1.5">
            {connections.map((c) => (
              <div
                key={c.id}
                onClick={() => selectConn(c)}
                className={`flex items-center gap-2 px-3 py-2.5 border cursor-pointer transition-colors ${
                  selectedId === c.id
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-hover)]"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--text)] text-[13px] font-medium truncate">{c.nickname}</div>
                  <div className="text-[var(--text-muted)] text-[10px] truncate">{c.username} @ {c.serverUrl}</div>
                </div>
                <button
                  type="button"
                  onClick={(e) => deleteConn(c.id, e)}
                  aria-label="Remove saved server"
                  className="w-7 h-7 flex items-center justify-center text-[var(--text-muted)] shrink-0"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 2l8 8M10 2l-8 8" /></svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3">
        <div>
          <label className="text-[var(--text-muted)] text-[10px] mb-1 block">Nickname (optional)</label>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Home Mac"
            className="w-full bg-[var(--surface)] border border-[var(--border)] px-4 py-3.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)] transition-colors"
          />
        </div>

        <div>
          <label className="text-[var(--text-muted)] text-[10px] mb-1 block">K2 Connect address</label>
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => { setServerUrl(e.target.value); setSelectedId(null); }}
            placeholder="your-name.k2.dev"
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full bg-[var(--surface)] border border-[var(--border)] px-4 py-3.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)] transition-colors"
          />
        </div>

        <div>
          <label className="text-[var(--text-muted)] text-[10px] mb-1 block">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => { setUsername(e.target.value); setSelectedId(null); }}
            placeholder="Username"
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full bg-[var(--surface)] border border-[var(--border)] px-4 py-3.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)] transition-colors"
          />
        </div>

        <div>
          <label className="text-[var(--text-muted)] text-[10px] mb-1 block">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-[var(--surface)] border border-[var(--border)] px-4 py-3.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)] transition-colors"
          />
        </div>

        {/* Save this server (URL + username only — never the password) */}
        <label className="flex items-center gap-2.5 py-1 cursor-pointer">
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
          <span className="text-[var(--text-muted)] text-[11px]">Save this server (not the password)</span>
        </label>

        {error && <p className="text-[var(--error)] text-[11px] text-center">{error}</p>}

        <button
          type="submit"
          disabled={!isValid || isLoading}
          className="w-full bg-white text-black font-semibold text-[13px] py-3.5 mt-4 disabled:opacity-40 hover:bg-gray-200 transition-colors"
        >
          {isLoading ? "Connecting..." : "Connect"}
        </button>
      </form>

      <p className="text-[var(--text-muted)] text-[10px] text-center mt-8 leading-4">
        Sign in with your K2 Connect account to reach your machine
      </p>
    </div>
  );
}
