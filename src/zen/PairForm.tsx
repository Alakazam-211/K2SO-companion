import { useEffect, useRef, useState, type CSSProperties } from "react";
import { checkPairCode, isK2DevServer, normalizePairCode, parsePairText, phoneName } from "../api/pairing";
import { qrScannerAvailable, scanQr } from "../lib/pairLinks";
import { duplicateServer, hostLabel, normalizeServerUrl, useServersStore } from "../stores/servers";
import { tryHostKey } from "../lib/hostKey";
import { pairServer } from "./pairFlow";

/** "Pair with a code" (K2 0.46.4 `companion-pairing-v1`), inside
 *  OverlayAddServer. Two steps: the code (typed, pasted, scanned, or from a
 *  link) and the server; then a confirm that names the server and the
 *  login before anything is paired (K2's security review: a link can come
 *  from anyone). A server already saved at that address is replaced only
 *  after the confirm says so. */
export function PairForm({
  editingId,
  initialServerUrl,
  initialCode,
  activate,
  onPaired,
}: {
  /** The saved server this pairs again (or switches): its entry is reused. */
  editingId?: string | null;
  initialServerUrl?: string | null;
  initialCode?: string | null;
  activate: boolean;
  onPaired: (id: string) => void;
}) {
  const servers = useServersStore((s) => s.servers);
  const editing = editingId ? servers.find((s) => s.id === editingId) : undefined;
  const [serverUrl, setServerUrl] = useState(
    initialServerUrl ? hostLabel(initialServerUrl) : editing ? hostLabel(editing.url) : ""
  );
  const [code, setCode] = useState(initialCode ?? "");
  const [step, setStep] = useState<"enter" | "confirm">("enter");
  const [login, setLogin] = useState<string | null>(null);
  const [codeHost, setCodeHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoChecked = useRef(false);

  const url = serverUrl.trim() ? normalizeServerUrl(serverUrl) : "";
  const normalized = normalizePairCode(code);
  const isValid = !!url && !!tryHostKey(url) && !!normalized;
  // The saved server this would take over: the one being edited, else
  // another saved at the same address (named in the confirm).
  const other = url ? duplicateServer(servers, url, editing?.id ?? null) : null;
  const replacing = editing ?? other ?? null;

  const onCodeChange = (text: string) => {
    const parsed = parsePairText(text);
    if (parsed?.serverUrl) {
      setServerUrl(hostLabel(parsed.serverUrl));
      setCode(parsed.code);
    } else {
      setCode(text);
    }
    setError(null);
  };

  const check = async (forUrl: string, forCode: string) => {
    setBusy(true);
    setError(null);
    const r = await checkPairCode(forUrl, forCode);
    setBusy(false);
    if (!r.ok && r.kind !== "unchecked") {
      setError(r.error);
      return;
    }
    setLogin(r.ok ? r.user : null);
    setCodeHost(r.ok ? r.host : null);
    setStep("confirm");
  };

  // A link fills both: go straight to the confirm (never to pairing).
  useEffect(() => {
    if (autoChecked.current || !initialServerUrl || !initialCode) return;
    const c = normalizePairCode(initialCode);
    if (!c) return;
    autoChecked.current = true;
    void check(normalizeServerUrl(initialServerUrl), c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onContinue = () => {
    if (!isValid || busy || !normalized) return;
    if (editing && other) {
      // Editing one saved server onto another's address.
      setError(`Already saved as ${other.nickname || hostLabel(other.url)}.`);
      return;
    }
    void check(url, normalized);
  };

  const onScan = async () => {
    setError(null);
    const r = await scanQr();
    if (r.kind === "denied") {
      setError("The camera is off for K2. Turn it on in Settings → K2, or type the code.");
      return;
    }
    if (r.kind === "failed") {
      setError("The camera couldn't open. Type the code instead.");
      return;
    }
    if (r.kind !== "text") return;
    const parsed = parsePairText(r.text);
    if (!parsed) {
      setError("That QR code isn't a K2 pairing code.");
      return;
    }
    const nextUrl = parsed.serverUrl ?? url;
    if (parsed.serverUrl) setServerUrl(hostLabel(parsed.serverUrl));
    setCode(parsed.code);
    if (nextUrl && tryHostKey(nextUrl)) void check(nextUrl, parsed.code);
  };

  const onPair = async () => {
    if (!normalized || busy) return;
    setBusy(true);
    setError(null);
    const r = await pairServer({ serverUrl: url, code: normalized, replaceId: replacing?.id ?? null, activate });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onPaired(r.id);
  };

  const field: CSSProperties = {
    width: "100%",
    minHeight: 40,
    padding: "0 14px",
    borderRadius: 10,
    color: "#fff",
    fontSize: 16,
  };
  const primary: CSSProperties = {
    minHeight: 44,
    borderRadius: 12,
    background: "#0a84ff",
    color: "#fff",
  };
  const label = (text: string) => (
    <span className="text-[11px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>
      {text}
    </span>
  );

  if (step === "confirm") {
    const host = url ? hostLabel(url) : "";
    const codeElsewhere =
      codeHost && tryHostKey(`https://${codeHost}`) !== tryHostKey(url) ? codeHost : null;
    return (
      <div className="flex flex-col gap-4" data-testid="pair-confirm">
        <h2 className="text-[20px] font-semibold text-center" style={{ marginTop: 8 }}>
          Pair this {phoneName()}?
        </h2>
        <div className="k2-tile flex flex-col" style={{ borderRadius: 12, padding: "4px 14px" }}>
          <div className="flex items-center justify-between" style={{ minHeight: 44, gap: 12 }}>
            <span style={{ color: "#8e8e93" }}>Server</span>
            <span className="font-semibold truncate" data-testid="pair-confirm-host">
              {host}
            </span>
          </div>
          <div style={{ height: 0.5, background: "rgba(255,255,255,0.12)" }} />
          <div className="flex items-center justify-between" style={{ minHeight: 44, gap: 12 }}>
            <span style={{ color: "#8e8e93" }}>Login</span>
            <span className="font-semibold truncate" data-testid="pair-confirm-login">
              {login ?? "Shown after pairing"}
            </span>
          </div>
        </div>
        {!isK2DevServer(url) ? (
          <p className="text-[13px]" style={{ color: "#ffd60a" }} data-testid="pair-warn-host">
            This isn't a k2.dev address. Only pair with a computer you own or trust.
          </p>
        ) : null}
        {codeElsewhere ? (
          <p className="text-[13px]" style={{ color: "#ffd60a" }} data-testid="pair-warn-code-host">
            This code was made on {codeElsewhere}, not {host}.
          </p>
        ) : null}
        {replacing && login && replacing.username && login !== replacing.username ? (
          <p className="text-[13px]" style={{ color: "#ffd60a" }} data-testid="pair-warn-replace">
            This phone uses {replacing.username} on {replacing.nickname || hostLabel(replacing.url)} now. Pairing
            switches it to {login}.
          </p>
        ) : other ? (
          <p className="text-[13px]" style={{ color: "#ffd60a" }} data-testid="pair-warn-replace">
            {other.nickname || hostLabel(other.url)} is already on this phone. Pairing replaces how it signs in.
          </p>
        ) : null}
        <p className="text-[13px]" style={{ color: "#8e8e93" }}>
          Only pair with a code you made yourself or got from someone you trust. This phone then stays signed in
          without a password until you sign out or the pairing is removed.
        </p>
        {error ? (
          <p className="text-[13px] text-center" style={{ color: "#ef4444" }}>
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="w-full font-semibold"
          style={{ ...primary, opacity: busy ? 0.4 : 1 }}
          disabled={busy}
          onClick={() => void onPair()}
          data-testid="pair-confirm-button"
        >
          {busy ? "Pairing…" : "Pair"}
        </button>
        <button
          type="button"
          className="w-full text-[17px]"
          style={{ minHeight: 44, color: "#8e8e93" }}
          disabled={busy}
          onClick={() => {
            setStep("enter");
            setError(null);
          }}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onContinue();
      }}
      data-testid="pair-form"
    >
      <p className="text-[13px]" style={{ color: "#8e8e93" }}>
        On your computer, open K2 Settings → K2 Companion and choose Pair a phone (or your profile → Your phones). Then scan its QR code or type the code.
      </p>
      {qrScannerAvailable() ? (
        <button
          type="button"
          className="w-full font-semibold k2-tile"
          style={{ minHeight: 44, borderRadius: 12, color: "#fff" }}
          disabled={busy}
          onClick={() => void onScan()}
          data-testid="pair-scan"
        >
          Scan QR code
        </button>
      ) : null}
      <label className="flex flex-col gap-1.5">
        {label("Pairing code")}
        <input
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          placeholder="K2P-XXXXX-XXXXX-XXXXX-XXXXX"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="one-time-code"
          spellCheck={false}
          className="k2-tile"
          style={{ ...field, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 15 }}
          data-testid="pair-code"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        {label("K2 Connect address")}
        <input
          value={serverUrl}
          onChange={(e) => {
            setServerUrl(e.target.value);
            setError(null);
          }}
          placeholder="your-name.k2.dev"
          autoCapitalize="off"
          autoCorrect="off"
          className="k2-tile"
          style={field}
          data-testid="pair-server"
        />
      </label>
      {error ? (
        <p className="text-[13px] text-center" style={{ color: "#ef4444" }} data-testid="pair-error">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!isValid || busy}
        className="w-full font-semibold"
        style={{ ...primary, opacity: !isValid || busy ? 0.4 : 1 }}
        data-testid="pair-continue"
      >
        {busy ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
