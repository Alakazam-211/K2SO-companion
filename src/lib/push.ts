import { invoke, addPluginListener } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { cliAuthHeaders } from "../api/cliAuth";
import { useServersStore, getActiveServer, type ServerEntry } from "../stores/servers";
import { zenTicketPath } from "../zen/terminalJump";

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

const PLUGIN = "k2-push";
const STORE_FILE = "push.json";

interface Availability {
  available: boolean;
  platform: string;
  reason?: string | null;
}

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
  /** May name a different server in a later version; V1 navigates on
   *  the current server regardless. */
  subdomain?: string;
}

// ─── Availability (session-cached probe) ───

let availabilityPromise: Promise<Availability> | null = null;

/** Full probe result (Settings shows the reason in the dormant state). */
export function pushAvailability(): Promise<Availability> {
  if (!availabilityPromise) {
    availabilityPromise = invoke<Availability>(`plugin:${PLUGIN}|is_available`).catch(
      // No tauri runtime (browser dev) or plugin rejection — unavailable.
      (e) => ({ available: false, platform: "unknown", reason: String(e) })
    );
  }
  return availabilityPromise;
}

export async function pushIsAvailable(): Promise<boolean> {
  return (await pushAvailability()).available;
}

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

async function postPush(
  server: ServerEntry,
  path: string,
  body: Record<string, string>
): Promise<void> {
  const token = useServersStore.getState().tokens[server.id];
  if (!token) throw new Error("no session token");
  const url = `${server.url}${path}`;
  const res = await tauriFetch(url, {
    method: "POST",
    headers: cliAuthHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
}

// ─── Register / unregister ───

/** Called after the ACTIVE server is connected (and from Settings when
 *  the toggle turns on). Gates: plugin available AND user enabled the
 *  toggle → request permission (the OS prompts at most once; a denial
 *  just ends here) → token → register-device. Never throws. */
export async function ensureRegistered(server: ServerEntry): Promise<void> {
  try {
    if (!(await pushIsAvailable())) return;
    if (!(await getPushEnabled())) return;
    const perm = await invoke<{ granted: boolean }>(`plugin:${PLUGIN}|request_permission`);
    if (!perm.granted) return;
    const tok = await invoke<{ token: string; platform: string }>(`plugin:${PLUGIN}|get_token`);
    const deviceId = await getDeviceId();
    await postPush(server, "/cli/push/register-device", {
      deviceId,
      platform: tok.platform,
      token: tok.token,
    });
  } catch (e) {
    // Push is best-effort; the next launch/connect retries.
    console.warn("[push] register skipped:", e);
  }
}

/** Toggle-off: remove this device from a server's registry (blind). */
export async function unregister(server: ServerEntry): Promise<void> {
  try {
    const deviceId = await getDeviceId();
    await postPush(server, "/cli/push/unregister-device", { deviceId });
  } catch (e) {
    console.warn("[push] unregister skipped:", e);
  }
}

/** Toggle-off hygiene: registration follows the ACTIVE server around,
 *  so any saved server we still hold a session for may know this
 *  device — unregister from all of them. */
export async function unregisterAll(): Promise<void> {
  const s = useServersStore.getState();
  await Promise.all(s.servers.filter((x) => s.tokens[x.id]).map((x) => unregister(x)));
}

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
  // V1: a `subdomain` naming another server is ignored — navigate on
  // the current server (spec'd fallback).
  const kind = str(tap.kind);
  if (TICKET_KINDS.has(kind)) {
    const id = tapTicketId(tap);
    if (!id) return null;
    return opts.zen === false ? `/feedback/${encodeURIComponent(id)}` : zenTicketPath(id);
  }
  const groupId = str(tap.groupId);
  if (kind === "project" && groupId) return `/projects/${groupId}`;
  return null;
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
    tapPath(tap, { zen: isZenUi(pathname()) });

  // Cold-start tap: the notification launched the app; the native side
  // buffered the payload before JS booted.
  try {
    const launch = await invoke<{ tap: TapPayload | null }>(`plugin:${PLUGIN}|get_launch_tap`);
    const path = route(launch?.tap);
    if (path) navigate(path);
  } catch {
    /* no buffered tap */
  }

  const listeners = await Promise.all([
    addPluginListener(PLUGIN, "tap", (tap: TapPayload) => {
      const path = route(tap);
      if (path) navigate(path);
    }),
    addPluginListener(PLUGIN, "tokenRefresh", () => {
      // Vendor rotated the token — re-upsert (same deviceId).
      const active = getActiveServer();
      if (active) void ensureRegistered(active);
    }),
  ]).catch(() => []);

  return () => {
    for (const l of listeners ?? []) void l.unregister();
  };
}
