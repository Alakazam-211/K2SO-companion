import { useEffect, useRef, useState } from "react";
import type { ServerScope } from "../api/scope";
import {
  FEATURE_LLM_ACCOUNT_FOR,
  isUsageChangedFor,
  readAccountUsage,
  refreshAccountUsage,
  usageAgeMinutes,
  type AccountUsage,
} from "../api/llmAccountFor";
import { useThreadFilesOn } from "./ThreadFiles";
import { subscribeAppEvents } from "./ticketEvents";
import { onForegroundLater } from "../lib/foreground";

/** The usage of the LLM account the open chat's session uses (K2 0.46.4
 *  `llm-account-for-v1`), read when the chat opens and when the app comes
 *  back to the foreground (the cached reading, then a refresh, which only
 *  replaces it when it answers); never polled. While the chat is open a
 *  `subscription_usage_changed` for its token re-reads the cached reading,
 *  never the refresh. Null on an older server, while loading, or when the
 *  server names no account. */
export function useAgentUsage(scope: ServerScope, addr: string | null): AccountUsage | null {
  const on = useThreadFilesOn(scope, FEATURE_LLM_ACCOUNT_FOR);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    setUsage(null);
    if (!on || !addr) return;
    let live = true;
    let current: AccountUsage | null = null;
    // Answers can land out of order; an older one never replaces a newer.
    let asked = 0;
    let landed = 0;
    const land = (n: number, u: AccountUsage | null, keepOnNull: boolean) => {
      if (!live || n < landed || (!u && keepOnNull)) return;
      landed = n;
      current = u;
      setUsage(u);
    };
    const read = () => {
      const scope = scopeRef.current;
      const first = ++asked;
      void readAccountUsage(scope, addr).then((u) => {
        land(first, u, false);
        const second = ++asked;
        return refreshAccountUsage(scope, addr).then((r) => land(second, r, true));
      });
    };
    read();
    const offVis = onForegroundLater(`usage:${addr}`, read);
    const events = subscribeAppEvents(
      scopeRef.current,
      (f) => isUsageChangedFor(f, current),
      () => {
        const n = ++asked;
        void readAccountUsage(scopeRef.current, addr).then((u) => land(n, u, true));
      }
    );
    return () => {
      live = false;
      offVis();
      events.stop();
    };
  }, [scope.id, addr, on]);
  return usage;
}

/** Whole minutes old once a reading is old enough to say so (else null),
 *  checked once a minute. */
export function useUsageAgeMinutes(updatedAt: number | null): number | null {
  const [min, setMin] = useState(() => usageAgeMinutes(updatedAt, Date.now()));
  useEffect(() => {
    const check = () => setMin(usageAgeMinutes(updatedAt, Date.now()));
    check();
    if (updatedAt == null) return;
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [updatedAt]);
  return min;
}

/** The usage percent's colour (Rosson 2026-10-24): white, yellow from 75%,
 *  red from 90%. */
export function usageColor(pct: number): string {
  return pct >= 90 ? "#ff6961" : pct >= 75 ? "#ffd60a" : "rgba(255, 255, 255, 0.9)";
}
