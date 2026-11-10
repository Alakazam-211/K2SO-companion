import { useRef } from "react";
import { authorHue } from "../lib/authorTint";
import { skinInitials } from "./agentRow";
import type { StubAgent } from "./stubData";

// Profile pictures in a Thread (Rosson's rule, agreed with K2 Design
// 2026-11-09, desktop the same): on once the messages loaded in the Thread
// (every fetched page and sends in flight) come from two or more senders
// other than me (`mine`, so my other devices are me; system and bot lines
// count). Once on they stay on while that Thread is open, and reset on a
// switch. The picture sits beside the first bubble of each run (runs break
// after 120 s, chatReceipt.ts).

export const THREAD_PICTURE_PX = 28;
export const THREAD_PICTURE_GAP = 8;

export function otherSenderCount(rows: readonly { mine: boolean; from: string }[]): number {
  const seen = new Set<string>();
  for (const r of rows) if (!r.mine) seen.add(r.from.trim().toLowerCase());
  return seen.size;
}

/** On at two other senders, staying on for this Thread (`threadKey`). */
export function useThreadPicturesOn(threadKey: string, others: number): boolean {
  const held = useRef<{ key: string; on: boolean }>({ key: threadKey, on: false });
  if (held.current.key !== threadKey) held.current = { key: threadKey, on: false };
  if (others >= 2) held.current.on = true;
  return held.current.on;
}

export type SenderPicture = { initial: string; color: string | null; iconUrl: string | null };

/** A sender's picture: the agent of that name or handle on this server, or
 *  initials on the same per-name hue the cards use. */
export function senderPicture(from: string, agents: readonly StubAgent[]): SenderPicture {
  const key = from.trim().toLowerCase();
  const agent = agents.find(
    (a) => a.kind !== "group" && (a.name.trim().toLowerCase() === key || (a.addr || "").trim().toLowerCase() === key)
  );
  if (agent) return { initial: agent.initial, color: agent.color ?? null, iconUrl: agent.iconUrl ?? null };
  return { initial: skinInitials(from || "?"), color: `hsl(${authorHue(key || "?")}, 38%, 42%)`, iconUrl: null };
}
