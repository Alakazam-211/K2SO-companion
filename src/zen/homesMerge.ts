// Homes sync merge rules (K2 0.46.1 `homes-sync-v1`). Pure: no storage,
// no network, no clock (callers pass `now` and this device's id).
//
// The local Homes copy is always the working copy. Every item — a Home or
// a row — carries `updatedAt` (client epoch ms), `by` (the device that
// wrote it) and `order` (a fractional-index string, `./fracIndex`).
// Deleting leaves a tombstone, kept 90 days (the server's window); a Home
// tombstone that names `mergedInto` is kept for good, like the server's.
//
// Rules:
//   - Last writer wins per item by `updatedAt`; an exact tie goes to the
//     larger device id (plain string compare; pulled items carry the
//     writer's `deviceId` as `by`). A tombstone beats an older edit, and
//     wins an exact tie.
//   - Home redirects (`oldId → newId`, from a first-sync merge here or the
//     pull's `redirects`) and Home tombstones with `mergedInto`: the old
//     Home's rows and the selection move to the new Home. Live items for an
//     old id land on the new one; a tombstone always means its own id.
//   - A Home is keyed by `id`; a row by `(homeId, address)`.
//   - Lists sort by `order` (string compare), ties by id / address, so two
//     devices that reorder at once both converge on the same order.
//   - First sync (this phone has Homes and so does the server): union,
//     never delete. Homes with the same name become one, keeping the
//     server's id; the local id redirects to it. Rows are unioned: this
//     phone's rows first, in its order, then the server's other rows.
//   - `selectedId` (the Home on screen) is never synced.

import { compareOrder, normalizeOrder } from "./fracIndex";

export const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface Stamp {
  /** Client epoch ms of the last write. Missing on rows saved before sync
   *  existed (reads as 0: any synced write beats it). */
  updatedAt?: number;
  /** The device id that wrote it (LWW tie-break). */
  by?: string;
}

export interface MergeRow extends Stamp {
  address: string;
  workspaceId: string | null;
  label: string;
  order?: string;
}

export interface MergeHome extends Stamp {
  id: string;
  name: string;
  rows: MergeRow[];
  order?: string;
}

export type Tombstone =
  | { kind: "home"; id: string; updatedAt: number; by?: string; mergedInto?: string }
  | { kind: "row"; homeId: string; address: string; updatedAt: number; by?: string };

export interface HomeChange {
  kind: "home";
  id: string;
  name: string;
  order: string;
  updatedAt: number;
  by?: string;
  deleted?: boolean;
  /** A Home tombstone only: the Home it was merged into. */
  mergedInto?: string;
}

export interface RowChange {
  kind: "row";
  homeId: string;
  address: string;
  label: string;
  workspaceId: string | null;
  order: string;
  updatedAt: number;
  by?: string;
  deleted?: boolean;
}

export type ChangeItem = HomeChange | RowChange;

export interface SyncState {
  homes: MergeHome[];
  tombstones: Tombstone[];
  /** Local Home id → the server's id it merged into (first sync). */
  redirects: Record<string, string>;
}

// ─── Keys + LWW ───

export function homeKey(id: string): string {
  return `h|${id}`;
}

export function rowKey(homeId: string, address: string): string {
  return `r|${homeId}|${address}`;
}

export function changeKey(c: ChangeItem | Tombstone): string {
  return c.kind === "home" ? homeKey(c.id) : rowKey(c.homeId, c.address);
}

/** > 0 when `a` is the later write, < 0 when `b` is, 0 for the same stamp. */
export function compareStamp(a: Stamp, b: Stamp): number {
  const d = (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
  if (d !== 0) return d;
  const ab = a.by ?? "";
  const bb = b.by ?? "";
  return ab === bb ? 0 : ab > bb ? 1 : -1;
}

/** Does an incoming write (`incoming`, maybe a delete) beat what is held
 *  (`held`, maybe a tombstone)? A tombstone wins an exact tie. */
export function incomingWins(
  incoming: Stamp & { deleted?: boolean },
  held: (Stamp & { deleted?: boolean }) | null
): boolean {
  if (!held) return true;
  const c = compareStamp(incoming, held);
  if (c !== 0) return c > 0;
  return !!incoming.deleted && !held.deleted;
}

/** Follow redirects (first-sync merges) to the id a Home has now. */
export function resolveHomeId(redirects: Record<string, string>, id: string): string {
  let cur = id;
  for (let i = 0; i < 8 && redirects[cur] && redirects[cur] !== cur; i++) cur = redirects[cur];
  return cur;
}

// ─── Sorting ───

export function sortRows(rows: MergeRow[]): MergeRow[] {
  return rows
    .slice()
    .sort((a, b) => compareOrder(a.order, b.order) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

export function sortHomes(homes: MergeHome[]): MergeHome[] {
  return homes
    .slice()
    .sort((a, b) => compareOrder(a.order, b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((h) => ({ ...h, rows: sortRows(h.rows) }));
}

/** Give every Home and row an order key matching its position (fewest
 *  keys changed). `restamp` gets the changed items. */
export function withOrderKeys(
  homes: MergeHome[],
  restamp?: (stamp: Stamp) => Stamp
): MergeHome[] {
  const top = normalizeOrder(homes);
  const topChanged = new Set(top.changed);
  return top.items.map((h, i) => {
    const rows = normalizeOrder(h.rows);
    const rowChanged = new Set(rows.changed);
    const nextRows = restamp
      ? rows.items.map((r, j) => (rowChanged.has(j) ? { ...r, ...restamp(r) } : r))
      : rows.items;
    const home = topChanged.has(i) && restamp ? { ...h, ...restamp(h) } : h;
    return { ...home, rows: nextRows };
  });
}

// ─── Change items ───

export function homeChange(h: MergeHome, deleted = false): HomeChange {
  const c: HomeChange = { kind: "home", id: h.id, name: h.name, order: h.order ?? "", updatedAt: h.updatedAt ?? 0 };
  if (h.by) c.by = h.by;
  if (deleted) c.deleted = true;
  return c;
}

export function rowChange(homeId: string, r: MergeRow, deleted = false): RowChange {
  const c: RowChange = {
    kind: "row",
    homeId,
    address: r.address,
    label: r.label,
    workspaceId: r.workspaceId,
    order: r.order ?? "",
    updatedAt: r.updatedAt ?? 0,
  };
  if (r.by) c.by = r.by;
  if (deleted) c.deleted = true;
  return c;
}

function tombstoneChange(t: Tombstone): ChangeItem {
  if (t.kind === "home") {
    const c: HomeChange = { kind: "home", id: t.id, name: "", order: "", updatedAt: t.updatedAt, deleted: true };
    if (t.by) c.by = t.by;
    if (t.mergedInto) c.mergedInto = t.mergedInto;
    return c;
  }
  const c: RowChange = {
    kind: "row",
    homeId: t.homeId,
    address: t.address,
    label: "",
    workspaceId: null,
    order: "",
    updatedAt: t.updatedAt,
    deleted: true,
  };
  if (t.by) c.by = t.by;
  return c;
}

// ─── Local edits → stamped Homes + changes ───

export interface LocalDiff {
  /** `next` with order keys and stamps on every changed item. */
  homes: MergeHome[];
  /** New tombstones for what this edit removed. */
  tombstones: Tombstone[];
  /** Keys of tombstones this edit brought back (re-added items). */
  revived: string[];
  changes: ChangeItem[];
}

/**
 * Compare a local edit's result with what was there before: stamp every
 * new or changed Home / row with `now` + this device, give order keys
 * (a move re-keys only what it must), tombstone what went away.
 */
export function diffLocal(prev: MergeHome[], next: MergeHome[], ctx: { now: number; by: string }): LocalDiff {
  // An edit always beats the write it replaces, even within the same
  // millisecond or under a clock that went backwards.
  const stamp = (over?: Stamp): Stamp => {
    const updatedAt = Math.max(ctx.now, (over?.updatedAt ?? 0) + 1);
    return ctx.by ? { updatedAt, by: ctx.by } : { updatedAt };
  };
  const keyed = withOrderKeys(next);
  const prevById = new Map(prev.map((h) => [h.id, h]));
  const changes: ChangeItem[] = [];
  const tombstones: Tombstone[] = [];
  const revived: string[] = [];
  const homes = keyed.map((h) => {
    const before = prevById.get(h.id);
    let home = h;
    if (!before || before.name !== h.name || before.order !== h.order) {
      home = { ...h, ...stamp(before) };
      changes.push(homeChange(home));
      if (!before) revived.push(homeKey(h.id));
    }
    const prevRows = new Map((before?.rows ?? []).map((r) => [r.address, r]));
    const rows = home.rows.map((r) => {
      const old = prevRows.get(r.address);
      if (old && old.label === r.label && old.workspaceId === r.workspaceId && old.order === r.order) return r;
      const fresh = { ...r, ...stamp(old) };
      changes.push(rowChange(home.id, fresh));
      if (!old) revived.push(rowKey(home.id, r.address));
      return fresh;
    });
    if (before) {
      const still = new Set(home.rows.map((r) => r.address));
      for (const r of before.rows) {
        if (still.has(r.address)) continue;
        const t: Tombstone = { kind: "row", homeId: home.id, address: r.address, ...stamp(r) } as Tombstone;
        tombstones.push(t);
        changes.push(tombstoneChange(t));
      }
    }
    return { ...home, rows };
  });
  const kept = new Set(keyed.map((h) => h.id));
  for (const h of prev) {
    if (kept.has(h.id)) continue;
    const t = { kind: "home", id: h.id, ...stamp(h) } as Tombstone;
    tombstones.push(t);
    changes.push(tombstoneChange(t));
  }
  return { homes, tombstones, revived, changes };
}

/** Merge new tombstones into a list (one per key, the later stamp). */
export function withTombstones(list: Tombstone[], add: Tombstone[], drop: string[] = []): Tombstone[] {
  const map = new Map<string, Tombstone>();
  for (const t of list) map.set(changeKey(t), t);
  for (const k of drop) map.delete(k);
  for (const t of add) {
    const k = changeKey(t);
    const held = map.get(k);
    if (!held || compareStamp(t, held) >= 0) map.set(k, t);
  }
  return [...map.values()];
}

/** Tombstones younger than 90 days (the server keeps them that long). A
 *  `mergedInto` Home tombstone stays (the server never drops those). */
export function pruneTombstones(list: Tombstone[], now: number, maxAgeMs = TOMBSTONE_MAX_AGE_MS): Tombstone[] {
  const kept = list.filter((t) => (t.kind === "home" && !!t.mergedInto) || now - t.updatedAt <= maxAgeMs);
  return kept.length === list.length ? list : kept;
}

// ─── Remote changes → local (steady state) ───

export interface ApplyResult {
  state: SyncState;
  changed: boolean;
  /** Rows for a Home this phone does not have (and has not deleted):
   *  the caller re-pulls the full set. */
  orphans: number;
  /** Rows a redirect moved onto their new Home (they keep their stamps):
   *  the caller queues them so the server holds them there too. */
  moved: RowChange[];
}

export interface ApplyOptions {
  /** The pull's `redirects` (old Home id → the Home it went into). */
  redirects?: Record<string, string>;
}

/** Add redirects; true when one was new. A self-redirect is ignored. */
function addRedirect(redirects: Record<string, string>, from: string, to: string): boolean {
  if (!from || !to || from === to || redirects[from] === to) return false;
  // Never close a loop (to → … → from).
  if (resolveHomeId(redirects, to) === from) return false;
  redirects[from] = to;
  return true;
}

/**
 * Apply pulled changes with last-writer-wins per item. Nothing local is
 * deleted unless a tombstone that wins says so (a `full` answer is applied
 * the same way). Redirects — the pull's, and every Home tombstone's
 * `mergedInto` — are recorded, and a local Home they name folds into its
 * new Home: its rows move there (rows the new Home already has stay as
 * they are), or, when this phone does not have the new Home yet, the Home
 * itself takes the new id (unstamped, so the server's version wins).
 */
export function applyRemote(state: SyncState, items: ChangeItem[], opts: ApplyOptions = {}): ApplyResult {
  let homes = state.homes.map((h) => ({ ...h, rows: h.rows.slice() }));
  const tombs = new Map(state.tombstones.map((t) => [changeKey(t), t]));
  const redirects = { ...state.redirects };
  let changed = false;
  let orphans = 0;
  const movedRows: { homeId: string; row: MergeRow }[] = [];
  for (const [from, to] of Object.entries(opts.redirects ?? {})) {
    if (typeof to === "string" && addRedirect(redirects, from, to)) changed = true;
  }

  for (const it of items) {
    if (it.kind !== "home") continue;
    if (it.deleted) {
      // A tombstone names its own id (never follows a redirect).
      const id = it.id;
      if (it.mergedInto && addRedirect(redirects, id, it.mergedInto)) changed = true;
      const local = homes.find((h) => h.id === id) ?? null;
      const tomb = tombs.get(homeKey(id));
      const held = local ?? (tomb ? { ...tomb, deleted: true } : null);
      if (!incomingWins(it, held)) continue;
      changed = true;
      // A merged Home's rows move in the fold below.
      if (resolveHomeId(redirects, id) === id) homes = homes.filter((h) => h.id !== id);
      tombs.set(homeKey(id), {
        kind: "home",
        id,
        updatedAt: it.updatedAt,
        ...(it.by ? { by: it.by } : {}),
        ...(it.mergedInto ? { mergedInto: it.mergedInto } : {}),
      });
      continue;
    }
    const id = resolveHomeId(redirects, it.id);
    // A live write to a Home that was merged away: the merge stands.
    if (id !== it.id) continue;
    const local = homes.find((h) => h.id === id) ?? null;
    const held = local ?? (tombs.get(homeKey(id)) ? { ...tombs.get(homeKey(id))!, deleted: true } : null);
    if (!incomingWins(it, held)) continue;
    if (local && local.name === it.name && local.order === it.order && compareStamp(it, local) === 0) continue;
    changed = true;
    tombs.delete(homeKey(id));
    const fields = { name: it.name, order: it.order || undefined, updatedAt: it.updatedAt, by: it.by };
    if (local) homes = homes.map((h) => (h.id === id ? { ...h, ...fields } : h));
    else homes.push({ id, rows: [], ...fields });
  }

  // Fold every local Home a redirect names into the Home it went to.
  for (const h of homes.slice()) {
    const target = resolveHomeId(redirects, h.id);
    if (target === h.id) continue;
    changed = true;
    homes = homes.filter((x) => x !== h);
    const into = homes.find((x) => x.id === target);
    if (into) {
      const have = new Set(into.rows.map((r) => r.address));
      const add = h.rows.filter((r) => !have.has(r.address));
      into.rows = [...into.rows, ...add];
      for (const row of add) movedRows.push({ homeId: target, row });
    } else if (!tombs.has(homeKey(target))) {
      homes.push({ ...h, id: target, updatedAt: 0, by: undefined });
      for (const row of h.rows) movedRows.push({ homeId: target, row });
    }
  }

  for (const it of items) {
    if (it.kind !== "row") continue;
    // A live row for a merged-away Home lands on its new Home; a row
    // tombstone only ever means the Home it names.
    const homeId = it.deleted ? it.homeId : resolveHomeId(redirects, it.homeId);
    const home = homes.find((h) => h.id === homeId);
    if (!home) {
      if (!it.deleted && !tombs.has(homeKey(homeId))) orphans += 1;
      continue;
    }
    const local = home.rows.find((r) => r.address === it.address) ?? null;
    const k = rowKey(homeId, it.address);
    const held = local ?? (tombs.get(k) ? { ...tombs.get(k)!, deleted: true } : null);
    if (!incomingWins(it, held)) continue;
    if (
      local &&
      !it.deleted &&
      local.label === it.label &&
      local.workspaceId === it.workspaceId &&
      local.order === it.order &&
      compareStamp(it, local) === 0
    ) {
      continue;
    }
    changed = true;
    if (it.deleted) {
      home.rows = home.rows.filter((r) => r.address !== it.address);
      tombs.set(k, { kind: "row", homeId, address: it.address, updatedAt: it.updatedAt, ...(it.by ? { by: it.by } : {}) });
      continue;
    }
    tombs.delete(k);
    const row: MergeRow = {
      address: it.address,
      label: it.label,
      workspaceId: it.workspaceId,
      order: it.order || undefined,
      updatedAt: it.updatedAt,
      by: it.by,
    };
    home.rows = local ? home.rows.map((r) => (r.address === it.address ? row : r)) : [...home.rows, row];
  }

  if (!changed) return { state, changed: false, orphans, moved: [] };
  // A moved row the pull itself then deleted or rewrote is not re-sent.
  const moved: RowChange[] = [];
  for (const { homeId, row } of movedRows) {
    const now = homes.find((h) => h.id === homeId)?.rows.find((r) => r.address === row.address);
    if (now === row) moved.push(rowChange(homeId, row));
  }
  return {
    state: { homes: sortHomes(homes), tombstones: [...tombs.values()], redirects },
    changed: true,
    orphans,
    moved,
  };
}

/** Outbox items still naming a Home that was merged away: rows move to
 *  the Home it went into; a live write to the old Home itself is dropped
 *  (the merge stands); a tombstone stays as it is. Same array when
 *  nothing changed. */
export function redirectOutbox(outbox: ChangeItem[], redirects: Record<string, string>): ChangeItem[] {
  let changed = false;
  const out: ChangeItem[] = [];
  for (const c of outbox) {
    if (c.kind === "home") {
      if (!c.deleted && resolveHomeId(redirects, c.id) !== c.id) {
        changed = true;
        continue;
      }
      out.push(c);
      continue;
    }
    const homeId = resolveHomeId(redirects, c.homeId);
    if (homeId === c.homeId) {
      out.push(c);
      continue;
    }
    changed = true;
    out.push({ ...c, homeId });
  }
  return changed ? coalesceOutbox([], out) : outbox;
}

// ─── First sync: union, never delete ───

function sameName(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

function sameRow(a: MergeRow, b: MergeRow): boolean {
  return (
    a.label === b.label &&
    a.workspaceId === b.workspaceId &&
    a.order === b.order &&
    compareStamp(a, b) === 0
  );
}

export interface FirstSyncResult {
  state: SyncState;
  /** What the server must hear so it holds the union. */
  changes: ChangeItem[];
}

/**
 * The first sync with a server: `local` (this phone's Homes) and `remote`
 * (the server's full set as change items) become their union. Nothing is
 * deleted on either side. Same-name Homes merge into the server's id
 * (`redirects` records local id → server id).
 */
export function firstSyncMerge(
  local: SyncState,
  remote: ChangeItem[],
  ctx: { now: number; by: string; redirects?: Record<string, string> }
): FirstSyncResult {
  const stamp = (): Stamp => (ctx.by ? { updatedAt: ctx.now, by: ctx.by } : { updatedAt: ctx.now });
  // The server's state, built from its change items (and its redirects:
  // a Home this phone had before that was merged away since).
  const server = applyRemote({ homes: [], tombstones: [], redirects: {} }, remote, { redirects: ctx.redirects }).state;
  const serverHomes = server.homes;
  const serverTombs = new Map(server.tombstones.map((t) => [changeKey(t), t]));
  const serverById = new Map(serverHomes.map((h) => [h.id, h]));
  const used = new Set<string>();
  const redirects = { ...local.redirects };
  for (const [from, to] of Object.entries(server.redirects)) addRedirect(redirects, from, to);

  // Fresh stamp for a local item the server would otherwise drop (its
  // tombstone is newer) or that never had one.
  const keepAlive = <T extends Stamp>(item: T, key: string): T => {
    const t = serverTombs.get(key);
    if (!item.updatedAt || (t && !incomingWins(item, { ...t, deleted: true }))) return { ...item, ...stamp() };
    return item;
  };

  const merged: MergeHome[] = [];
  for (const l of local.homes) {
    const sid = resolveHomeId(redirects, l.id);
    let s = serverById.get(sid) && !used.has(sid) ? serverById.get(sid)! : null;
    if (!s) s = serverHomes.find((h) => !used.has(h.id) && sameName(h.name, l.name)) ?? null;
    if (!s) {
      const home = keepAlive(l, homeKey(l.id));
      merged.push({
        ...home,
        rows: l.rows.map((r) => keepAlive(r, rowKey(l.id, r.address))),
      });
      continue;
    }
    used.add(s.id);
    if (s.id !== l.id) redirects[l.id] = s.id;
    const top = compareStamp(l, s) > 0 ? { name: l.name, updatedAt: l.updatedAt, by: l.by } : { name: s.name, updatedAt: s.updatedAt, by: s.by };
    const serverRows = new Map(s.rows.map((r) => [r.address, r]));
    const rows: MergeRow[] = [];
    const seen = new Set<string>();
    for (const r of l.rows) {
      seen.add(r.address);
      const sr = serverRows.get(r.address);
      if (!sr) rows.push(keepAlive(r, rowKey(s.id, r.address)));
      else rows.push(compareStamp(r, sr) > 0 ? r : sr);
    }
    for (const sr of s.rows) if (!seen.has(sr.address)) rows.push(sr);
    merged.push({ id: s.id, order: s.order, ...top, rows });
  }
  for (const s of serverHomes) if (!used.has(s.id)) merged.push(s);

  // Local first, then the server's: re-key what no longer fits.
  const homes = withOrderKeys(merged, stamp);

  // Push everything the server does not already hold as-is.
  const changes: ChangeItem[] = [];
  for (const h of homes) {
    const s = serverById.get(h.id);
    if (!s || s.name !== h.name || s.order !== h.order || compareStamp(s, h) !== 0) changes.push(homeChange(h));
    const sRows = new Map((s?.rows ?? []).map((r) => [r.address, r]));
    for (const r of h.rows) {
      const sr = sRows.get(r.address);
      if (!sr || !sameRow(sr, r)) changes.push(rowChange(h.id, r));
    }
  }

  const localTombs = local.tombstones.filter((t) => t.kind !== "home" || !redirects[t.id]);
  return {
    state: {
      homes,
      tombstones: withTombstones(localTombs, server.tombstones),
      redirects,
    },
    changes,
  };
}

// ─── Outbox ───

/** Add changes to the outbox: one item per key, the latest write wins. */
export function coalesceOutbox(outbox: ChangeItem[], add: ChangeItem[]): ChangeItem[] {
  const map = new Map<string, ChangeItem>();
  for (const c of outbox) map.set(changeKey(c), c);
  for (const c of add) {
    const k = changeKey(c);
    const held = map.get(k);
    if (!held || compareStamp(c, held) >= 0) map.set(k, c);
  }
  return [...map.values()];
}

/** After a push: drop what was sent (unless rewritten since) and what the
 *  server rejected. */
export function settleOutbox(outbox: ChangeItem[], sent: ChangeItem[], rejectedKeys: string[] = []): ChangeItem[] {
  const sentMap = new Map(sent.map((c) => [changeKey(c), c]));
  const rejected = new Set(rejectedKeys);
  return outbox.filter((c) => {
    const k = changeKey(c);
    if (rejected.has(k)) return false;
    const s = sentMap.get(k);
    return !(s && compareStamp(s, c) === 0 && !!s.deleted === !!c.deleted);
  });
}

// ─── Address migration (hostKey → box id) ───

/** Rewrite every row address through `canon` (`handle::hostKey` →
 *  `handle::serverId`). Two rows that become one on a Home keep the first.
 *  Null when nothing changed. */
export function migrateHomeAddresses(homes: MergeHome[], canon: (address: string) => string): MergeHome[] | null {
  let changed = false;
  const next = homes.map((h) => {
    const seen = new Set<string>();
    let homeChanged = false;
    const rows: MergeRow[] = [];
    for (const r of h.rows) {
      const address = canon(r.address);
      if (address !== r.address) homeChanged = true;
      if (seen.has(address)) {
        homeChanged = true;
        continue;
      }
      seen.add(address);
      rows.push(address === r.address ? r : { ...r, address });
    }
    if (!homeChanged) return h;
    changed = true;
    return { ...h, rows };
  });
  return changed ? next : null;
}
