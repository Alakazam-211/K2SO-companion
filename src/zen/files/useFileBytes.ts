import { useEffect, useState } from "react";
import { loadFileBytes } from "./fileBytes";
import { useZenScope } from "../zenScope";

export type BytesState = {
  bytes: Uint8Array | null;
  error: string | null;
  /** 0..1 while ranged media assembles; null otherwise. */
  progress: number | null;
};

/** Load a file's bytes once per path. A path change drops the old load. */
export function useFileBytes(path: string | null, ranged = false): BytesState {
  // The file lives on the room's server (MS23).
  const scope = useZenScope();
  const [state, setState] = useState<BytesState>({ bytes: null, error: null, progress: null });

  useEffect(() => {
    let cancelled = false;
    setState({ bytes: null, error: null, progress: null });
    if (!path) {
      setState({ bytes: null, error: "This file is not readable from here.", progress: null });
      return;
    }
    loadFileBytes(scope, path, {
      ranged,
      isCancelled: () => cancelled,
      onProgress: (r) => {
        if (!cancelled) setState((s) => ({ ...s, progress: r }));
      },
    }).then(
      (bytes) => {
        if (!cancelled) setState({ bytes, error: null, progress: null });
      },
      (err) => {
        if (cancelled) return;
        const error = err instanceof Error ? err.message : String(err);
        setState({ bytes: null, error, progress: null });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [path, ranged, scope]);

  return state;
}
