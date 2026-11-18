import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  DEFAULT_PASSWORD_POLICY,
  fetchPasswordPolicy,
  firstUnmetRule,
  lockedButtonText,
  lockedText,
  passwordRules,
  SET_PASSWORD_COPY as COPY,
  type PasswordPolicy,
} from "../api/changePassword";
import {
  passwordTicketContract,
  PendingSessions,
  setNewPassword,
  type SetPasswordTarget,
} from "./setPasswordFlow";
import { EyeIcon, EyeOffIcon } from "./PasswordEye";

/** "Set your new password" (K2 Cloud S1): a login with a temporary
 *  password chooses its own before the server lets it in. Shown inside
 *  OverlayAddServer (the sign-in sheet) and PairForm, in their style:
 *
 *  - right after a sign-in that answered `mustChangePassword` (the
 *    temporary password the person just typed is reused, in memory only);
 *  - from a "Change password on {server}" row or room (asks for the
 *    temporary password, since the phone never keeps one);
 *  - from a pairing code refused with `password_change_required` (asks for
 *    the temporary password, and the username when the code didn't say).
 *
 *  New password + confirm, a live checklist of the server's rules, one
 *  show/hide toggle for every field, the server's errors inline. On
 *  success the new session is saved like any sign-in and `onDone` runs.
 *
 *  K2 0.46.16 (`companion-password-ticket-v1`, read once on open): the
 *  checklist adds "Different from your temporary password", a locked login
 *  counts down on the button, and when pairing is how this phone signs in
 *  next (a web-off box, or the step came from a pairing code) `onPairNext`
 *  gets the notice. */
export function SetPasswordStep({
  target,
  serverLabel,
  mintedToken = null,
  heldToken = null,
  initialCurrentPassword = "",
  askCurrent,
  usernameEditable = false,
  ticketPath = null,
  then = "signin",
  onDone,
  onBack,
  onPairNext,
}: {
  target: SetPasswordTarget;
  /** The server as the copy names it ("home.k2.dev"). */
  serverLabel: string;
  /** The restricted session the sign-in just minted (not saved). */
  mintedToken?: string | null;
  /** A session the phone already holds for this login (may be dead). */
  heldToken?: string | null;
  /** What the person just typed to sign in. Memory only. */
  initialCurrentPassword?: string;
  /** Show the temporary-password field (the phone doesn't know it). */
  askCurrent: boolean;
  /** Ask for the username too (a pairing code that didn't name it). */
  usernameEditable?: boolean;
  /** Saved and signed in with the new password. */
  onDone: (id: string) => void | Promise<void>;
  /** Back to the form this came from. */
  onBack?: () => void;
  /** The ticket route a pairing 409 named (K2 0.46.16). */
  ticketPath?: string | null;
  /** What follows under K2 0.46.16: sign in (default), or pair (the step
   *  came from a pairing code). */
  then?: "signin" | "pair";
  /** K2 0.46.16: the password is set and pairing is next; `notice` says so.
   *  Without it the notice shows here as the error line. */
  onPairNext?: (notice: string) => void;
}) {
  const [username, setUsername] = useState(target.username);
  const [current, setCurrent] = useState(initialCurrentPassword);
  const [showCurrent, setShowCurrent] = useState(askCurrent || !initialCurrentPassword);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const currentRef = useRef<HTMLInputElement | null>(null);
  const nextRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLInputElement | null>(null);
  const sessions = useRef<PendingSessions | null>(null);
  if (!sessions.current) sessions.current = new PendingSessions(target.url, mintedToken, heldToken);
  const maybeChanged = useRef(false);
  const finished = useRef(false);
  const live = useRef(true);
  // K2 0.46.16's contract, asked once on open; the submit waits for it.
  const contract = useRef<Promise<boolean> | null>(null);
  const [ticketContract, setTicketContract] = useState(false);
  // A locked login (423): when it opens again, and a clock for the countdown.
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The server's rules (a restricted session may read them). Until then,
  // and when it can't be read, the daemon's default; it checks again.
  useEffect(() => {
    let cancelled = false;
    void fetchPasswordPolicy(target.url, mintedToken ?? heldToken).then((p) => {
      if (!cancelled && p) setPolicy(p);
    });
    return () => {
      cancelled = true;
    };
  }, [target.url, mintedToken, heldToken]);

  useEffect(() => {
    let cancelled = false;
    const p = passwordTicketContract(target, mintedToken ?? heldToken);
    contract.current = p;
    void p.then((v) => {
      if (!cancelled) setTicketContract(v);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.url, target.serverId, mintedToken, heldToken]);

  // The countdown: once a second until the lock is over.
  useEffect(() => {
    if (lockedUntil === null) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) setLockedUntil(null);
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);
  const lockLeft = lockedUntil !== null ? Math.max(0, (lockedUntil - now) / 1000) : 0;
  const locked = lockedUntil !== null && lockLeft > 0;

  // Leaving without finishing signs out the sessions this screen minted.
  // Deferred a tick so React's StrictMode remount doesn't count as leaving.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      setTimeout(() => {
        if (!live.current && !finished.current) sessions.current?.release();
      }, 0);
    };
  }, []);

  // 0.46.16 refuses a new password equal to the temporary one: say it live.
  const ruleOpts = ticketContract ? { differentFrom: current } : {};
  const rules = passwordRules(next, policy, ruleOpts);
  const matches = confirm.length > 0 && next === confirm;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || locked) return;
    const login = username.trim();
    if (usernameEditable && !login) {
      setError(COPY.missingUsername);
      usernameRef.current?.focus();
      return;
    }
    if (!current) {
      setShowCurrent(true);
      setError(COPY.missingCurrent);
      currentRef.current?.focus();
      return;
    }
    const weak = firstUnmetRule(next, policy, ruleOpts);
    if (weak) {
      setError(weak);
      nextRef.current?.focus();
      return;
    }
    if (next !== confirm) {
      setError(COPY.mismatch);
      confirmRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const withTicket = await (contract.current ?? Promise.resolve(false));
    const r = await setNewPassword({
      target: { ...target, username: login },
      sessions: sessions.current!,
      currentPassword: current,
      newPassword: next,
      policy,
      maybeChanged: maybeChanged.current,
      ticketContract: withTicket,
      ticketPath,
      then,
    });
    if (!r.ok && r.field === "pair") {
      // The password is set; this phone pairs next. Nothing to sign out.
      finished.current = true;
      setCurrent("");
      setNext("");
      setConfirm("");
      setBusy(false);
      if (onPairNext) onPairNext(r.error);
      else setError(r.error);
      return;
    }
    if (r.ok) {
      finished.current = true;
      // The passwords leave memory with this screen; drop them now too.
      setCurrent("");
      setNext("");
      setConfirm("");
      try {
        await onDone(r.id);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (r.sent) maybeChanged.current = true;
    if (r.policy) setPolicy(r.policy);
    setBusy(false);
    if (r.retryAfterSecs) {
      // The error line and the button count down from here.
      const t = Date.now();
      setNow(t);
      setLockedUntil(t + r.retryAfterSecs * 1000);
      setError(null);
      return;
    }
    setError(r.error);
    if (r.field === "current") {
      setShowCurrent(true);
      // Focus once the field is on screen.
      setTimeout(() => currentRef.current?.focus(), 0);
    } else if (r.field === "new") {
      nextRef.current?.focus();
    }
  };

  const field: CSSProperties = {
    width: "100%",
    minHeight: 40,
    padding: "0 14px",
    borderRadius: 10,
    color: "var(--color-text-primary)",
    fontSize: 16,
  };
  const label = (text: string) => (
    <span className="text-[11px] uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
      {text}
    </span>
  );
  const kind = show ? "text" : "password";
  const noAssist = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;
  const isValid = (!usernameEditable || username.trim().length > 0) && current.length > 0 && next.length > 0 && confirm.length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => void onSubmit(e)}
      data-testid="set-password"
      aria-labelledby="set-password-title"
      noValidate
    >
      <div className="flex flex-col gap-1.5" style={{ marginTop: 8 }}>
        <h2 id="set-password-title" className="text-[20px] font-semibold text-center">
          {COPY.title}
        </h2>
        <p className="text-[13px] text-center" style={{ color: "var(--color-text-muted)", lineHeight: 1.4 }}>
          {showCurrent && askCurrent ? COPY.leadAskCurrent(serverLabel) : COPY.lead}
        </p>
      </div>

      {usernameEditable ? (
        <label className="flex flex-col gap-1.5">
          {label(COPY.usernameLabel)}
          <input
            ref={usernameRef}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            disabled={busy}
            className="k2-tile"
            style={field}
            data-testid="set-password-username"
            {...noAssist}
          />
        </label>
      ) : (
        <div className="k2-tile flex flex-col" style={{ borderRadius: 12, padding: "4px 14px" }}>
          <div className="flex items-center justify-between" style={{ minHeight: 44, gap: 12 }}>
            <span style={{ color: "var(--color-text-muted)" }}>Server</span>
            <span className="font-semibold truncate">{serverLabel}</span>
          </div>
          <div style={{ height: 0.5, background: "var(--color-wash-2)" }} />
          <div className="flex items-center justify-between" style={{ minHeight: 44, gap: 12 }}>
            <span style={{ color: "var(--color-text-muted)" }}>Login</span>
            <span className="font-semibold truncate" data-testid="set-password-login">
              {username}
            </span>
          </div>
          {/* So the iOS password manager files the new password under this
              login. Not focusable, not read out (the row above says it). */}
          <input
            type="text"
            value={username}
            readOnly
            autoComplete="username"
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
          />
        </div>
      )}

      {showCurrent ? (
        <label className="flex flex-col gap-1.5">
          {label(COPY.currentLabel)}
          <input
            ref={currentRef}
            type={kind}
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              setError(null);
            }}
            placeholder={COPY.currentLabel}
            autoComplete="current-password"
            disabled={busy}
            className="k2-tile"
            style={field}
            data-testid="set-password-current"
            {...noAssist}
          />
        </label>
      ) : null}

      <label className="flex flex-col gap-1.5">
        {label(COPY.newLabel)}
        <span className="relative block">
          <input
            ref={nextRef}
            type={kind}
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setError(null);
            }}
            placeholder={COPY.newLabel}
            autoComplete="new-password"
            aria-describedby="set-password-rules"
            disabled={busy}
            className="k2-tile"
            style={{ ...field, paddingRight: 44 }}
            data-testid="set-password-new"
            {...noAssist}
          />
          <button
            type="button"
            className="absolute right-0 top-0 flex h-full w-11 items-center justify-center"
            style={{ color: "var(--color-text-muted)" }}
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Hide passwords" : "Show passwords"}
            aria-pressed={show}
            data-testid="set-password-show"
          >
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        {label(COPY.confirmLabel)}
        <input
          ref={confirmRef}
          type={kind}
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError(null);
          }}
          placeholder={COPY.confirmLabel}
          autoComplete="new-password"
          enterKeyHint="go"
          disabled={busy}
          className="k2-tile"
          style={field}
          data-testid="set-password-confirm"
          {...noAssist}
        />
      </label>

      <ul
        id="set-password-rules"
        className="flex flex-col"
        style={{ gap: 6 }}
        aria-label="Password requirements"
        data-testid="set-password-rules"
      >
        {rules.map((r) => (
          <RuleLine key={r.id} id={r.id} met={r.met} text={r.label} />
        ))}
        {confirm.length > 0 ? <RuleLine id="match" met={matches} text={COPY.matchRule} /> : null}
      </ul>

      {locked || error ? (
        <p
          className="text-[13px] text-center"
          style={{ color: "var(--color-status-error-text)" }}
          role="alert"
          data-testid="set-password-error"
        >
          {locked ? lockedText(lockLeft) : error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!isValid || busy || locked}
        className="w-full font-semibold"
        style={{
          minHeight: 44,
          borderRadius: 12,
          background: "var(--color-accent-fill)",
          color: "var(--color-on-accent)",
          opacity: !isValid || busy || locked ? 0.4 : 1,
        }}
        data-testid="set-password-submit"
      >
        {busy ? COPY.busy : locked ? lockedButtonText(lockLeft) : COPY.submit}
      </button>
      {onBack ? (
        <button
          type="button"
          className="w-full text-[17px]"
          style={{ minHeight: 44, color: "var(--color-text-muted)" }}
          disabled={busy}
          onClick={onBack}
          data-testid="set-password-back"
        >
          {COPY.back}
        </button>
      ) : null}
    </form>
  );
}

function RuleLine({ id, met, text }: { id: string; met: boolean; text: string }) {
  return (
    <li
      className="flex items-center text-[13px]"
      style={{ gap: 8, color: met ? "var(--color-text-primary)" : "var(--color-text-muted)" }}
      data-rule={id}
      data-met={met ? "true" : "false"}
    >
      {met ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-status-ok)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <span style={{ width: 12, height: 12, margin: 2, flexShrink: 0, borderRadius: 6, border: "1.5px solid var(--color-border)" }} aria-hidden />
      )}
      <span>
        {text}
        <span className="sr-only">{met ? " (done)" : " (not yet)"}</span>
      </span>
    </li>
  );
}
