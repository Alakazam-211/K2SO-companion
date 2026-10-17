import { invoke, addPluginListener } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { cliAuthHeaders } from "../api/cliAuth";
import { FEATURE_THREAD_PUSH, getBootStatus } from "../api/client";
import { scopeFor, versionAtLeast, type ServerScope } from "../api/scope";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { PHONE_FLOOR } from "../zen/multi/rowStatus";
import { withServerParam } from "../zen/room/serverRef";
import { scopedFetch } from "../api/scopedFetch";
import {
  onServerLeave,
  useServersStore,
  type ServerEntry,
} from "../stores/servers";
import { connectServer } from "./revive";
import { zenProjectPath, zenTicketPath } from "../zen/terminalJump";
import { pushAvailability, pushIsAvailable } from "./pushAvailability";
import {
  FEATURE_PUSH_ENVIRONMENT,
  FEATURE_PUSH_PREVIEWS,
  parseRegisterReply,
  previewsPref,
  usePushPreviewsStore,
} from "../stores/pushPreviews";

// Push glue — Companion C6 (prd-companion-v2 §4). Talks to the local
// `tauri-plugin-k2-push` plugin and the daemon's `/cli/push/*` routes.
//
// DORMANT-FIRST: in today's builds (no aps-environment entitlement, no
// google-services.json) `pushIsAvailable()` is false and every other
// export is a silent no-op — the Settings toggle shows "Not available
// in this build" and nothing here can throw into a caller, prompt, or
// block the connect flow.
//
// Registration contract (daemon push_routes.rs): POST
// `/cli/push/register-device` `{deviceId, platform:"apns"|"fcm", token}`
// upserted by a STABLE deviceId — generated once, persisted in
// plugin-store `push.json` — and re-sent on every app launch, which
// absorbs APNs/FCM token rotation for free. `unregister-device`
// `{deviceId}` on toggle-off (blind; removing a gone device is a no-op).
//
// Optional register-device fields, each sent ONLY to a server whose
// `/boot-status` lists its key (an older daemon may reject an unknown
// field; see `registrationBody`):
//   - `previews` (K2 0.46.1 `push-previews-v1`): this phone's "Show
//     message previews" pref for that server (stores/pushPreviews). The
//     reply's `previews` / `previewsAllowed` are recorded there.
//   - `environment` (`push-environment-v1`): the APNs environment this
//     build's token belongs to, from the app's `aps_environment` command.

const PLUGIN = "k2-push";
const STORE_FILE = "push.json";

export interface TapPayload {
  /** `"ticket"` (daemon since 2026-07-23), legacy `"feedback"`, or
   *  `"project"`. */
  kind?: string;
  /** The ticket id. The daemon sends `feedbackId` (k2-core
   *  `push/mod.rs` `PushEvent::data`); `ticketId` / `id` are accepted
   *  too in case the wire key is renamed later. */
  feedbackId?: string;
  ticketId?: string;
  id?: string;
  groupId?: string;
  /** The tunnel label of the server that sent the push. K2's relay
   *  overwrites it with the label it authenticated, so it is trusted. */
  subdomain?: string;
  /** Thread pushes (K2 0.45.5 `thread-push-v1`). All values are strings.
   *  `instanceId` is daemon-chosen: a tiebreaker only, never a match. */
  instanceId?: string;
  addr?: string;
  conversationId?: string;
  seq?: string;
  projectId?: string;
  agentName?: string;
  msgKind?: string;
  count?: string;
  /** The recipient's person key (TP28): `"owner"` or a Connect username.
   *  Picks between saved accounts on the same host (`matchTapServer`). */
  principal?: string;
  /** Communication Notifications (read by the iOS Notification Service
   *  Extension, not by tap routing): hash of the agent's current avatar,
   *  and the agent's colour (hex) for the initials fallback. */
  avatarRev?: string;
  agentColor?: string;
}

// ─── Availability (session-cached probe; see ./pushAvailability) ───

export { pushAvailability, pushIsAvailable };

// ─── Persisted state (deviceId + the Settings toggle) ───

async function pushStore() {
  return load(STORE_FILE, { defaults: {} });
}

/** Stable device identity for the daemon's upsert key: a UUID minted
 *  once per install and persisted in plugin-store. */
export async function getDeviceId(): Promise<string> {
  const store = await pushStore();
  const existing = await store.get<string>("deviceId");
  if (existing) return existing;
  const id = globalThis.crypto?.randomUUID?.() ?? `d-${Date.now().toString(36)}`;
  await store.set("deviceId", id);
  await store.save();
  return id;
}

export async function getPushEnabled(): Promise<boolean> {
  try {
    const store = await pushStore();
    return (await store.get<boolean>("enabled")) ?? false;
  } catch {
    return false;
  }
}

export async function setPushEnabled(enabled: boolean): Promise<void> {
  const store = await pushStore();
  await store.set("enabled", enabled);
  await store.save();
}

// ─── Daemon calls (same Bearer transport as api/client.ts) ───

/** POST on `scope`'s server only (MS32: its own token, never another's).
 *  No revive: push is best-effort and must not move recovery state. */
async function postPush(
  scope: ServerScope,
  path: string,
  body: Record<string, unknown>
): Promise<string> {
  if (!scope.token()) throw new Error("no session token");
  const res = await scopedFetch(scope, path, {
    method: "POST",
    body: JSON.stringify(body),
    revive: false,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.text;
}

/** POST with credentials captured BEFORE the store drops them (a server
 *  being removed or signed out of — its scope no longer answers). */
async function postWithCaptured(
  server: ServerEntry,
  token: string,
  path: string,
  body: Record<string, string>
): Promise<void> {
  if (!token) throw new Error("no session token");
  const res = await tauriFetch(`${server.url.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: cliAuthHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
}

// ─── Register / unregister ───

type DeviceReg = { deviceId: string; platform: string; token: string };

/** Gates: plugin available AND user enabled the toggle → request
 *  permission (the OS prompts at most once; a denial just ends here) →
 *  vendor token. Null when any gate says no. */
async function deviceRegistration(): Promise<DeviceReg | null> {
  if (!(await pushIsAvailable())) return null;
  if (!(await getPushEnabled())) return null;
  const perm = await invoke<{ granted: boolean }>(`plugin:${PLUGIN}|request_permission`);
  if (!perm.granted) return null;
  const tok = await invoke<{ token: string; platform: string }>(`plugin:${PLUGIN}|get_token`);
  return { deviceId: await getDeviceId(), platform: tok.platform, token: tok.token };
}

let apsEnv: Promise<string | null> | null = null;

/** `"production"` (Release / App Store / TestFlight) or `"development"`
 *  (Xcode Debug), from the app's `aps_environment` command; null when
 *  the command is missing or answers anything else. Read once. */
function apsEnvironment(): Promise<string | null> {
  apsEnv ??= invoke<unknown>("aps_environment")
    .then((v) => (v === "production" || v === "development" ? v : null))
    .catch(() => null);
  return apsEnv;
}

/** The register-device body for one server: the device registration,
 *  plus `previews` when that server lists `push-previews-v1` and
 *  `environment` (APNs only) when it lists `push-environment-v1`. An
 *  unreadable boot-status adds neither. */
export async function registrationBody(
  scope: ServerScope,
  reg: DeviceReg
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { ...reg };
  const boot = await getBootStatus(scope).catch(() => null);
  const features = boot?.features ?? [];
  if (features.includes(FEATURE_PUSH_PREVIEWS)) body.previews = previewsPref(scope.id);
  if (features.includes(FEATURE_PUSH_ENVIRONMENT) && reg.platform === "apns") {
    const env = await apsEnvironment();
    if (env) body.environment = env;
  }
  return body;
}

/** Register on one server; null when it took it, else the error. The
 *  reply's previews fields are recorded (stores/pushPreviews). */
async function registerOn(scope: ServerScope, reg: DeviceReg): Promise<string | null> {
  try {
    const body = await registrationBody(scope, reg);
    const text = await postPush(scope, "/cli/push/register-device", body);
    const sent = typeof body.previews === "boolean" ? body.previews : undefined;
    usePushPreviewsStore.getState().noteReply(scope.id, sent, parseRegisterReply(text));
    return null;
  } catch (e) {
    // Push is best-effort; the next foreground/launch/connect retries.
    console.warn("[push] register skipped:", e);
    return e instanceof Error ? e.message : String(e);
  }
}

/** True when the server took the registration. */
async function registerWith(scope: ServerScope, reg: DeviceReg): Promise<boolean> {
  return (await registerOn(scope, reg)) === null;
}

const previewGens = new Map<string, number>();

/** Server settings → "Show message previews": save the pref at once
 *  (optimistic), then re-register with that server only. On a failure
 *  the pref goes back and the row shows an error. With no registration
 *  on this phone (push off, permission denied, a dormant build) the pref
 *  is just saved; the next registration carries it. True when saved. */
export async function setServerPreviews(serverId: string, on: boolean): Promise<boolean> {
  const store = usePushPreviewsStore.getState();
  const before = previewsPref(serverId);
  const gen = (previewGens.get(serverId) ?? 0) + 1;
  previewGens.set(serverId, gen);
  store.setPref(serverId, on);
  store.setError(serverId, null);
  let error: string | null = null;
  try {
    const reg = await deviceRegistration();
    if (reg) error = await registerOn(scopeFor(serverId), reg);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // A newer toggle owns the row now.
  if (previewGens.get(serverId) !== gen) return !error;
  if (error) {
    store.setPref(serverId, before);
    store.setError(serverId, "Could not save. Try again.");
    return false;
  }
  return true;
}

/** Register this device on one server (upsert by stable deviceId).
 *  Never throws. */
export async function ensureRegistered(scope: ServerScope): Promise<void> {
  try {
    const reg = await deviceRegistration();
    if (reg) await registerWith(scope, reg);
  } catch (e) {
    console.warn("[push] register skipped:", e);
  }
}

/** The servers this device registers on: the ACTIVE one (as before) plus
 *  every other signed-in server that advertises `thread-push-v1` — an
 *  older server's pushes carry no `subdomain`, so a tap could not find
 *  its way back to it. */
export async function registrationTargets(): Promise<ServerEntry[]> {
  return (await sortTargets()).targets;
}

/** `registrationTargets`, plus how many signed-in servers could not be
 *  checked (boot-status unreadable: offline, tunnel timeout). Those are
 *  misses to retry, unlike a server that answered without the feature. */
async function sortTargets(): Promise<{ targets: ServerEntry[]; unknown: number }> {
  const s = useServersStore.getState();
  const signedIn = s.servers.filter((x) => s.tokens[x.id]);
  const keep = await Promise.all(
    signedIn.map(async (x): Promise<boolean | null> => {
      if (x.id === s.activeServerId) return true;
      const b = await getBootStatus(scopeFor(x.id)).catch(() => null);
      return b ? b.features.includes(FEATURE_THREAD_PUSH) : null;
    })
  );
  return {
    targets: signedIn.filter((_, i) => keep[i] === true),
    unknown: keep.filter((k) => k === null).length,
  };
}

/** Re-register on foreground at most this often once every server took
 *  it; after a miss, the next foreground retries straight away. */
export const PUSH_REREGISTER_MS = 30 * 60_000;

let allRun: Promise<void> | null = null;
let lastAllAt = 0;
let lastAllMissed = false;

/** Register on every signed-in server (see `registrationTargets`): on
 *  launch, foreground, server switch, after a login, and when the toggle
 *  turns on. Concurrent calls share one run. Never throws. */
export function registerAllSignedIn(): Promise<void> {
  allRun ??= (async () => {
    try {
      const reg = await deviceRegistration();
      if (!reg) return;
      // A server whose boot-status could not be read (tunnel down) is not
      // a target this time; count it as missed so the next foreground
      // tries again instead of waiting out the throttle.
      const { targets, unknown } = await sortTargets();
      const ok = await Promise.all(targets.map((x) => registerWith(scopeFor(x.id), reg)));
      lastAllMissed = ok.includes(false) || unknown > 0;
      lastAllAt = Date.now();
    } catch (e) {
      lastAllMissed = true;
      console.warn("[push] register skipped:", e);
    } finally {
      allRun = null;
    }
  })();
  return allRun;
}

/** Foreground re-register: a registration missed at launch (a server
 *  offline, a tunnel timeout) heals the next time the app is opened. */
export function registerOnForeground(now = Date.now()): Promise<void> | null {
  if (!lastAllMissed && now - lastAllAt < PUSH_REREGISTER_MS) return null;
  return registerAllSignedIn();
}

/** Test hook: forget the throttle state. */
export function resetPushRegisterState(): void {
  allRun = null;
  apsEnv = null;
  previewGens.clear();
  lastAllAt = 0;
  lastAllMissed = false;
}

/** Register now, again on foreground (throttled; see
 *  `registerOnForeground`), and whenever a server gains a new session
 *  token (any login or revive). Returns the unsubscribe. */
export function watchPushRegistrations(): () => void {
  void registerAllSignedIn();
  const onVisible = () => {
    if (document.visibilityState === "visible") void registerOnForeground();
  };
  const doc = typeof document === "undefined" ? null : document;
  doc?.addEventListener("visibilitychange", onVisible);
  let prev = useServersStore.getState().tokens;
  const stopTokens = useServersStore.subscribe((state) => {
    if (state.tokens === prev) return;
    const before = prev;
    prev = state.tokens;
    const changed = state.servers.filter(
      (x) => state.tokens[x.id] && state.tokens[x.id] !== before[x.id]
    );
    if (!changed.length) return;
    void (async () => {
      try {
        const reg = await deviceRegistration();
        if (!reg) return;
        const targets = new Set((await registrationTargets()).map((x) => x.id));
        await Promise.all(
          changed.filter((x) => targets.has(x.id)).map((x) => registerWith(scopeFor(x.id), reg))
        );
      } catch (e) {
        console.warn("[push] register skipped:", e);
      }
    })();
  });
  return () => {
    doc?.removeEventListener("visibilitychange", onVisible);
    stopTokens();
  };
}

/** Toggle-off: remove this device from a server's registry (blind). */
export async function unregister(scope: ServerScope): Promise<void> {
  try {
    const deviceId = await getDeviceId();
    await postPush(scope, "/cli/push/unregister-device", { deviceId });
  } catch (e) {
    console.warn("[push] unregister skipped:", e);
  }
}

/** Toggle-off hygiene: any saved server we still hold a session for may
 *  know this device — unregister from all of them. */
export async function unregisterAll(): Promise<void> {
  const s = useServersStore.getState();
  await Promise.all(
    s.servers.filter((x) => s.tokens[x.id]).map((x) => unregister(scopeFor(x.id)))
  );
}

/** Rosson Q8: removing or signing out of a server unregisters this device
 *  from it first, with the token captured before the store drops it.
 *  Blind and best-effort; a dormant build does nothing. */
export async function unregisterLeaving(server: ServerEntry, token: string): Promise<void> {
  try {
    if (!(await pushIsAvailable())) return;
    const deviceId = await getDeviceId();
    await postWithCaptured(server, token, "/cli/push/unregister-device", { deviceId });
  } catch (e) {
    console.warn("[push] unregister skipped:", e);
  }
}

onServerLeave((server, token) => {
  void unregisterLeaving(server, token);
});

// ─── Tap deep-link + token rotation wiring ───

/** Ticket push kinds: the daemon sends `"ticket"`; `"feedback"` is the
 *  pre-2026-07-23 wire value, still accepted. */
const TICKET_KINDS = new Set(["ticket", "feedback"]);

/** Classic-UI routes. Anywhere else (including `/`, which redirects to
 *  the `/zen` home, and the shared `/login` `/servers`) Zen is the UI. */
const CLASSIC_PREFIXES = ["/sessions", "/chat", "/projects", "/feedback", "/settings"];

/** True when Zen is the active UI for a tap landing at `pathname`. */
export function isZenUi(pathname: string): boolean {
  return !CLASSIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** First non-empty ticket id key (`feedbackId`, then `ticketId`, `id`). */
export function tapTicketId(tap: TapPayload): string {
  return str(tap.feedbackId) || str(tap.ticketId) || str(tap.id);
}

/** Where a notification tap goes, or null to ignore it. `zen` picks the
 *  Zen Tickets overlay deep link over the classic `/feedback/<id>`. */
export function tapPath(
  tap: TapPayload | null | undefined,
  opts: { zen?: boolean } = {}
): string | null {
  if (!tap) return null;
  // Ticket / project taps navigate on the current server. Thread taps
  // pick their server first (`routeTap`).
  const kind = str(tap.kind);
  if (kind === "thread") return threadTapPath(tap);
  if (TICKET_KINDS.has(kind)) {
    const id = tapTicketId(tap);
    if (!id) return null;
    return opts.zen === false ? `/feedback/${encodeURIComponent(id)}` : zenTicketPath(id);
  }
  const groupId = str(tap.groupId);
  // Zen: Projects, then that project chat on top. Classic: its page.
  if (kind === "project" && groupId) {
    return opts.zen === false ? `/projects/${groupId}` : zenProjectPath(groupId);
  }
  return null;
}

/** `/zen?addr=<addr>&seq=<seq>`: open that Thread, scrolled to `seq`. */
export function threadTapPath(tap: TapPayload): string | null {
  const addr = str(tap.addr);
  if (!addr) return null;
  const seq = str(tap.seq);
  const q = new URLSearchParams({ addr });
  if (/^\d+$/.test(seq)) q.set("seq", seq);
  return `/zen?${q.toString()}`;
}

/** The host of a saved server URL, lowercased, without a port. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** What a server's `/cli/auth/whoami` says about the saved account. */
export interface TapIdentity {
  username?: string | null;
  owner?: boolean;
  /** "owner" | "admin" | "member" (absent on older daemons). */
  role?: string | null;
}

function isOwnerIdentity(id: TapIdentity | null | undefined): boolean {
  return id?.owner === true || str(id?.role).toLowerCase() === "owner";
}

/** Is saved account `x` the push's recipient `principal`? `"owner"`
 *  matches the account whose whoami says owner (an Owner-role Connect
 *  user included). Any other key matches the saved `username` or the
 *  whoami username. */
function isPrincipal(
  principal: string,
  x: ServerEntry,
  identity: TapIdentity | null | undefined
): boolean {
  const key = principal.toLowerCase();
  if (key === "owner" && isOwnerIdentity(identity)) return true;
  return (
    str(x.username).toLowerCase() === key ||
    str(identity?.username).toLowerCase() === key
  );
}

/**
 * Which saved server a push came from (K2 contract, TP28/TP29):
 *   1. `subdomain` — stamped by the relay from the label it authenticated,
 *      so trusted. Saved servers whose URL host is `<subdomain>.k2.dev`.
 *   2. `instanceId` — chosen by the daemon, so only a tiebreaker when
 *      more than one saved server matched step 1.
 *   3. `principal` — the recipient's person key (`"owner"` or a Connect
 *      username; K2 sends one dispatch per recipient). Picks the account
 *      when two saved servers share a host and instance, e.g. an owner
 *      login and a member login on `rosson.k2.dev`.
 *   No `subdomain` match → null (ignore the tap). Never `projectId`.
 *   Still ambiguous after step 3: the active server if it is one of the
 *   candidates, otherwise null (ignore).
 */
export function matchTapServer(
  tap: TapPayload,
  servers: ServerEntry[],
  ctx: {
    instanceIds?: Record<string, string | null | undefined>;
    identities?: Record<string, TapIdentity | null | undefined>;
    activeServerId?: string | null;
  } = {}
): ServerEntry | null {
  const sub = str(tap.subdomain).toLowerCase();
  if (!sub) return null;
  const host = `${sub}.k2.dev`;
  const hits = servers.filter((x) => hostOf(x.url) === host);
  if (hits.length <= 1) return hits[0] ?? null;
  let pool = hits;
  const inst = str(tap.instanceId);
  if (inst) {
    const byInst = pool.filter((x) => ctx.instanceIds?.[x.id] === inst);
    if (byInst.length) pool = byInst;
  }
  if (pool.length === 1) return pool[0];
  const principal = str(tap.principal);
  if (principal) {
    const byPrincipal = pool.filter((x) => isPrincipal(principal, x, ctx.identities?.[x.id]));
    if (byPrincipal.length === 1) return byPrincipal[0];
    if (byPrincipal.length) pool = byPrincipal;
  }
  return pool.find((x) => x.id === ctx.activeServerId) ?? null;
}

const TAP_PROBE_MS = 4000;

/** One saved server's whoami, or null (signed out, timeout, error). On
 *  that server only; no revive (a tap must not move recovery state). */
async function tapWhoami(scope: ServerScope): Promise<TapIdentity | null> {
  try {
    if (!scope.token()) return null;
    const res = await scopedFetch(scope, "/cli/auth/whoami", {
      timeoutMs: TAP_PROBE_MS,
      revive: false,
    });
    if (!res.ok) return null;
    const j = JSON.parse(res.text) as TapIdentity;
    return { username: j.username ?? null, owner: j.owner === true, role: j.role ?? null };
  } catch {
    return null;
  }
}

/** `matchTapServer` with live data for servers tied on host: `instanceId`
 *  read fresh from each one's `/boot-status` (it changes on every daemon
 *  restart), and whoami (role) when the push names a `principal`. */
export async function resolveTapServer(tap: TapPayload): Promise<ServerEntry | null> {
  const s = useServersStore.getState();
  const sub = str(tap.subdomain).toLowerCase();
  const tied = sub
    ? s.servers.filter((x) => hostOf(x.url) === `${sub}.k2.dev`)
    : [];
  const instanceIds: Record<string, string | null> = {};
  const identities: Record<string, TapIdentity | null> = {};
  if (tied.length > 1) {
    const wantInst = !!str(tap.instanceId);
    const wantWho = !!str(tap.principal);
    await Promise.all(
      tied.map(async (x) => {
        const [b, who] = await Promise.all([
          wantInst ? getBootStatus(scopeFor(x.id), { fresh: true }) : null,
          wantWho ? tapWhoami(scopeFor(x.id)) : null,
        ]);
        instanceIds[x.id] = b?.instanceId ?? null;
        identities[x.id] = who;
      })
    );
  }
  return matchTapServer(tap, s.servers, {
    instanceIds,
    identities,
    activeServerId: s.activeServerId,
  });
}

/** Make `serverId` active the way the Servers sheet does: (re)connect,
 *  then switch. False when it needs a sign-in or cannot be reached. */
async function switchToServer(serverId: string): Promise<boolean> {
  const store = useServersStore.getState();
  if (store.activeServerId === serverId) return true;
  const outcome = await connectServer(serverId);
  if (outcome !== "still-valid" && outcome !== "revived") return false;
  useServersStore.getState().setActive(serverId);
  return true;
}

/** A known version below the phone floor cannot hold a room (MS30). */
function belowFloor(serverId: string): boolean {
  const v = scopeFor(serverId).version();
  return !!v && !versionAtLeast(v, PHONE_FLOOR);
}

/** Route one tap.
 *
 *  Thread taps resolve their server first and are dropped when no saved
 *  server matches. With the multi-server flag on (MA23, MS21) a tap from
 *  another server opens a ROOM there — `/zen?addr=&seq=&server=` — and the
 *  active server never changes (a server below the phone floor still
 *  switches, the old way). Flag off: switch, then open (as before).
 *
 *  Ticket taps: Tickets live on the DEFAULT server (NG6, MA34). Flag off,
 *  they open on the current server (as before). Flag on, a ticket whose
 *  `subdomain` names another saved server makes that server the default
 *  first (the user's tap is the explicit choice); no match keeps the
 *  default. Project taps keep the current server. */
export async function routeTap(
  tap: TapPayload | null | undefined,
  navigate: (path: string) => void,
  opts: { zen?: boolean } = {}
): Promise<void> {
  if (!tap) return;
  const kind = str(tap.kind);
  if (kind !== "thread") {
    const path = tapPath(tap, opts);
    if (!path) return;
    if (TICKET_KINDS.has(kind) && useMultiServerPrefs.getState().multiServer && str(tap.subdomain)) {
      try {
        const server = await resolveTapServer(tap);
        const active = useServersStore.getState().activeServerId;
        if (server && server.id !== active && !(await switchToServer(server.id))) return;
      } catch (e) {
        console.warn("[push] ticket tap server check failed:", e);
      }
    }
    navigate(path);
    return;
  }
  const path = threadTapPath(tap);
  if (!path) return;
  try {
    const server = await resolveTapServer(tap);
    if (!server) return;
    const active = useServersStore.getState().activeServerId;
    if (server.id !== active && useMultiServerPrefs.getState().multiServer && !belowFloor(server.id)) {
      navigate(withServerParam(path, server.id));
      return;
    }
    if (!(await switchToServer(server.id))) return;
    navigate(path);
  } catch (e) {
    console.warn("[push] thread tap dropped:", e);
  }
}

function currentPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

/** Wire tap→navigation and tokenRefresh→re-register. Mounted once by
 *  <PushBridge/> inside the router. No-op (returning a no-op cleanup)
 *  when push is unavailable. */
export async function attachPushNavigation(
  navigate: (path: string) => void,
  opts: { pathname?: () => string } = {}
): Promise<() => void> {
  if (!(await pushIsAvailable())) return () => {};
  const pathname = opts.pathname ?? currentPathname;
  const route = (tap: TapPayload | null | undefined) =>
    routeTap(tap, navigate, { zen: isZenUi(pathname()) });

  // Cold-start tap: the notification launched the app; the native side
  // buffered the payload before JS booted.
  try {
    const launch = await invoke<{ tap: TapPayload | null }>(`plugin:${PLUGIN}|get_launch_tap`);
    await route(launch?.tap);
  } catch {
    /* no buffered tap */
  }

  const listeners = await Promise.all([
    addPluginListener(PLUGIN, "tap", (tap: TapPayload) => {
      void route(tap);
    }),
    addPluginListener(PLUGIN, "tokenRefresh", () => {
      // Vendor rotated the token — re-upsert (same deviceId) everywhere.
      void registerAllSignedIn();
    }),
  ]).catch(() => []);

  return () => {
    for (const l of listeners ?? []) void l.unregister();
  };
}
