// Replying to one Thread message, the desktop's format (K2 0.46.7
// prd-thread-message-menu-v1, `src/renderer/lib/thread-reply.ts`, Rosson
// 2026-10-30). The reply rides the message TEXT, so every server and agent
// already carries it; agents read message N with `k2 thread <addr> --seq N`:
//
//   ↩ #42 sales:
//   > the quoted words (the whole message up to 600 characters, else its
//   > first 600 and "…"; a selection: exactly the selection)
//
//   the person's own words
//
// A reply to a selection says `↩ part of #42 sales:`. The first desktop
// build's long header (`Replying to Thread message 42 from sales (id …):`)
// still reads back. Keep this file in step with the desktop's.

/** A whole message is quoted in full up to this many characters. */
export const THREAD_REPLY_QUOTE_MAX = 600;

export const THREAD_REPLY_MARK = "↩";

export interface ThreadReplyTarget {
  /** The Thread message's id. */
  id: string;
  /** Its seq in the Thread (0 when unknown: no `#N`). */
  seq: number;
  /** Who wrote it, as the agent knows them (an agent's address, a person's login). */
  from: string;
  /** The quoted words: the message's text, or the selected piece. */
  text: string;
  /** A reply to a selected piece of the message. */
  part: boolean;
}

export function threadReplyQuote(target: Pick<ThreadReplyTarget, "text" | "part">): string {
  const text = target.text.replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (target.part) return text;
  const chars = Array.from(text);
  if (chars.length <= THREAD_REPLY_QUOTE_MAX) return text;
  return `${chars.slice(0, THREAD_REPLY_QUOTE_MAX).join("").trimEnd()}…`;
}

/** `↩ #42 sales:`, `↩ part of #42 sales:`. */
export function threadReplyHeader(target: Pick<ThreadReplyTarget, "seq" | "from" | "part">): string {
  const part = target.part ? "part of " : "";
  const num = target.seq > 0 ? `#${target.seq} ` : "";
  const from = target.from.trim().replace(/\s+/g, " ") || "someone";
  return `${THREAD_REPLY_MARK} ${part}${num}${from}:`;
}

/** The text a reply sends: the marker line, the quote as `> ` lines, a
 *  blank line, then the person's words (none: the quote alone). */
export function formatThreadReply(target: ThreadReplyTarget, text: string): string {
  const quote = threadReplyQuote(target)
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
  const words = text.trim();
  return `${threadReplyHeader(target)}\n${quote}${words ? `\n\n${words}` : ""}`;
}

export interface ParsedThreadReply {
  part: boolean;
  /** 0 when the reply named no `#N`. */
  seq: number;
  from: string;
  /** Only the first desktop build's long header carried it ("" otherwise). */
  id: string;
  /** The quoted words (the `> ` taken off). */
  quote: string;
  /** The person's own words after the quote. */
  rest: string;
}

const MARK_HEADER = /^↩ (part of )?(?:#(\d+) )?(.+):$/;
const LONG_HEADER =
  /^Replying to (part of )?Thread message(?: (\d+))? from (.+?) \(id ([^\s;()]+)(?:; read it whole: k2 thread .+? --before-seq \d+ --limit 1)?\):$/;

function readHeader(line: string): { part: boolean; seq: number; from: string; id: string } | null {
  const m = MARK_HEADER.exec(line);
  if (m) return { part: !!m[1], seq: m[2] ? Number(m[2]) : 0, from: m[3], id: "" };
  const l = LONG_HEADER.exec(line);
  if (l) return { part: !!l[1], seq: l[2] ? Number(l[2]) : 0, from: l[3], id: l[4] };
  return null;
}

/** The reply at the start of `body`, else null (any other message). */
export function parseThreadReply(body: string): ParsedThreadReply | null {
  if (!body.startsWith(`${THREAD_REPLY_MARK} `) && !body.startsWith("Replying to ")) return null;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const head = readHeader(lines[0]);
  if (!head) return null;
  let i = 1;
  const quoted: string[] = [];
  while (i < lines.length && (lines[i] === ">" || lines[i].startsWith("> "))) {
    quoted.push(lines[i] === ">" ? "" : lines[i].slice(2));
    i += 1;
  }
  if (quoted.length === 0) return null;
  if (i < lines.length && lines[i] === "") i += 1;
  return { ...head, quote: quoted.join("\n"), rest: lines.slice(i).join("\n") };
}

/** The first non-blank line of `text` (the chip's and the quote line's preview). */
export function threadReplyFirstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}
