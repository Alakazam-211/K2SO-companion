import { useState, useEffect, useRef } from "react";
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
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isAuthenticated) navigate("/sessions", { replace: true });
  }, [isAuthenticated, navigate]);

  // Close the saved-servers dropdown on outside tap.
  useEffect(() => {
    if (!dropOpen) return;
    const onDown = (e: Event) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [dropOpen]);

  const isValid = serverUrl.length > 0 && username.length > 0 && password.length > 0;
  const selectedConn = connections.find((c) => c.id === selectedId);

  const selectConn = (c: Conn) => {
    setSelectedId(c.id);
    setNickname(c.nickname);
    setServerUrl(c.serverUrl);
    setUsername(c.username);
    setPassword(""); // never stored — always re-enter
    setDropOpen(false);
  };

  const deleteConn = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const next = connections.filter((c) => c.id !== id);
    setConnections(next);
    persist(next);
    if (selectedId === id) setSelectedId(null);
    if (next.length === 0) setDropOpen(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    if (save) {
      const nick = nickname.trim() || serverUrl;
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
    "w-full min-h-[40px] bg-[var(--surface)] border border-[var(--border-hover)] px-4 text-[var(--text)] text-[14px] focus:outline-none focus:border-[var(--accent)] transition-colors";
  const labelClass =
    "text-[var(--text-muted)] text-[10px] uppercase tracking-wide block";

  return (
    <div className="flex flex-col items-center min-h-full px-6 pt-20 pb-12 overflow-y-auto">
      <div className="w-full max-w-sm flex flex-col items-stretch">
        {/* Logo */}
        <img src={loginLogo} alt="K2 by Alakazam Labs" className="w-44 mx-auto mb-10 mt-2" />

        {/* Saved servers — custom dropdown (matches the desktop K2 picker) */}
        {connections.length > 0 && (
          <div className="mb-7">
            <label className={`${labelClass} mb-2`}>Saved servers</label>
            <div className="relative" ref={dropRef}>
              <button
                type="button"
                onClick={() => setDropOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={dropOpen}
                className={`${inputClass} flex items-center justify-between gap-2 text-left ${selectedConn ? "" : "text-[var(--text-muted)]"}`}
              >
                <span className="truncate">{selectedConn ? selectedConn.nickname : "Select a saved server…"}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-[var(--text-muted)] transition-transform ${dropOpen ? "rotate-180" : ""}`}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {dropOpen && (
                <div
                  role="listbox"
                  className="absolute left-0 right-0 top-full mt-1.5 z-20 max-h-[45vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border-hover)] shadow-2xl py-1"
                >
                  {connections.map((c) => {
                    const isSel = c.id === selectedId;
                    return (
                      <div
                        key={c.id}
                        role="option"
                        aria-selected={isSel}
                        onClick={() => selectConn(c)}
                        className={`flex items-center gap-2 px-3.5 py-3 cursor-pointer transition-colors ${
                          isSel ? "bg-[var(--accent)]/10" : "hover:bg-[var(--background)]"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[var(--text)] text-[13px] font-medium truncate">{c.nickname}</div>
                          <div className="text-[var(--text-muted)] text-[10px] truncate mt-0.5">{c.username} @ {c.serverUrl}</div>
                        </div>
                        {isSel && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--accent)]">
                            <path d="M5 12l5 5 9-11" />
                          </svg>
                        )}
                        <button
                          type="button"
                          onClick={(e) => deleteConn(c.id, e)}
                          aria-label="Remove saved server"
                          className="w-8 h-8 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] shrink-0 transition-colors"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" />
                            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Divider between saved + a new sign-in */}
        {connections.length > 0 && (
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-[var(--border-hover)]" />
            <span className="text-[var(--text-muted)] text-[10px] uppercase tracking-wide">or sign in</span>
            <div className="flex-1 h-px bg-[var(--border-hover)]" />
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
                  save ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border-hover)]"
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
            className="w-full min-h-[40px] bg-white text-black font-semibold text-[14px] mt-1 disabled:opacity-40 hover:bg-gray-200 transition-colors"
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
