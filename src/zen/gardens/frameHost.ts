import table from "./phoneVerbs.json";

// One widget frame's protocol (§4.4, §4.5), without the DOM: the checks in
// the contract's order, the heartbeat and the stop rules. One host per
// placement; a message's sender is the port it came in on.
//
// `phoneVerbs.json` is K2's `sdk/generated/phone-verbs.json`. Only `host` and
// `never` are decided here. `later` and unknown verbs go through the door,
// where the daemon answers `verb_unavailable` / `unknown_verb`, so a row K2
// moves to `door` works without a phone release.

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const CALLS_PER_SECOND = 60;
export const CALL_BURST = 120;
export const MAX_SUBSCRIPTIONS = 16;
export const READY_TIMEOUT_MS = 10_000;
export const PING_MS = 5_000;
export const MISSED_PONGS = 3;
export const ERRORS_PER_MINUTE = 20;
export const RATE_LIMITED_PER_MINUTE = 10;
export const PRESS_WINDOW_MS = 5_000;

export type VerbError = { code: string; message?: string; cap?: string; room?: string; feature?: string };
export type VerbAnswer = { ok: true; value: unknown } | { ok: false; error: VerbError };
export type StopReason = "no-ready" | "not-responding" | "keeps-failing" | "rate-limited";

const phoneOf = new Map<string, string>(
  (table as { verbs: { verb: string; phone: string }[] }).verbs.map((row) => [row.verb, row.phone])
);

export function phoneRow(verb: string): string | undefined {
  return phoneOf.get(verb);
}

export interface FrameHostOptions {
  post(message: unknown, transfer?: Transferable[]): void;
  /** A `door` verb (also `later` and unknown ones: the daemon answers). */
  forward(verb: string, args: unknown[]): Promise<VerbAnswer>;
  /** A `host` verb. `pressed`: inside the frame's 5 s press window. */
  hostVerb(verb: string, args: unknown[], pressed: boolean): Promise<VerbAnswer> | VerbAnswer;
  /** A subscription: `push` per update; returns how to end it, or an error
   *  when this verb can't be subscribed to. */
  subscribe?(verb: string, args: unknown[], push: (value: unknown) => void): (() => void) | VerbError;
  onReady?(): void;
  onError?(error: { message: string; stack?: string }): void;
  onRefusal?(verb: string, code: string): void;
  onStop(reason: StopReason): void;
  /** Frame → phone `{size:{height}}` (contract rev 2). */
  onSize?(height: number): void;
}

export interface FrameHost {
  onMessage(data: unknown, transfer?: readonly unknown[]): void;
  setVisible(visible: boolean): void;
  /** The visible area changed (rev 2 §B.2). */
  setViewport(viewport: { width: number; height: number }): void;
  stop(): void;
}

function pruneMinute(list: number[], now: number): void {
  while (list.length && now - list[0] >= 60_000) list.shift();
}

export function createFrameHost(opts: FrameHostOptions, now: () => number = Date.now): FrameHost {
  let stopped = false;
  let ready = false;
  let visible: boolean | null = null;
  let tokens = CALL_BURST;
  let refilledAt = now();
  let pressAt: number | null = null;
  let missed = 0;
  let pingSeq = 0;
  const errors: number[] = [];
  const limited: number[] = [];
  const subs = new Map<number, () => void>();

  const readyTimer = setTimeout(() => stop("no-ready"), READY_TIMEOUT_MS);
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function clear(): void {
    clearTimeout(readyTimer);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    for (const end of subs.values()) end();
    subs.clear();
  }

  function stop(reason: StopReason): void {
    if (stopped) return;
    stopped = true;
    clear();
    opts.onStop(reason);
  }

  function takeToken(): boolean {
    const t = now();
    tokens = Math.min(CALL_BURST, tokens + ((t - refilledAt) / 1000) * CALLS_PER_SECOND);
    refilledAt = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  function noteLimited(): void {
    const t = now();
    pruneMinute(limited, t);
    limited.push(t);
    if (limited.length >= RATE_LIMITED_PER_MINUTE) stop("rate-limited");
  }

  function reply(id: unknown, answer: VerbAnswer, verb?: string): void {
    if (stopped) return;
    if (answer.ok) {
      opts.post({ id, ok: true, value: answer.value === undefined ? null : answer.value });
      return;
    }
    const error = { message: "", ...answer.error };
    opts.post({ id, ok: false, error });
    if (verb) opts.onRefusal?.(verb, error.code);
    if (error.code === "rate_limited") noteLimited();
  }

  function refuse(id: unknown, code: string, verb?: string, extra: Partial<VerbError> = {}): void {
    reply(id, { ok: false, error: { code, ...extra } }, verb);
  }

  function handleCall(id: unknown, verb: string, args: unknown[]): void {
    const row = phoneOf.get(verb);
    if (row === "never") return refuse(id, "not_exposed", verb);
    if (row === "host") {
      const pressed = pressAt !== null && now() - pressAt < PRESS_WINDOW_MS;
      void Promise.resolve(opts.hostVerb(verb, args, pressed)).then((a) => reply(id, a, verb));
      return;
    }
    void opts.forward(verb, args).then((a) => reply(id, a, verb));
  }

  function handleSub(sub: number, verb: string, args: unknown[]): void {
    if (subs.size >= MAX_SUBSCRIPTIONS) {
      opts.post({ sub, error: { code: "rate_limited", message: "" } });
      noteLimited();
      return;
    }
    const ended = opts.subscribe?.(verb, args, (value) => {
      if (!stopped && subs.has(sub)) opts.post({ sub, value });
    }) ?? { code: phoneOf.get(verb) === "never" ? "not_exposed" : "verb_unavailable" };
    if (typeof ended === "function") subs.set(sub, ended);
    else opts.post({ sub, error: { message: "", ...ended } });
  }

  function sizeOf(message: Record<string, unknown>): number {
    const { bytes: _bytes, ...rest } = message;
    try {
      return new TextEncoder().encode(JSON.stringify(rest)).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function bytesFit(message: Record<string, unknown>): boolean {
    const b = message.bytes;
    return !(b instanceof ArrayBuffer) || b.byteLength <= MAX_BLOB_BYTES;
  }

  function onMessage(data: unknown): void {
    if (stopped || !data || typeof data !== "object") return;
    const m = data as Record<string, unknown>;
    if (m.ready === true) {
      if (ready) return;
      ready = true;
      clearTimeout(readyTimer);
      missed = 0;
      pingTimer = setInterval(() => {
        if (missed >= MISSED_PONGS) return stop("not-responding");
        missed += 1;
        pingSeq += 1;
        opts.post({ ping: pingSeq });
      }, PING_MS);
      if (visible !== null) opts.post({ visible });
      opts.onReady?.();
      return;
    }
    if (typeof m.pong === "number") {
      missed = 0;
      return;
    }
    if (m.pointer === "down") {
      pressAt = now();
      return;
    }
    if (m.pointer === "up" || "chord" in m) return;
    if (typeof m.unsub === "number") {
      subs.get(m.unsub)?.();
      subs.delete(m.unsub);
      return;
    }
    const size = m.size;
    if (size && typeof size === "object" && typeof (size as { height?: unknown }).height === "number") {
      opts.onSize?.((size as { height: number }).height);
      return;
    }
    if (m.error && typeof m.error === "object" && m.id === undefined) {
      const e = m.error as { message?: unknown; stack?: unknown };
      opts.onError?.({
        message: String(e.message ?? "error").slice(0, 500),
        ...(typeof e.stack === "string" ? { stack: e.stack.slice(0, 2000) } : {}),
      });
      const t = now();
      pruneMinute(errors, t);
      errors.push(t);
      if (errors.length >= ERRORS_PER_MINUTE) stop("keeps-failing");
      return;
    }
    const isCall = typeof m.id === "number" && typeof m.verb === "string";
    const isSub = typeof m.sub === "number" && typeof m.verb === "string";
    if (!isCall && !isSub) return;
    const verb = m.verb as string;
    const args = Array.isArray(m.args) ? m.args : [];
    if (sizeOf(m) > MAX_MESSAGE_BYTES || !bytesFit(m)) {
      if (isCall) return refuse(m.id, "too_large", verb);
      opts.post({ sub: m.sub, error: { code: "too_large", message: "" } });
      return;
    }
    if (!takeToken()) {
      if (isCall) return refuse(m.id, "rate_limited", verb);
      opts.post({ sub: m.sub, error: { code: "rate_limited", message: "" } });
      noteLimited();
      return;
    }
    if (isCall) handleCall(m.id, verb, args);
    else handleSub(m.sub as number, verb, args);
  }

  return {
    onMessage,
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      if (!stopped && ready) opts.post({ visible: next });
    },
    setViewport(next) {
      if (!stopped && ready) opts.post({ viewport: next });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clear();
    },
  };
}
