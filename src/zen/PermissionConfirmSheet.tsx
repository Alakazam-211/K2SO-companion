// The fresh confirm a few permission cards need (K2 0.46.3, contract DRAFT
// §Q1): the same proof Settings asks for, as a one-use token. The sheet
// asks for this login's password (or the vault password when that is the
// only method), turns it into a token (`api/permissionConfirm`) and hands
// the token to `onConfirmed`, which answers the card with it. The password
// never leaves this sheet except to `/cli/vault/confirm/finish`, and is
// dropped on close. Face ID is not a method K2 accepts.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ServerScope } from "../api/scope";
import {
  CONFIRM_METHOD_LOGIN,
  confirmErrorText,
  confirmFinish,
  confirmStart,
  pickConfirmMethod,
} from "../api/permissionConfirm";
import { useBackHandler } from "../lib/androidBack";

const MUTED = "#8e8e93";

export type PermissionConfirmProps = {
  scope: ServerScope;
  /** The catalog action (e.g. `app-approve`) and the request id (`pr_…`). */
  action: string;
  requestId: string;
  /** What is being allowed, in K2's words (the card's headline). */
  headline: string;
  /** Answer the card with the token. Resolves to an error text, or null. */
  onConfirmed: (token: string) => Promise<string | null>;
  onCancel: () => void;
};

type Phase =
  | { kind: "starting" }
  | { kind: "ready"; method: string }
  | { kind: "busy"; method: string }
  | { kind: "unavailable"; text: string };

export function PermissionConfirmSheet({ scope, action, requestId, headline, onConfirmed, onCancel }: PermissionConfirmProps) {
  useBackHandler(true, onCancel);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void confirmStart(scope, action, requestId).then((r) => {
      if (!live) return;
      if (!r.ok) {
        setPhase({ kind: "unavailable", text: r.text });
        return;
      }
      const method = pickConfirmMethod(r.data.methods);
      setPhase(method ? { kind: "ready", method } : { kind: "unavailable", text: confirmErrorText("unavailable") });
    });
    return () => {
      live = false;
    };
  }, [scope, action, requestId]);

  useEffect(() => {
    if (phase.kind === "ready") input.current?.focus({ preventScroll: true });
  }, [phase.kind]);

  async function submit() {
    if (phase.kind !== "ready" || !password) return;
    const method = phase.method;
    setPhase({ kind: "busy", method });
    setError(null);
    const r = await confirmFinish(scope, action, requestId, password, method);
    if (!r.ok) {
      setPassword("");
      setError(r.text);
      setPhase({ kind: "ready", method });
      return;
    }
    const failed = await onConfirmed(r.data.token);
    setPassword("");
    if (failed) {
      setError(failed);
      setPhase({ kind: "ready", method });
    }
  }

  const field: CSSProperties = { width: "100%", minHeight: 44, padding: "0 14px", borderRadius: 10, color: "#fff", fontSize: 16 };
  const busy = phase.kind === "busy";
  const label =
    phase.kind === "ready" || phase.kind === "busy"
      ? phase.method === CONFIRM_METHOD_LOGIN
        ? "Your login password"
        : "Vault password"
      : "";

  return createPortal(
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 60, fontFamily: "var(--zen-font)" }}
      data-testid="permission-confirm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Confirm to allow"
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 16px max(12px, var(--safe-bottom))",
          gap: 12,
          color: "#fff",
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[17px] font-semibold text-center">Confirm to allow</h2>
        <p className="text-[14px] text-center" style={{ color: MUTED, lineHeight: 1.4 }} data-testid="permission-confirm-headline">
          {headline}
        </p>
        {phase.kind === "starting" ? (
          <p className="text-[14px] text-center" style={{ color: MUTED }}>
            Checking…
          </p>
        ) : phase.kind === "unavailable" ? (
          <p className="text-[14px] text-center" role="alert" data-testid="permission-confirm-unavailable">
            {phase.text}
          </p>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: MUTED }}>
              {label}
            </span>
            <input
              ref={input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="current-password"
              spellCheck={false}
              disabled={busy}
              className="k2-tile"
              style={field}
              data-testid="permission-confirm-password"
            />
          </label>
        )}
        {error ? (
          <p className="text-[13px] text-center" role="alert" style={{ color: "#ff6961" }} data-testid="permission-confirm-error">
            {error}
          </p>
        ) : null}
        <div className="flex" style={{ gap: 10 }}>
          <button
            type="button"
            className="flex-1 text-[17px] k2-tile"
            style={{ minHeight: 44, borderRadius: 12, color: "#fff" }}
            disabled={busy}
            onClick={onCancel}
            data-testid="permission-confirm-cancel"
          >
            Cancel
          </button>
          {phase.kind === "ready" || phase.kind === "busy" ? (
            <button
              type="submit"
              className="flex-1 text-[17px] font-semibold"
              style={{ minHeight: 44, borderRadius: 12, color: "#fff", background: "#0a84ff", opacity: password && !busy ? 1 : 0.5 }}
              disabled={!password || busy}
              data-testid="permission-confirm-allow"
            >
              {busy ? "Allowing…" : "Allow"}
            </button>
          ) : null}
        </div>
      </form>
    </div>,
    document.body
  );
}
