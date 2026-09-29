/** Clearly labelled stub catalog. Names cannot pass as a live fleet.
 *  QA: this is not live data. Never use real agent or file names here. */

export type StubAgent = {
  id: string;
  name: string;
  initial: string;
  /** Workspace path — live hydrate only; files list this dir. */
  path?: string;
};

export type StubFile = {
  id: string;
  name: string;
  body: string;
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
