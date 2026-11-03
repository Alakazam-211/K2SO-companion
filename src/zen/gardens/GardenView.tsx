import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerScope } from "../../api/scope";
import { GardenFrame } from "./GardenFrame";
import { screensOf, shouldRun, stackHeight, type GardenSlot } from "./gardenLayout";
import { fetchGardenPage, refusalEndsGardens, type GardenPageBody, type GardenRow } from "./gardensApi";
import type { HostContext } from "./hostVerbs";

const SIZE_GAP_MS = 250;
const MUTED = "#8e8e93";

function Note({ text, testId }: { text: string; testId: string }) {
  return (
    <div
      className="h-full flex items-center justify-center text-center text-[14px]"
      style={{ padding: 24, color: MUTED }}
      data-testid={testId}
    >
      {text}
    </div>
  );
}

function slotNote(slot: GardenSlot): { text: string; testId: string } {
  const label = slot.widget.name || slot.widget.kind;
  if (slot.widget.kind === "garden-empty") {
    return { text: "This Garden is empty. Ask an agent on your computer to build it.", testId: "garden-empty" };
  }
  if (slot.run === "native") return { text: `${label}: coming in the next build.`, testId: "garden-native" };
  return { text: `${label}: open this on your computer.`, testId: "garden-placeholder" };
}

/** One Garden's page. */
export function GardenView({
  scope,
  gardenId,
  feed,
  scheme,
  onSwitch,
  onEnded,
}: {
  scope: ServerScope;
  gardenId: string;
  feed: readonly GardenRow[];
  scheme: string;
  onSwitch(id: string): void;
  onEnded(code: string, hint: string): void;
}) {
  const [page, setPage] = useState<GardenPageBody | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [visibleHeight, setVisibleHeight] = useState(0);
  const [reported, setReported] = useState<Record<string, number>>({});
  const [folds, setFolds] = useState<ReadonlyMap<number, boolean>>(new Map());
  const scroller = useRef<HTMLDivElement | null>(null);
  const sizeAt = useRef<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    setProblem(null);
    void fetchGardenPage(scope, gardenId, scheme).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        if (refusalEndsGardens(r.refusal.code)) onEnded(r.refusal.code, r.refusal.hint);
        setProblem(
          r.refusal.code === "unreachable" ? `Can't reach ${scope.label}.` : r.refusal.hint || "This Garden couldn't load."
        );
        return;
      }
      if (r.data.schema !== 1) {
        setProblem("Update K2 to show this Garden.");
        return;
      }
      setPage(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, gardenId, scheme, generation, onEnded]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setVisibleHeight(el.clientHeight);
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [page]);

  const screens = useMemo(() => (page ? screensOf(page) : []), [page]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || !el.clientWidth) return;
    setCurrent(Math.round(el.scrollLeft / el.clientWidth));
  }, []);

  const setFold = useCallback((column: number, collapsed: boolean) => {
    setFolds((m) => new Map(m).set(column, collapsed));
    return true;
  }, []);

  const context = useMemo<HostContext | null>(
    () => (page ? { feed, page, scheme, switchGarden: onSwitch, folds, setFold } : null),
    [feed, page, scheme, onSwitch, folds, setFold]
  );

  const onSize = useCallback((id: string, height: number) => {
    const now = Date.now();
    if (now - (sizeAt.current[id] ?? 0) < SIZE_GAP_MS) return;
    sizeAt.current[id] = now;
    setReported((r) => (r[id] === height ? r : { ...r, [id]: height }));
  }, []);

  if (problem) return <Note text={problem} testId="garden-problem" />;
  if (!page || !context) return <div className="h-full" data-testid="garden-loading" />;

  const hasErrors = !!page.errors?.length;
  // A full canvas keeps every finger (contract rev 2 §I): no swipe over it;
  // screens change from the tabs.
  const swipes = page.page.layout.canvas !== "full";
  const goTo = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: swipes ? "smooth" : "auto" });
    setCurrent(i);
  };

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="garden-view">
      {hasErrors ? (
        <div className="shrink-0 text-center text-[12px]" style={{ padding: "4px 12px", color: MUTED }} data-testid="garden-errors">
          This Garden has errors on your computer
        </div>
      ) : null}
      <div
        ref={scroller}
        className="flex-1 min-h-0 flex"
        onScroll={onScroll}
        style={
          swipes
            ? { overflowX: "auto", overflowY: "hidden", scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch" }
            : { overflow: "hidden" }
        }
        data-testid="garden-screens"
      >
        {screens.map((screen, i) => {
          const run = shouldRun(i, current);
          const single = screen.slots.length === 1;
          return (
            <section
              key={screen.index}
              aria-label={screen.label}
              data-testid="garden-screen"
              style={{
                flex: "0 0 100%",
                minWidth: 0,
                height: "100%",
                scrollSnapAlign: "start",
                overflowY: single ? "hidden" : "auto",
                overflowX: screen.minWidth ? "auto" : "hidden",
              }}
            >
              {screen.slots.map((slot) => {
                const id = slot.widget.id;
                const label = slot.widget.name || id;
                const height = single ? "100%" : stackHeight(reported[id], visibleHeight);
                const note = slot.run === "frame" ? null : slotNote(slot);
                return (
                  <div
                    key={id}
                    data-testid="garden-slot"
                    data-widget={id}
                    style={{ height, width: screen.minWidth ? `max(100%, ${screen.minWidth}px)` : "100%" }}
                  >
                    {note ? (
                      <Note {...note} />
                    ) : run ? (
                      <GardenFrame
                        scope={scope}
                        gardenId={gardenId}
                        placement={id}
                        label={label}
                        scheme={scheme}
                        visible={i === current}
                        context={context}
                        onSize={(h) => onSize(id, h)}
                        onEnded={onEnded}
                        onStaleWidget={() => setGeneration((n) => n + 1)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      {screens.length > 1 ? (
        <nav
          className="shrink-0 flex justify-center"
          aria-label="Screens"
          style={{ columnGap: 6, padding: "6px 12px calc(6px + env(safe-area-inset-bottom))", overflowX: "auto" }}
          data-testid="garden-tabs"
        >
          {screens.map((screen, i) => (
            <button
              key={screen.index}
              type="button"
              className="shrink-0 text-[13px] zen-glass zen-glass-pill"
              style={{ padding: "6px 12px", color: "#fff", opacity: i === current ? 1 : 0.55 }}
              aria-current={i === current || undefined}
              data-testid="garden-tab"
              onClick={() => goTo(i)}
            >
              {screen.label}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
