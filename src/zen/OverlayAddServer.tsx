import { useState, type CSSProperties, type FormEvent } from "react";
import { loginAndSaveServer } from "../stores/servers";
import { useZenStore } from "./zenStore";

/** Overlay Add server. Donor is `Login.tsx` / `loginAndSaveServer`.
 *  This is the zero-stored-server overlay destination — not `/login`. */
export function OverlayAddServer() {
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isValid = serverUrl.length > 0 && username.length > 0 && password.length > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValid || busy) return;
    setBusy(true);
    setError(null);
    const result = await loginAndSaveServer({
      nickname,
      url: serverUrl,
      username,
      password,
      rememberPassword: false,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await useZenStore.getState().hydrateAgents();
  };

  const field: CSSProperties = {
    width: "100%",
    minHeight: 40,
    padding: "0 14px",
    borderRadius: 10,
    background: "#1c1c1e",
    color: "#fff",
    border: "1px solid #3a3a3c",
    fontSize: 16,
  };

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ background: "#000", color: "#fff" }}
      data-testid="overlay-add-server"
    >
      <header
        className="shrink-0"
        style={{
          minHeight: 44,
          padding: "max(12px, env(safe-area-inset-top)) 16px 8px",
        }}
      >
        <h1 className="text-center text-[17px] font-semibold">Add server</h1>
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
              style={{ ...field, paddingRight: 44 }}
            />
            <button
              type="button"
              className="absolute right-0 top-0 h-full w-11"
              style={{ color: "#8e8e93" }}
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
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
        <p className="text-[11px] text-center" style={{ color: "#8e8e93" }}>
          Sign in with your K2 Connect account to reach your machine
        </p>
      </form>
    </div>
  );
}
