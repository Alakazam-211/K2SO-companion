import { useEffect, useRef, useState } from "react";
import type { ServerScope } from "../api/scope";
import { FEATURE_LLM_ACCOUNT_FOR, fetchAccountUsage, type AccountUsage } from "../api/llmAccountFor";
import { useThreadFilesOn } from "./ThreadFiles";

/** The usage of the LLM account the open chat's session uses (K2 0.46.4
 *  `llm-account-for-v1`), read when the chat opens and when the app comes
 *  back to the foreground; never polled. Null on an older server, while
 *  loading, or when the server names no account. */
export function useAgentUsage(scope: ServerScope, addr: string | null): AccountUsage | null {
  const on = useThreadFilesOn(scope, FEATURE_LLM_ACCOUNT_FOR);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    setUsage(null);
    if (!on || !addr) return;
    let live = true;
    const read = () => {
      void fetchAccountUsage(scopeRef.current, addr).then((u) => {
        if (live) setUsage(u);
      });
    };
    read();
    const onVis = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [scope.id, addr, on]);
  return usage;
}
