/** Clearly labelled stub catalog. Names cannot pass as a live fleet.
 *  QA: this is not live data. Never use real agent or file names here. */

export type StubAgent = {
  id: string;
  name: string;
  initial: string;
  /** Workspace path — live hydrate only; files list this dir. */
  path?: string;
  /** Overlay addr from `/cli/projects/list` handle after a path join. Null = not chattable. */
  addr?: string | null;
  /** Why this row is not chattable. Set when the path join missed. */
  joinMiss?: string | null;
  agentType?: string;
  kind?: "agent" | "group";
  groupId?: string;
  memberCount?: number | null;
  mode?: string | null;
  enabled?: boolean | null;
  live?: boolean | null;
  /** Sidecar line-two title from the server. Main chats omit this. */
  chatTitle?: string | null;
  /** Desktop tab id for POST /cli/workspace/set-tab-title. */
  tabId?: string | null;
  /** Workspace id for POST /cli/workspace/set-tab-title. */
  projectId?: string | null;
  /** Live PTY id for GET /cli/sessions/label. */
  terminalId?: string | null;
  /** False when the extra is remembered but the Mac tab is gone. Search still finds it. */
  hostLive?: boolean | null;
  /** Desktop workspace colour from `/cli/projects/list`. */
  color?: string | null;
  /** Desktop workspace icon from `/cli/projects/list`. http(s) or data:image. */
  iconUrl?: string | null;
};

export type StubFile = {
  id: string;
  name: string;
  body: string;
  /** Muted second line: the resource's folder, relative to the workspace. */
  hint?: string | null;
  /** Pinned, but the file is gone from disk. Shown, not openable. */
  missing?: boolean;
  /** Opened from a chat link, not a Workspace Resource. Kept for the
   *  open tab only; the Files list hides it. */
  linked?: boolean;
  /** The open read finished (text in `body`, or bytes left to the viewer). */
  loaded?: boolean;
  /** Daemon path the viewer may read. Null = refused (outside the workspace). */
  fsPath?: string | null;
  /** `fs/read-file` failure, e.g. "Cannot read binary file". */
  readError?: string | null;
};

export const STUB_MARK = "STUB";
export const STUB_BANNER = "STUB — not live agents or files";

/** Names no real agent could have. Not fleet handles. */
export const STUB_AGENTS: StubAgent[] = [
  { id: "stub-not-a-real-agent-1", name: "[STUB] not-a-real-agent-1", initial: "1" },
  { id: "stub-not-a-real-agent-2", name: "[STUB] not-a-real-agent-2", initial: "2" },
  { id: "stub-not-a-real-agent-3", name: "[STUB] not-a-real-agent-3", initial: "3" },
];

/** Names no real workspace file could have. */
export const STUB_FILES: StubFile[] = [
  {
    id: "stub-not-a-real-file-1",
    name: "[STUB] not-a-real-file-1.txt",
    body: "STUB FILE — placeholder one.\n\nNot a live workspace file. Daemon read is not used in the no-token catalog.\n",
  },
  {
    id: "stub-not-a-real-file-2",
    name: "[STUB] not-a-real-file-2.txt",
    body: "STUB FILE — placeholder two.\n\nClick another file to add a tab. Two open files sit side by side with one divider.\n",
  },
  {
    id: "stub-not-a-real-file-3",
    name: "[STUB] not-a-real-file-3.txt",
    body: "STUB FILE — placeholder three.\n\nThis catalog is labelled STUB on every row and tab.\n",
  },
];

/** Stub thread only. No user-authored lines — the human wrote none of these. */
export const STUB_THREAD: Record<string, { author: string; mine: boolean; text: string }[]> = {
  "stub-not-a-real-agent-1": [
    {
      author: "[STUB] not-a-real-agent-1",
      mine: false,
      text: "STUB thread. Pick a file on the right.",
    },
  ],
  "stub-not-a-real-agent-2": [
    {
      author: "[STUB] not-a-real-agent-2",
      mine: false,
      text: "STUB thread. Not a live session.",
    },
  ],
  "stub-not-a-real-agent-3": [
    {
      author: "[STUB] not-a-real-agent-3",
      mine: false,
      text: "STUB thread. Not a live session.",
    },
  ],
};

export const STUB_THREAD_FALLBACK: { author: string; mine: boolean; text: string }[] = [
  {
    author: "[STUB] thread",
    mine: false,
    text: "STUB thread. Chat is not wired to a session.",
  },
];
