import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/auth";

const STORAGE_KEY = "k2so_remember";

function loadRemembered(): { serverUrl: string; username: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

function saveRemembered(serverUrl: string, username: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ serverUrl, username }));
}

function clearRemembered() {
  localStorage.removeItem(STORAGE_KEY);
}

export function Login() {
  const { login, isLoading, error, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const remembered = loadRemembered();
  const [serverUrl, setServerUrl] = useState(remembered?.serverUrl || "");
  const [username, setUsername] = useState(remembered?.username || "");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(!!remembered);

  useEffect(() => {
    if (isAuthenticated) navigate("/workspaces", { replace: true });
  }, [isAuthenticated, navigate]);

  const isValid = serverUrl.length > 0 && username.length > 0 && password.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    if (rememberMe) {
      saveRemembered(serverUrl, username);
    } else {
      clearRemembered();
    }

    await login(serverUrl, username, password);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 pb-safe">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-extrabold tracking-[0.2em] text-[var(--text)]">
          K2
        </h1>
        <p className="text-[var(--text-muted)] text-[13px] mt-1">by K2SO</p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3">
        <div>
          <label className="text-[var(--text-muted)] text-[10px] mb-1 block">Server URL</label>
          <input
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="your-tunnel.ngrok.io"
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
            onChange={(e) => setUsername(e.target.value)}
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

        {/* Remember Me */}
        <label className="flex items-center gap-2.5 py-1 cursor-pointer">
          <div
            onClick={() => setRememberMe(!rememberMe)}
            className={`w-5 h-5 border flex items-center justify-center shrink-0 transition-all duration-150 ${
              rememberMe
                ? "border-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)]"
            }`}
          >
            {rememberMe && (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 6l3 3 5-5" />
              </svg>
            )}
          </div>
          <span className="text-[var(--text-muted)] text-[11px]">Remember server and username</span>
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
        Enable Mobile Companion in K2SO settings to get your server URL
      </p>
    </div>
  );
}
