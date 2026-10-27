import { useEffect, useRef, useState, type CSSProperties } from "react";
import { checkPairCode, isK2DevServer, normalizePairCode, parsePairText, phoneName } from "../api/pairing";
import { qrScannerAvailable, scanQr } from "../lib/pairLinks";
import { duplicateServer, hostLabel, normalizeServerUrl, useServersStore } from "../stores/servers";
import { tryHostKey } from "../lib/hostKey";
import { pairServer, type PairStep } from "./pairFlow";

/** "Pair with a code" (K2 0.46.4 `companion-pairing-v1`), inside
 *  OverlayAddServer. Two steps: the code (typed, pasted, scanned, or from a
 *  link) and the server; then a confirm that names the server and the
 *  login before anything is paired (K2's security review: a link can come
 *  from anyone). A server already saved at that address is replaced only
 *  after the confirm says so. Once Pair is tapped nothing is tappable: a
 *  step list shows where the pairing is, then a "Paired" screen with Done. */
export function PairForm({
  editingId,
  initialServerUrl,
  initialCode,
  activate,
  onPaired,
  onDone,
  onPhase,
}: {
  /** The saved server this pairs again (or switches): its entry is reused. */
  editingId?: string | null;
  initialServerUrl?: string | null;
  initialCode?: string | null;
  activate: boolean;
  /** Awaited as the last step (the agents reload) before "Paired". */
  onPaired: (id: string) => void | Promise<void>;
  /** Done on the "Paired" screen. */
  onDone: () => void;
  /** The overlay locks its Cancel and tabs while busy, hides them when done. */
  onPhase?: (phase: "idle" | "busy" | "done") => void;
}) {
  const servers = useServersStore((s) => s.servers);
  const tokens = useServersStore((s) => s.tokens);
  const editing = editingId ? servers.find((s) => s.id === editingId) : undefined;
  const [serverUrl, setServerUrl] = useState(
    initialServerUrl ? hostLabel(initialServerUrl) : editing ? hostLabel(editing.url) : ""
  );
  const [code, setCode] = useState(initialCode ?? "");
  const [step, setStep] = useState<"enter" | "confirm" | "done">("enter");
  const [progress, setProgress] = useState<ProgressStep | null>(null);
  const [pairedAs, setPairedAs] = useState("");
  const [pairedTo, setPairedTo] = useState<string | null>(null);
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
  // Pairing over a signed-in server signs that session out first.
  const signsOut = !!replacing && !!tokens[replacing.id];

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
    setProgress("pair");
    onPhase?.("busy");
    const r = await pairServer({
      serverUrl: url,
      code: normalized,
      replaceId: replacing?.id ?? null,
      activate,
      onStep: setProgress,
    });
    if (!r.ok) {
      setBusy(false);
      setProgress(null);
      setError(r.error);
      onPhase?.("idle");
      return;
    }
    setProgress("agents");
    try {
      await onPaired(r.id);
    } finally {
      setBusy(false);
      setProgress(null);
    }
    setPairedAs(r.username);
    setPairedTo(r.serverName ?? null);
    setStep("done");
    onPhase?.("done");
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

  if (step === "done") {
    const host = url ? hostLabel(url) : "the server";
    // 0.46.6 names the computer; the address stays beside it.
    const to = pairedTo && pairedTo !== host ? `${pairedTo} (${host})` : host;
    return (
      <div className="flex flex-col items-center gap-4 text-center" style={{ paddingTop: 32 }} data-testid="pair-success">
        <div
          className="flex items-center justify-center"
          style={{ width: 72, height: 72, borderRadius: 36, background: "rgba(48,209,88,0.16)" }}
          aria-hidden
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </div>
        <h2 className="text-[22px] font-semibold">Paired</h2>
        <p className="text-[15px]" style={{ color: "#c7c7cc", lineHeight: 1.4 }} data-testid="pair-success-text">
          This {phoneName()} is signed in to {to}
          {pairedAs ? ` as ${pairedAs}` : ""}. It stays signed in without a password.
        </p>
        <button type="button" className="w-full font-semibold" style={{ ...primary, marginTop: 8 }} onClick={onDone} data-testid="pair-done">
          Done
        </button>
      </div>
    );
  }

  if (step === "confirm") {
    const host = url ? hostLabel(url) : "";
    if (progress) {
      const steps: { key: ProgressStep; label: string }[] = [
        { key: "pair", label: `Pairing with ${host}` },
        ...(signsOut ? [{ key: "leave" as const, label: "Signing out the old sign-in" }] : []),
        { key: "save", label: "Saving this phone" },
        { key: "agents", label: activate ? "Loading your agents" : "Finishing up" },
      ];
      const at = steps.findIndex((s) => s.key === progress);
      return (
        <div className="flex flex-col gap-4" data-testid="pair-progress" aria-live="polite">
          <h2 className="text-[20px] font-semibold text-center" style={{ marginTop: 8 }}>
            Pairing this {phoneName()}…
          </h2>
          <div className="k2-tile flex flex-col" style={{ borderRadius: 12, padding: "4px 14px" }}>
            {steps.map((s, i) => {
              const state = i < at ? "done" : i === at ? "now" : "next";
              return (
                <div
                  key={s.key}
                  className="flex items-center"
                  style={{ minHeight: 44, gap: 12, color: state === "next" ? "#636366" : "#fff" }}
                  data-testid={`pair-step-${s.key}`}
                  data-state={state}
                >
                  <StepMark state={state} />
                  <span className={state === "now" ? "font-semibold" : undefined}>{s.label}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[13px] text-center" style={{ color: "#8e8e93" }}>
            This can take a few seconds. Keep K2 open.
          </p>
        </div>
      );
    }
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

type ProgressStep = PairStep | "agents";

function StepMark({ state }: { state: "done" | "now" | "next" }) {
  if (state === "done") {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    );
  }
  if (state === "now") {
    return (
      <span
        className="animate-spin"
        style={{ width: 18, height: 18, margin: 1, flexShrink: 0, borderRadius: 9, border: "2px solid rgba(255,255,255,0.25)", borderTopColor: "#fff" }}
        aria-hidden
      />
    );
  }
  return <span style={{ width: 18, height: 18, margin: 1, flexShrink: 0, borderRadius: 9, border: "2px solid #3a3a3c" }} aria-hidden />;
}
