import { useEffect, useState } from "react";
import type { ServerScope } from "../../api/scope";
import { onForegroundLater } from "../../lib/foreground";
import { fetchGardenFeed, isZenChanged, type GardenFeed, type GardenRefusal } from "./gardensApi";
import { RowDivider } from "../RowDivider";
import { subscribeAppEvents } from "../ticketEvents";

const MUTED = "#8e8e93";

/** The last list per server, so coming back paints at once (replaced by the
 *  read). Holds names and versions only, never Garden data. */
const lastFeed = new Map<string, GardenFeed>();

export function forgetGardenFeed(serverId: string): void {
  lastFeed.delete(serverId);
}

function Note({ text, testId }: { text: string; testId: string }) {
  return (
    <p className="text-[15px] text-center" style={{ padding: "32px 24px", color: MUTED }} data-testid={testId}>
      {text}
    </p>
  );
}

function problemOf(r: GardenRefusal, server: string): string {
  if (r.code === "unreachable") return `Can't reach ${server}.`;
  return r.hint || "Gardens couldn't load.";
}

/** The Gardens tab: this server's Gardens. A row opens the Garden's page.
 *  Stays current like Homes: the same cursor-and-replace feed, re-read on
 *  `zen_changed` from the server's hub and on each return to the app. */
export function GardensList({
  scope,
  query,
  onOpen,
}: {
  scope: ServerScope;
  query: string;
  onOpen(id: string): void;
}) {
  const [feed, setFeed] = useState<GardenFeed | null>(() => lastFeed.get(scope.id) ?? null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void fetchGardenFeed(scope, lastFeed.get(scope.id)?.cursor).then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setProblem(null);
          // `full: false`: nothing changed since that cursor.
          if (!r.data.full && lastFeed.has(scope.id)) return;
          lastFeed.set(scope.id, r.data);
          setFeed(r.data);
        } else {
          // What's on screen stays through a blip; a refusal replaces it.
          if (r.refusal.code !== "unreachable") {
            lastFeed.delete(scope.id);
            setFeed(null);
          }
          setProblem(problemOf(r.refusal, scope.label));
        }
      });
    setFeed(lastFeed.get(scope.id) ?? null);
    read();
    const off = onForegroundLater("gardens-feed", read);
    const events = subscribeAppEvents(scope, isZenChanged, read);
    return () => {
      cancelled = true;
      off();
      events.stop();
    };
  }, [scope]);

  const rows = feed?.gardens ?? [];
  if (problem && !rows.length) return <Note text={problem} testId="gardens-problem" />;
  if (!feed) return <div data-testid="gardens-loading" />;
  if (!feed.setUp || rows.length === 0) return <Note text={`No Gardens on ${scope.label} yet`} testId="gardens-empty" />;
  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((g) => g.name.toLowerCase().includes(needle)) : rows;
  if (shown.length === 0) return <Note text="No matches." testId="gardens-no-match" />;
  return (
    <div data-testid="gardens-list">
      {shown.map((g, i) => (
        <div key={g.id} className="relative">
          <button
            type="button"
            className="w-full text-left text-[17px] font-semibold"
            style={{ padding: "16px 20px", color: "#fff" }}
            data-testid="gardens-row"
            onClick={() => onOpen(g.id)}
          >
            {g.name}
          </button>
          {i < shown.length - 1 ? <RowDivider padLeft="20px" padRight="20px" /> : null}
        </div>
      ))}
    </div>
  );
}
