/** Clearly labelled stub catalog. Home/agents-across-servers is not built.
 *  QA: this is not live data. */

export type StubAgent = {
  id: string;
  name: string;
  initial: string;
};

export type StubFile = {
  id: string;
  name: string;
  body: string;
};

export const STUB_BANNER = "STUB — not live agents or files";

export const STUB_AGENTS: StubAgent[] = [
  { id: "k2", name: "k2", initial: "K" },
  { id: "appa", name: "appa", initial: "A" },
  { id: "companion", name: "companion", initial: "C" },
];

export const STUB_FILES: StubFile[] = [
  {
    id: "agent-md",
    name: "AGENT.md",
    body: "STUB FILE — AGENT.md\n\nCharter preview. Daemon file read is not wired here yet.\n",
  },
  {
    id: "home-md",
    name: "Home.md",
    body: "STUB FILE — Home.md\n\nWiki index placeholder. Right-click charter modal is a later carve-out.\n",
  },
  {
    id: "notes",
    name: "notes.txt",
    body: "STUB FILE — notes.txt\n\nClick another file to add a tab. Two open files sit side by side with one divider.\n",
  },
];

export const STUB_THREAD: Record<string, { author: string; mine: boolean; text: string }[]> = {
  k2: [
    { author: "k2", mine: false, text: "STUB thread. Pick a file on the right." },
    { author: "You", mine: true, text: "Structure only — look stays the current tokens." },
  ],
  appa: [{ author: "appa", mine: false, text: "STUB. This is not a live appa session." }],
  companion: [{ author: "companion", mine: false, text: "STUB. Companion workspace agent." }],
};
