import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { scopeFor } from "../api/scope";
import { zenScope } from "../zen/zenScope";
import { ZEN_SERVER_PARAM, resolveServerRef } from "../zen/room/serverRef";
import { GardenView } from "../zen/gardens/GardenView";
import { fetchGardenFeed, refusalEndsGardens, type GardenFeed, type GardenRefusal } from "../zen/gardens/gardensApi";
import { forgetGardenLibs } from "../zen/gardens/frameDoc";
import { forgetGardenFeed } from "../zen/gardens/GardensList";

const GARDEN_PARAM = "garden";
const MUTED = "#8e8e93";

function feedProblem(r: GardenRefusal, server: string): string {
  if (r.code === "unreachable") return `Can't reach ${server}.`;
  return r.hint || "Gardens couldn't load.";
}

/** `/zen/gardens?garden=`: one Garden, opened from the Gardens tab. With no
 *  `garden` (an old link) it lists them. */
export function ZenGardens() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [scope] = useState(() => {
    const ref = (params.get(ZEN_SERVER_PARAM) || "").trim();
    const id = ref ? resolveServerRef(ref) : null;
    return id ? scopeFor(id) : zenScope();
  });
  const [feed, setFeed] = useState<GardenFeed | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const gardenId = (params.get(GARDEN_PARAM) || "").trim();
  const scheme = useMemo(
    () => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"),
    []
  );

  const onEnded = useCallback((_code: string, hint: string) => {
    // §9: nothing of this server's Gardens stays. Pages and frames live only
    // in this screen's state for now; the list and libraries are all that's kept.
    forgetGardenLibs();
    forgetGardenFeed(scope.id);
    setFeed(null);
    setProblem(hint || "Gardens aren't available on this phone.");
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    void fetchGardenFeed(scope).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        if (refusalEndsGardens(r.refusal.code)) onEnded(r.refusal.code, r.refusal.hint);
        else setProblem(feedProblem(r.refusal, scope.label));
        return;
      }
      setFeed(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, onEnded]);

  const open = useCallback(
    (id: string) => {
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set(GARDEN_PARAM, id);
          return next;
        },
        { replace: !!gardenId }
      );
    },
    [setParams, gardenId]
  );

  const rows = feed?.gardens ?? [];
  const current = rows.find((g) => g.id === gardenId) ?? null;
  const title = current?.name ?? "Gardens";

  return (
    <div className="h-full min-h-0 flex flex-col zen-font" style={{ background: "#000", color: "#fff" }} data-testid="zen-gardens">
      <header className="shrink-0" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="flex items-center" style={{ height: 52, padding: "0 12px", columnGap: 10 }}>
          <button
            type="button"
            className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={{ width: 34, height: 34, color: "#fff" }}
            aria-label="Back"
            data-testid="gardens-back"
            onClick={() => navigate(-1)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="min-w-0 truncate text-[17px] font-semibold" data-testid="gardens-title">
            {title}
          </span>
        </div>
      </header>
      <main className="flex-1 min-h-0" style={{ paddingBottom: gardenId ? 0 : "env(safe-area-inset-bottom)" }}>
        {problem ? (
          <div className="h-full flex items-center justify-center text-center text-[15px]" style={{ padding: 24, color: MUTED }} data-testid="gardens-problem">
            {problem}
          </div>
        ) : !feed ? (
          <div className="h-full" data-testid="gardens-loading" />
        ) : gardenId ? (
          <GardenView
            key={gardenId}
            scope={scope}
            gardenId={gardenId}
            feed={rows}
            scheme={scheme}
            onSwitch={open}
            onEnded={onEnded}
          />
        ) : !feed.setUp || rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center text-[15px]" style={{ padding: 24, color: MUTED }} data-testid="gardens-empty">
            No Gardens on {scope.label} yet
          </div>
        ) : (
          <div className="h-full overflow-y-auto" data-testid="gardens-list">
            {rows.map((g) => (
              <button
                key={g.id}
                type="button"
                className="w-full text-left text-[17px]"
                style={{ padding: "14px 20px", borderBottom: "0.5px solid rgba(255,255,255,.12)", color: "#fff" }}
                data-testid="gardens-row"
                onClick={() => open(g.id)}
              >
                {g.name}
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
