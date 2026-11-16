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
//   - `synced` (per Home / row, this phone only, never sent): the sync
//     server has seen this identity at least once — it came from a pull,
//     or a push carrying it was not rejected. A local edit keeps it. A
//     `full:true` pull that no longer holds a synced item drops it here
//     with no tombstone (it was deleted elsewhere and the server's
//     tombstone aged out); an item without the mark (never accepted, or
//     saved before the mark existed) is kept and pushed instead
//     (`reconcileFull`). First sync clears every mark (another server's
//     marks mean nothing here).
//
// Home groups (K2 0.46.13, migrations 0305/0306): a Home also carries
// `icon` (a Lucide name) and `recentFirst`; a row carries `pinOrder` and
// `lastMessagedAt`, and a row kind: an agent (`row`, the default), a
// `person` or a `channel`. A row's identity is (kind, homeId, address).
// Older parties leave these fields out:
//   - a pulled item without one of them keeps the value this phone knows
//     (0.46.12 accepts the item but drops the fields; never clear a known
//     value because a pulled item lacks it);
//   - a change item says a field only when it is set, or when this edit
//     cleared it (`icon: null`, `recentFirst: false`, `pinOrder: null`),
//     so a write never clobbers a field another device set meanwhile;
//   - `lastMessagedAt` never moves back (the newest of ours and theirs).

import { compareOrder, normalizeOrder } from "./fracIndex";

export const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface Stamp {
  /** Client epoch ms of the last write. Missing on rows saved before sync
   *  existed (reads as 0: any synced write beats it). */
  updatedAt?: number;
  /** The device id that wrote it (LWW tie-break). */
  by?: string;
}

/** A row's wire kind: an agent (`row`), a person, a channel. */
export type RowKind = "row" | "person" | "channel";

export interface MergeRow extends Stamp {
  /** A person or channel row (K2 0.46.13); absent = an agent. */
  kind?: "person" | "channel";
  address: string;
  workspaceId: string | null;
  label: string;
  order?: string;
  /** The sync server has seen this row (see the header). */
  synced?: boolean;
  /** Its key among the group's pins (fractional index); absent = not
   *  pinned. */
  pinOrder?: string;
  /** The person's own last send to it (epoch ms). */
  lastMessagedAt?: number;
}

export interface MergeHome extends Stamp {
  id: string;
  name: string;
  rows: MergeRow[];
  order?: string;
  /** The sync server has seen this Home (see the header). */
  synced?: boolean;
  /** A Lucide icon name; absent = none (the number draws). */
  icon?: string;
  /** "Most recent at the top"; absent = off. */
  recentFirst?: boolean;
}

/** `x` with the synced mark set or removed (same object when unchanged). */
export function withSynced<T extends { synced?: boolean }>(x: T, on: boolean): T {
  if (!!x.synced === on) return x;
  if (on) return { ...x, synced: true };
  const { synced: _synced, ...rest } = x;
  return rest as T;
}

export type Tombstone =
  | { kind: "home"; id: string; updatedAt: number; by?: string; mergedInto?: string }
  | {
      kind: "row";
      /** A person or channel row's kind; absent = an agent. */
      rowKind?: "person" | "channel";
      homeId: string;
      address: string;
      updatedAt: number;
      by?: string;
    };

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
  /** Absent: this write doesn't say (the server keeps its value). Null:
   *  cleared. */
  icon?: string | null;
  /** Absent: this write doesn't say. */
  recentFirst?: boolean;
}

export interface RowChange {
  kind: RowKind;
  homeId: string;
  address: string;
  label: string;
  workspaceId: string | null;
  order: string;
  updatedAt: number;
  by?: string;
  deleted?: boolean;
  /** Absent: this write doesn't say. Null: unpinned. */
  pinOrder?: string | null;
  /** Absent: this write doesn't say. */
  lastMessagedAt?: number | null;
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

const ROW_KEY_PREFIX: Record<RowKind, string> = { row: "r", person: "p", channel: "c" };

/** A row's key: its kind, Home and address (an agent and a channel may
 *  share an address: two items). An agent row's key is unchanged from
 *  0.46.1 (`r|…`). */
export function rowKey(homeId: string, address: string, kind: RowKind = "row"): string {
  return `${ROW_KEY_PREFIX[kind]}|${homeId}|${address}`;
}

/** A local row's (or tombstone's) wire kind. */
export function rowKindOf(r: { kind?: string } | null | undefined): RowKind {
  return r?.kind === "person" || r?.kind === "channel" ? r.kind : "row";
}

/** The kind an item key names: `home`, or a row kind. */
export function keyKind(key: string): "home" | RowKind | null {
  const p = key.slice(0, 2);
  return p === "h|" ? "home" : p === "r|" ? "row" : p === "p|" ? "person" : p === "c|" ? "channel" : null;
}

/** Is `kind` one of a Home row's wire kinds? */
export function isRowKind(kind: unknown): kind is RowKind {
  return kind === "row" || kind === "person" || kind === "channel";
}

export function changeKey(c: ChangeItem | Tombstone): string {
  if (c.kind === "home") return homeKey(c.id);
  // A tombstone names its row kind in `rowKind` (its `kind` is "row"); a
  // change item in `kind`.
  const kind = (c as { rowKind?: "person" | "channel" }).rowKind ?? c.kind;
  return rowKey(c.homeId, c.address, isRowKind(kind) ? kind : "row");
}

/** A local row's key on Home `homeId`. */
export function rowKeyOf(homeId: string, r: { kind?: string; address: string }): string {
  return rowKey(homeId, r.address, rowKindOf(r));
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

/** A Home's change item. A group field goes when it is set, or as its
 *  "off" value when `before` (the version this edit replaced) had it set:
 *  a clear must be said, a field left out keeps the server's. */
export function homeChange(h: MergeHome, deleted = false, before?: MergeHome | null): HomeChange {
  const c: HomeChange = { kind: "home", id: h.id, name: h.name, order: h.order ?? "", updatedAt: h.updatedAt ?? 0 };
  if (h.by) c.by = h.by;
  if (deleted) c.deleted = true;
  if (!deleted) {
    if (h.icon) c.icon = h.icon;
    else if (before?.icon) c.icon = null;
    if (h.recentFirst) c.recentFirst = true;
    else if (before?.recentFirst) c.recentFirst = false;
  }
  return c;
}

/** A row's change item (fields as for `homeChange`). */
export function rowChange(homeId: string, r: MergeRow, deleted = false, before?: MergeRow | null): RowChange {
  const c: RowChange = {
    kind: rowKindOf(r),
    homeId,
    address: r.address,
    label: r.label,
    workspaceId: r.workspaceId,
    order: r.order ?? "",
    updatedAt: r.updatedAt ?? 0,
  };
  if (r.by) c.by = r.by;
  if (deleted) c.deleted = true;
  if (!deleted) {
    if (r.pinOrder) c.pinOrder = r.pinOrder;
    else if (before?.pinOrder) c.pinOrder = null;
    if (typeof r.lastMessagedAt === "number") c.lastMessagedAt = r.lastMessagedAt;
  }
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
    kind: t.rowKind ?? "row",
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

/** A row tombstone for `r` on Home `homeId`. */
function rowTombstone(homeId: string, r: MergeRow, stamp: Stamp): Tombstone {
  const t: Tombstone = { kind: "row", homeId, address: r.address, updatedAt: stamp.updatedAt ?? 0 };
  if (r.kind) t.rowKind = r.kind;
  if (stamp.by) t.by = stamp.by;
  return t;
}

/** Do two versions of a Home differ in what syncs? */
function homeFieldsDiffer(a: MergeHome, b: MergeHome): boolean {
  return (
    a.name !== b.name ||
    a.order !== b.order ||
    (a.icon ?? null) !== (b.icon ?? null) ||
    !!a.recentFirst !== !!b.recentFirst
  );
}

/** Do two versions of a row differ (synced fields and the label hints)? */
function rowFieldsDiffer(a: MergeRow, b: MergeRow): boolean {
  return (
    a.label !== b.label ||
    a.workspaceId !== b.workspaceId ||
    a.order !== b.order ||
    rowKindOf(a) !== rowKindOf(b) ||
    (a.pinOrder ?? null) !== (b.pinOrder ?? null) ||
    (a.lastMessagedAt ?? null) !== (b.lastMessagedAt ?? null)
  );
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
export function diffLocal(
  prev: MergeHome[],
  next: MergeHome[],
  ctx: { now: number; by: string; tombstones?: Tombstone[] }
): LocalDiff {
  const tombs = new Map((ctx.tombstones ?? []).map((t) => [changeKey(t), t]));
  // An edit always beats the write it replaces (and a re-added item its
  // tombstone), even within the same millisecond or under a clock that
  // went backwards.
  const stamp = (over?: Stamp, key?: string): Stamp => {
    const t = key ? tombs.get(key) : undefined;
    const updatedAt = Math.max(ctx.now, (over?.updatedAt ?? 0) + 1, (t?.updatedAt ?? 0) + 1);
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
    if (!before || homeFieldsDiffer(before, h)) {
      home = { ...h, ...stamp(before, before ? undefined : homeKey(h.id)) };
      changes.push(homeChange(home, false, before));
      if (!before) revived.push(homeKey(h.id));
    }
    const prevRows = new Map((before?.rows ?? []).map((r) => [rowKeyOf(h.id, r), r]));
    const rows = home.rows.map((r) => {
      const k = rowKeyOf(home.id, r);
      const old = prevRows.get(k);
      if (old && !rowFieldsDiffer(old, r)) return r;
      const fresh = { ...r, ...stamp(old, old ? undefined : k) };
      changes.push(rowChange(home.id, fresh, false, old));
      if (!old) revived.push(k);
      return fresh;
    });
    if (before) {
      const still = new Set(home.rows.map((r) => rowKeyOf(home.id, r)));
      for (const r of before.rows) {
        if (still.has(rowKeyOf(home.id, r))) continue;
        const t = rowTombstone(home.id, r, stamp(r));
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
    // Its rows go with it (the group and each of its rows become
    // tombstones), so an Undo that brings it back sends them again.
    for (const r of h.rows) {
      const rt = rowTombstone(h.id, r, stamp(r));
      tombstones.push(rt);
      changes.push(tombstoneChange(rt));
    }
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

/** A pulled Home's group fields over `home`: a field the item leaves out
 *  keeps what `known` (this phone's version) has; null / false clears. */
export function withGroupFields(home: MergeHome, it: HomeChange, known: MergeHome | null): MergeHome {
  const out: MergeHome = { ...home };
  const icon = it.icon === undefined ? known?.icon : it.icon;
  if (icon) out.icon = icon;
  else delete out.icon;
  const recent = it.recentFirst === undefined ? known?.recentFirst : it.recentFirst;
  if (recent) out.recentFirst = true;
  else delete out.recentFirst;
  return out;
}

/** A pulled row's group fields over `row` (as `withGroupFields`). The
 *  last send never moves back: the newer of ours and the server's. */
export function withRowGroupFields(row: MergeRow, it: RowChange, known: MergeRow | null): MergeRow {
  const out: MergeRow = { ...row };
  const pin = it.pinOrder === undefined ? known?.pinOrder : it.pinOrder;
  if (pin) out.pinOrder = pin;
  else delete out.pinOrder;
  const theirs = typeof it.lastMessagedAt === "number" ? it.lastMessagedAt : null;
  const ours = typeof known?.lastMessagedAt === "number" ? known.lastMessagedAt : null;
  const sent = theirs === null ? ours : ours === null ? theirs : Math.max(ours, theirs);
  if (sent !== null) out.lastMessagedAt = sent;
  else delete out.lastMessagedAt;
  return out;
}

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
      if (!incomingWins(it, held)) {
        // The server has seen this Home (its tombstone lost to our edit).
        if (local && !local.synced) {
          changed = true;
          homes = homes.map((h) => (h === local ? withSynced(h, true) : h));
        }
        continue;
      }
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
    if (
      !incomingWins(it, held) ||
      (local && local.name === it.name && local.order === it.order && compareStamp(it, local) === 0)
    ) {
      // Ours stands, but the server has seen this Home.
      if (local && !local.synced) {
        changed = true;
        homes = homes.map((h) => (h === local ? withSynced(h, true) : h));
      }
      continue;
    }
    changed = true;
    tombs.delete(homeKey(id));
    const fields = { name: it.name, order: it.order || undefined, updatedAt: it.updatedAt, by: it.by, synced: true };
    if (local) homes = homes.map((h) => (h.id === id ? withGroupFields({ ...h, ...fields }, it, h) : h));
    else homes.push(withGroupFields({ id, rows: [], ...fields }, it, null));
  }

  // Fold every local Home a redirect names into the Home it went to.
  for (const h of homes.slice()) {
    const target = resolveHomeId(redirects, h.id);
    if (target === h.id) continue;
    changed = true;
    homes = homes.filter((x) => x !== h);
    const into = homes.find((x) => x.id === target);
    // On their new Home the rows are new identities to the server.
    if (into) {
      const have = new Set(into.rows.map((r) => rowKeyOf("", r)));
      const add = h.rows.filter((r) => !have.has(rowKeyOf("", r))).map((r) => withSynced(r, false));
      into.rows = [...into.rows, ...add];
      for (const row of add) movedRows.push({ homeId: target, row });
    } else if (!tombs.has(homeKey(target))) {
      const rows = h.rows.map((r) => withSynced(r, false));
      homes.push({ ...withSynced(h, false), id: target, updatedAt: 0, by: undefined, rows });
      for (const row of rows) movedRows.push({ homeId: target, row });
    }
  }

  for (const it of items) {
    if (it.kind === "home") continue;
    // A live row for a merged-away Home lands on its new Home; a row
    // tombstone only ever means the Home it names.
    const homeId = it.deleted ? it.homeId : resolveHomeId(redirects, it.homeId);
    const home = homes.find((h) => h.id === homeId);
    if (!home) {
      if (!it.deleted && !tombs.has(homeKey(homeId))) orphans += 1;
      continue;
    }
    const sameRow = (r: MergeRow) => r.address === it.address && rowKindOf(r) === it.kind;
    const local = home.rows.find(sameRow) ?? null;
    const k = rowKey(homeId, it.address, it.kind);
    const held = local ?? (tombs.get(k) ? { ...tombs.get(k)!, deleted: true } : null);
    // The server holds exactly this identity (not a row redirected here).
    const sameIdentity = homeId === it.homeId;
    if (
      !incomingWins(it, held) ||
      (local &&
        !it.deleted &&
        local.label === it.label &&
        local.workspaceId === it.workspaceId &&
        local.order === it.order &&
        compareStamp(it, local) === 0)
    ) {
      if (local && sameIdentity && !local.synced) {
        changed = true;
        home.rows = home.rows.map((r) => (r === local ? withSynced(r, true) : r));
      }
      continue;
    }
    changed = true;
    if (it.deleted) {
      home.rows = home.rows.filter((r) => !sameRow(r));
      tombs.set(k, {
        kind: "row",
        ...(it.kind !== "row" ? { rowKind: it.kind } : {}),
        homeId,
        address: it.address,
        updatedAt: it.updatedAt,
        ...(it.by ? { by: it.by } : {}),
      });
      continue;
    }
    tombs.delete(k);
    const row = withRowGroupFields(
      {
        ...(it.kind !== "row" ? { kind: it.kind } : {}),
        address: it.address,
        label: it.label,
        workspaceId: it.workspaceId,
        order: it.order || undefined,
        updatedAt: it.updatedAt,
        by: it.by,
        ...(sameIdentity ? { synced: true } : {}),
      },
      it,
      local
    );
    home.rows = local ? home.rows.map((r) => (sameRow(r) ? row : r)) : [...home.rows, row];
  }

  if (!changed) return { state, changed: false, orphans, moved: [] };
  // A moved row the pull itself then deleted or rewrote is not re-sent.
  const moved: RowChange[] = [];
  for (const { homeId, row } of movedRows) {
    const now = homes
      .find((h) => h.id === homeId)
      ?.rows.find((r) => r.address === row.address && rowKindOf(r) === rowKindOf(row));
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

// ─── Full resync: drop what the server no longer holds ───

export interface FullResyncResult {
  state: SyncState;
  changed: boolean;
  /** Keys of the items dropped here (no tombstone: the server has none). */
  dropped: string[];
  /** Local-only items the server lacks: queue them (Homes before rows). */
  push: ChangeItem[];
}

/**
 * After a `full:true` pull has been merged (`applyRemote`), compare the
 * full set with what this phone holds. An item missing from it that the
 * server had seen (`synced`) was deleted elsewhere and its tombstone aged
 * out: drop it, with no tombstone. An item that never reached the server
 * (no mark) is kept and pushed — offline work is never lost. A synced
 * Home the server lacks still stays when it holds a local-only row (the
 * row keeps its Home; both are pushed); its synced rows go.
 */
export function reconcileFull(state: SyncState, full: ChangeItem[]): FullResyncResult {
  const held = new Set(full.filter((c) => !c.deleted).map(changeKey));
  const dropped: string[] = [];
  const push: ChangeItem[] = [];
  const homes: MergeHome[] = [];
  for (const h of state.homes) {
    const rows: MergeRow[] = [];
    const rowPush: ChangeItem[] = [];
    const rowDrop: string[] = [];
    for (const r of h.rows) {
      const k = rowKeyOf(h.id, r);
      if (held.has(k)) rows.push(r);
      else if (r.synced) rowDrop.push(k);
      else {
        rows.push(r);
        rowPush.push(rowChange(h.id, r));
      }
    }
    if (!held.has(homeKey(h.id))) {
      if (h.synced && rowPush.length === 0) {
        dropped.push(homeKey(h.id), ...h.rows.map((r) => rowKeyOf(h.id, r)));
        continue;
      }
      push.push(homeChange(h));
    }
    push.push(...rowPush);
    dropped.push(...rowDrop);
    homes.push(rows.length === h.rows.length ? h : { ...h, rows });
  }
  if (dropped.length === 0) return { state, changed: false, dropped, push };
  return { state: { ...state, homes }, changed: true, dropped, push };
}

/** Mark the Homes / rows with these keys as seen by the server. Null when
 *  nothing changed. */
export function markSyncedKeys(homes: MergeHome[], keys: Iterable<string>): MergeHome[] | null {
  const want = new Set(keys);
  if (want.size === 0) return null;
  let changed = false;
  const next = homes.map((h) => {
    let home = h;
    if (!h.synced && want.has(homeKey(h.id))) home = withSynced(h, true);
    let rowsChanged = false;
    const rows = h.rows.map((r) => {
      if (r.synced || !want.has(rowKeyOf(h.id, r))) return r;
      rowsChanged = true;
      return withSynced(r, true);
    });
    if (home === h && !rowsChanged) return h;
    changed = true;
    return { ...home, rows };
  });
  return changed ? next : null;
}

// ─── First sync: union, never delete ───

function sameName(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

function sameRow(a: MergeRow, b: MergeRow): boolean {
  return !rowFieldsDiffer(a, b) && compareStamp(a, b) === 0;
}

/** The first-run Home's names, old and new (`nameKey` form). */
const SEED_NAMES: ReadonlySet<string> = new Set(["home", "group 1"]);

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
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
  // Marks from another server mean nothing here; the server's own items
  // (built by `applyRemote` above) carry theirs.
  const localHomes = local.homes.map((h) => ({ ...withSynced(h, false), rows: h.rows.map((r) => withSynced(r, false)) }));
  // An untouched first-run Home is the same Home whichever seed name its
  // device used ("Home" before 0.46.13, "Group 1" after): with no exact
  // name match, an empty local seed merges into an empty server seed.
  const pristine = (h: MergeHome) => SEED_NAMES.has(nameKey(h.name)) && !h.icon && h.rows.length === 0;
  for (const l of localHomes) {
    const sid = resolveHomeId(redirects, l.id);
    let s = serverById.get(sid) && !used.has(sid) ? serverById.get(sid)! : null;
    if (!s) s = serverHomes.find((h) => !used.has(h.id) && sameName(h.name, l.name)) ?? null;
    if (!s && pristine(l)) s = serverHomes.find((h) => !used.has(h.id) && pristine(h)) ?? null;
    if (!s) {
      const home = keepAlive(l, homeKey(l.id));
      merged.push({
        ...home,
        rows: l.rows.map((r) => keepAlive(r, rowKeyOf(l.id, r))),
      });
      continue;
    }
    used.add(s.id);
    if (s.id !== l.id) redirects[l.id] = s.id;
    const localWins = compareStamp(l, s) > 0;
    const top: MergeHome = localWins
      ? { id: s.id, order: s.order, name: l.name, updatedAt: l.updatedAt, by: l.by, rows: [], synced: true }
      : { id: s.id, order: s.order, name: s.name, updatedAt: s.updatedAt, by: s.by, rows: [], synced: true };
    // The group fields follow the winning write; the local icon carries
    // over onto a server Home that has none (a fresh stamp says so).
    const fields = localWins ? l : s;
    if (fields.icon) top.icon = fields.icon;
    if (fields.recentFirst) top.recentFirst = true;
    if (!top.icon && l.icon) Object.assign(top, { icon: l.icon }, stamp());
    const serverRows = new Map(s.rows.map((r) => [rowKeyOf("", r), r]));
    const rows: MergeRow[] = [];
    const seen = new Set<string>();
    for (const r of l.rows) {
      const k = rowKeyOf("", r);
      seen.add(k);
      const sr = serverRows.get(k);
      if (sr) {
        rows.push(compareStamp(r, sr) > 0 ? withSynced(r, true) : sr);
        continue;
      }
      // A merged group keeps the server's pins (and their limit of nine):
      // a row new to it comes without its local pin.
      const { pinOrder: _pin, ...unpinned } = r;
      rows.push(keepAlive(unpinned as MergeRow, rowKeyOf(s.id, r)));
    }
    for (const sr of s.rows) if (!seen.has(rowKeyOf("", sr))) rows.push(sr);
    merged.push({ ...top, rows });
  }
  for (const s of serverHomes) if (!used.has(s.id)) merged.push(s);

  // Local first, then the server's: re-key what no longer fits.
  const homes = withOrderKeys(merged, stamp);

  // Push everything the server does not already hold as-is.
  const changes: ChangeItem[] = [];
  for (const h of homes) {
    const s = serverById.get(h.id);
    if (!s || homeFieldsDiffer(s, h) || compareStamp(s, h) !== 0) changes.push(homeChange(h, false, s));
    const sRows = new Map((s?.rows ?? []).map((r) => [rowKeyOf("", r), r]));
    for (const r of h.rows) {
      const sr = sRows.get(rowKeyOf("", r));
      if (!sr || !sameRow(sr, r)) changes.push(rowChange(h.id, r, false, sr));
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
      const k = `${rowKindOf(r)}|${address}`;
      if (seen.has(k)) {
        homeChanged = true;
        continue;
      }
      seen.add(k);
      // A new address is a new identity to the server.
      rows.push(address === r.address ? r : { ...withSynced(r, false), address });
    }
    if (!homeChanged) return h;
    changed = true;
    return { ...h, rows };
  });
  return changed ? next : null;
}
