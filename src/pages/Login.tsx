import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/auth";

export function Login() {
  const { login, isLoading, error, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) navigate("/workspaces", { replace: true });
  }, [isAuthenticated]);
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [debug, setDebug] = useState("");

  const isValid = serverUrl.length > 0 && username.length > 0 && password.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    setDebug("Calling login...");
    try {
      const result = await login(serverUrl, username, password);
      setDebug(`login returned: ${result}, isAuth: ${useAuthStore.getState().isAuthenticated}`);
    } catch (err) {
      setDebug(`login threw: ${err}`);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-extrabold tracking-[0.2em] text-[var(--text)]">
          K2SO
        </h1>
        <p className="text-[var(--text-muted)] text-[13px] mt-1">Companion</p>
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

        {error && <p className="text-[var(--error)] text-[11px] text-center">{error}</p>}
        {debug && <p className="text-[var(--accent)] text-[11px] text-center break-all">{debug}</p>}

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
