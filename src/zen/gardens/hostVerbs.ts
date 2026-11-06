import type { VerbAnswer } from "./frameHost";
import type { GardenPageBody, GardenRow } from "./gardensApi";

// Verbs the phone answers itself (§5.2), from the page on screen.

export type HostContext = {
  feed: readonly GardenRow[];
  page: GardenPageBody;
  scheme: string;
  /** Show that Garden. */
  switchGarden(id: string): void;
  /** Which columns are folded, by index. */
  folds: ReadonlyMap<number, boolean>;
  setFold(column: number, collapsed: boolean): boolean;
};

const SWITCH_GAP_MS = 2_000;

export type SwitchLimit = { loadedAt: number; lastAt: number | null };

const ok = (value: unknown = null): VerbAnswer => ({ ok: true, value });
const fail = (code: string, message = ""): VerbAnswer => ({ ok: false, error: { code, message } });

export function layoutOf(ctx: Pick<HostContext, "page" | "folds">) {
  // A mobile version has no columns, so no folds (rev 2 §A.6).
  const columns = ctx.page.page.phone ? [] : ctx.page.page.layout.columns ?? [];
  return {
    columns: columns.map((c, index) => ({
      index,
      label: c.label ?? `Column ${index + 1}`,
      collapsible: !!c.collapsible,
      collapsed: ctx.folds.get(index) ?? !!c.collapsed,
    })),
  };
}

export function themeOf(ctx: Pick<HostContext, "page" | "scheme">) {
  const t = ctx.page.theme ?? {};
  return {
    scheme: ctx.scheme,
    vars: (t.vars ?? t.tokens ?? {}) as Record<string, unknown>,
    chrome: t.chrome ?? null,
    motion: ctx.page.motion ?? { reduced: false },
  };
}

/** `gardens.switch` (per frame): not in the first 2 s, then once every 2 s. */
export function switchAllowed(limit: SwitchLimit, now: number): boolean {
  if (now - limit.loadedAt < SWITCH_GAP_MS) return false;
  return limit.lastAt === null || now - limit.lastAt >= SWITCH_GAP_MS;
}

export function answerHostVerb(
  ctx: HostContext,
  limit: SwitchLimit,
  verb: string,
  args: unknown[],
  pressed: boolean,
  now: number
): VerbAnswer {
  const arg = (args[0] ?? {}) as Record<string, unknown>;
  const { garden } = ctx.page;
  switch (verb) {
    case "gardens.list":
      return ok(ctx.feed.map((g) => ({ id: g.id, name: g.name, index: g.index })));
    case "gardens.current":
      return ok({ id: garden.id, name: garden.name, index: garden.index });
    case "gardens.switch": {
      const id = typeof arg.garden === "string" ? arg.garden : "";
      if (!ctx.feed.some((g) => g.id === id)) return fail("not_found");
      if (!switchAllowed(limit, now)) return fail("rate_limited");
      limit.lastAt = now;
      ctx.switchGarden(id);
      return ok();
    }
    case "theme.get":
      return ok(themeOf(ctx));
    case "layout.get":
      return ok(layoutOf(ctx));
    case "layout.set":
    case "layout.toggle": {
      if (ctx.page.page.phone) return fail("failed", "this Garden has no columns on a phone");
      if (!pressed) return fail("failed", "needs a tap");
      const column = typeof arg.column === "number" ? arg.column : -1;
      const row = layoutOf(ctx).columns[column];
      if (!row || !row.collapsible) return fail("failed");
      const next = verb === "layout.toggle" ? !row.collapsed : !!arg.collapsed;
      return ctx.setFold(column, next) ? ok() : fail("failed");
    }
    case "conversation.open":
    case "conversation.close":
    case "agents.show":
    case "canvas.setHitRegions":
      // The native rows and floating chrome come with the next milestone.
      return ok();
    case "boardFile.open":
    case "boardFile.key":
    case "boardFile.submit":
    case "boardFile.hold":
    case "boardFile.flush":
      // K2's own .k5board tab only: a widget in a Garden gets this on a
      // desktop too (catalog 50).
      return { ok: false, error: { code: "verb_unavailable", message: "", feature: "board-file-v1" } };
    default:
      return fail("not_exposed");
  }
}
