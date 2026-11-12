import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyPlainText } from "../lib/clipboard";

// SPIKE (signed approvals S0, K2 PRD prd-signed-approvals-v1 §9). A
// TestFlight-only test row: never merge. The native side
// (K2ApprovalSpike.swift) shows its own sheet, runs Face ID or the
// passcode, and signs; this row only starts it and copies the result so
// Rosson can paste it into the Thread for the Mac's openssl check.

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";

type Result = Record<string, unknown>;

export function ApprovalSpikeGroup() {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (name: string, args: Record<string, unknown>) => {
    setBusy(name);
    setCopied(false);
    try {
      const r = await invoke<Result>("plugin:k2-push|approval_spike", args);
      setResults((all) => ({ ...all, [name]: r }));
    } catch (e) {
      setResults((all) => ({ ...all, [name]: { error: String(e) } }));
    } finally {
      setBusy(null);
    }
  };

  const text = JSON.stringify({ spike: "signed-approvals-S0", ...results }, null, 1);
  const rows: [string, string, Record<string, unknown>][] = [
    ["sign_biometric", "Sign with Face ID", { op: "sign", which: "biometric" }],
    ["sign_passcode", "Sign with passcode", { op: "sign", which: "passcode" }],
    ["attest", "App Attest", { op: "attest" }],
  ];

  return (
    <section style={{ marginTop: 20 }} data-testid="settings-approval-spike">
      <h2 className="text-[12px] uppercase tracking-wide font-normal" style={{ color: MUTED, padding: "0 16px 6px" }}>
        Signed approvals test
      </h2>
      <div className="k2-tile overflow-hidden" style={{ borderRadius: 14 }}>
        {rows.map(([name, label, args], i) => (
          <button
            key={name}
            type="button"
            disabled={busy !== null}
            className="w-full flex items-center justify-between text-[17px] text-left"
            style={{ minHeight: 44, padding: "11px 16px", borderTop: i ? HAIRLINE : undefined, color: "#0a84ff" }}
            onClick={() => void run(name, args)}
          >
            <span>{label}</span>
            <span style={{ color: MUTED, fontSize: 15 }}>
              {busy === name ? "…" : results[name] ? (results[name].error ? "error" : "done") : ""}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="w-full text-[17px] text-left"
          style={{ minHeight: 44, padding: "11px 16px", borderTop: HAIRLINE, color: "#0a84ff" }}
          onClick={() => void copyPlainText(text).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy results"}
        </button>
        <pre
          className="text-[11px]"
          style={{
            margin: 0,
            padding: "8px 16px 12px",
            borderTop: HAIRLINE,
            color: MUTED,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {text}
        </pre>
      </div>
      <p className="text-[13px]" style={{ color: MUTED, padding: "6px 16px 0", lineHeight: 1.35 }}>
        Test build only. Signs a sample release description; nothing is released. Run all three, then Copy results
        and paste them in the K2 Companion thread.
      </p>
    </section>
  );
}
