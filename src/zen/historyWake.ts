import type { ActiveLlm } from "./llmPresets";
import { sidecarSuffix } from "./sidecarRows";
import {
  isConversationAddr,
  threadAddrOfLive,
  type HistoryRow,
  type LiveWorkspaceSession,
} from "./sessionHistory";

/** Waking a Sessions drawer History row: start the past conversation again
 *  in its workspace, the way desktop Chat history does.
 *
 *  Desktop (`ChatHistory.tsx` `PROVIDER_CONFIG`, K2 `provider_resume.rs`)
 *  spawns the harness with its resume grammar after the preset's own args:
 *  flag style `<cmd> <preset args> <flag> <id>`, subcommand style
 *  `codex <preset args> resume <id>`, as a new locked tab through
 *  `POST /cli/sessions/v2/spawn`. Any other CLI cannot be resumed.
 *  The daemon reads the id back from argv and keeps the Thread on that
 *  conversation (old messages stay); the tab's address is re-read from
 *  `list-for-workspace` (`ws/N` once it has a handle, else the id). */

type Grammar = { command: string; flag?: string; subcommand?: string };

/** Mirrors desktop `RESUMABLE_CLI_TOOLS` / `PROVIDER_CONFIG`. */
export const RESUME_GRAMMAR: Readonly<Record<string, Grammar>> = {
  claude: { command: "claude", flag: "--resume" },
  cursor: { command: "cursor-agent", flag: "--resume" },
  grok: { command: "grok", flag: "--resume" },
  gemini: { command: "gemini", flag: "--resume" },
  pi: { command: "pi", flag: "--session" },
  codex: { command: "codex", subcommand: "resume" },
  hermes: { command: "hermes", flag: "--resume" },
};

/** Session flags a preset may carry that would fight the resume id
 *  (desktop `SESSION_FLAGS_TO_STRIP`; pi's `--resume` is a picker). */
const SESSION_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--session"]);

/** Muted note on a row K2 cannot wake. */
export const READ_ONLY_NOTE = "Can't resume this LLM from the phone";
export const OPEN_READ_ONLY = "Open (read-only)";
export const OPEN_WITHOUT_WAKING = "Open without waking";
export const WAKING = "Waking…";

export function canResume(harness: string | null | undefined): boolean {
  return !!harness && Object.prototype.hasOwnProperty.call(RESUME_GRAMMAR, harness);
}

/** The launch line that resumes `conversationId` under `harness`, as
 *  desktop `ChatHistory.handleSessionClick` builds it: the provider's own
 *  program, the enabled preset's args minus session flags, then the
 *  resume grammar. No preset = no extra args. Null = no resume grammar. */
export function resumeLaunch(
  harness: string | null | undefined,
  conversationId: string,
  llms: ActiveLlm[] | null | undefined
): { command: string; args: string[] } | null {
  const h = (harness || "").trim();
  const id = (conversationId || "").trim();
  if (!id || !canResume(h)) return null;
  const g = RESUME_GRAMMAR[h];
  const preset = (llms ?? []).find((l) => l.harness === h);
  const args = (preset?.args ?? []).filter((a) => !SESSION_FLAGS.has(a));
  if (g.subcommand) args.push(g.subcommand, id);
  else if (g.flag) args.push(g.flag, id);
  return { command: g.command, args };
}

/** What a History tap does.
 *  - `sidecar`: a remembered `ws/handle` sidecar; `ensureSidecarHost`
 *    respawns it with its own harness (that path resumes the sidecar's
 *    conversation daemon-side, keyed by its handle).
 *  - `resume`: spawn `launch` as a new tab in the workspace.
 *  - `readonly`: nothing to wake (unknown harness or a plain shell). */
export type WakePlan =
  | { kind: "sidecar" }
  | { kind: "resume"; conversationId: string; launch: { command: string; args: string[] } }
  | { kind: "readonly" };

export function wakePlanFor(row: HistoryRow, llms: ActiveLlm[] | null | undefined): WakePlan {
  if (sidecarSuffix(row.addr) && !isConversationAddr(row.addr)) return { kind: "sidecar" };
  const conv = (row.conversationId || row.addr || "").trim();
  const launch = conv ? resumeLaunch(row.harness, conv, llms) : null;
  return launch ? { kind: "resume", conversationId: conv, launch } : { kind: "readonly" };
}

/** Thread addr of the live PTY now holding `conversationId`, if any.
 *  A woken tab keeps the conversation id as its Thread addr until the
 *  daemon gives it a `ws/N` handle; either way the refreshed
 *  `list-for-workspace` row says which. */
export function liveThreadAddrFor(
  live: LiveWorkspaceSession[],
  conversationId: string,
  sessionId?: string | null
): string | null {
  const conv = (conversationId || "").trim();
  const hit =
    live.find((l) => !!conv && l.conversationId === conv) ??
    (sessionId ? live.find((l) => l.sessionId === sessionId) : undefined);
  return threadAddrOfLive(hit) ?? null;
}

export type WakeResult =
  | { ok: true; addr: string; terminalId: string | null; already: boolean }
  | { ok: false; error: string };

export type WakeDeps = {
  /** `GET /cli/sessions/list-for-workspace?path=` parsed. Null = failed. */
  listLive: (path: string) => Promise<LiveWorkspaceSession[] | null>;
  /** `POST /cli/sessions/v2/spawn` as a new locked tab running `launch`. */
  spawnTab: (
    path: string,
    launch: { command: string; args: string[] },
    label: string
  ) => Promise<{ ok: boolean; sessionId?: string | null; error?: string }>;
  /** Zen `ensureSidecarHost`: reuse the sidecar's live PTY, else respawn it. */
  ensureSidecar: (row: {
    path: string;
    addr: string;
    chatTitle: string;
    launch: { command: string; args: string[] } | null;
  }) => Promise<{ ok: boolean; terminalId?: string | null; error?: string }>;
  /** Re-read `GET /cli/companion/sessions` (the drawer's Active list). */
  refreshSessions: () => Promise<void>;
};

/** Wake one History row. Idempotent: a conversation already live in the
 *  workspace (a race with desktop or another phone) is just opened. */
export async function wakeHistoryRow(
  input: {
    row: HistoryRow;
    path: string;
    llms: ActiveLlm[] | null | undefined;
    /** Sidecar respawn launch (`launchForHarness`). */
    sidecarLaunch: { command: string; args: string[] } | null;
  },
  deps: WakeDeps
): Promise<WakeResult> {
  const { row, path } = input;
  const plan = wakePlanFor(row, input.llms);
  if (plan.kind === "readonly") return { ok: false, error: "This session can't be resumed" };
  const title = (row.label || row.title || "").trim();
  if (plan.kind === "sidecar") {
    const r = await deps
      .ensureSidecar({ path, addr: row.addr, chatTitle: title || sidecarSuffix(row.addr), launch: input.sidecarLaunch })
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!r.ok) return { ok: false, error: r.error || "Could not wake this session" };
    await deps.refreshSessions().catch(() => {});
    return { ok: true, addr: row.addr, terminalId: ("terminalId" in r && r.terminalId) || null, already: false };
  }
  const conv = plan.conversationId;
  const before = await deps.listLive(path).catch(() => null);
  const live = before?.find((l) => l.conversationId === conv);
  if (live) {
    await deps.refreshSessions().catch(() => {});
    return {
      ok: true,
      addr: threadAddrOfLive(live) || conv,
      terminalId: live.sessionId,
      already: true,
    };
  }
  let spawned: { ok: boolean; sessionId?: string | null; error?: string };
  try {
    spawned = await deps.spawnTab(path, plan.launch, title || "Resumed chat");
  } catch (e) {
    spawned = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const sessionId = (spawned.sessionId || "").trim() || null;
  if (!spawned.ok || !sessionId) {
    return { ok: false, error: spawned.error || "Could not wake this session" };
  }
  await deps.refreshSessions().catch(() => {});
  const after = await deps.listLive(path).catch(() => null);
  return {
    ok: true,
    addr: (after && liveThreadAddrFor(after, conv, sessionId)) || conv,
    terminalId: sessionId,
    already: false,
  };
}
