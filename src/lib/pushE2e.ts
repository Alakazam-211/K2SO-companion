import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";

// End-to-end encrypted pushes, the app's side (K2 0.46.3 `push-e2e-v1`,
// prd-e2e-push-v1 rev 2 §7). iOS only, and only for a server whose
// `/boot-status` lists the feature; every other server registers exactly
// as before.
//
// For such a server, register-device carries:
//   - `deviceId`: a per (install, saved server) id from the keychain
//     (ThisDeviceOnly: a restored backup or another phone never reuses it);
//   - `e2e:{v:1, suite, publicKey, psk, createdAt}`: this server's key
//     (Secure Enclave) and PSK, from the k2-push plugin (`e2e_op key`).
// Only over the direct path (`https://<label>.k2.dev`, or a LAN address),
// never through the `*.app.k2.dev` Worker (prd §7.1, V15).
//
// The reply's `e2e` says whether this phone gets sealed pushes
// (`active`), whether the server is sealed-only (`enforce`, handed to the
// notification extension), and when to rotate (`rotateAfter`).
//
// The first sealed registration on a server unregisters the install-wide
// id there (the old row would keep getting today's plaintext pushes).

export const FEATURE_PUSH_E2E = "push-e2e-v1" as const;
export const E2E_SUITE = "p256-sha256-aes256gcm-psk" as const;

const PLUGIN = "k2-push";
const STORE_FILE = "push.json";

export type E2eKey = {
  deviceId: string;
  publicKey: string;
  psk: string;
  createdAt: number;
  keyId: string;
};

export type E2eReply = {
  active: boolean;
  enforce: boolean;
  keyId: string | null;
  /** Unix seconds; null when absent. */
  rotateAfter: number | null;
  expiresAt: number | null;
};

/** The tunnel label this phone reaches the box by, when that path is
 *  direct: `https://<label>.k2.dev` (never `<label>.app.k2.dev`, nested
 *  names or other domains). Null otherwise. */
export function directLabel(serverUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.port && u.port !== "443")) return null;
  const m = /^([a-z0-9-]+)\.k2\.dev$/i.exec(u.hostname);
  if (!m || m[1].toLowerCase() === "app") return null;
  return m[1].toLowerCase();
}

/** A private LAN address (`192.168.x`, `10.x`, `172.16–31.x`, `*.local`). */
export function isLanUrl(serverUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase();
  if (h.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** The label sealed pushes name (`srv.sub`), or null when this server
 *  can't take a key from this phone: a direct `<label>.k2.dev` address,
 *  else a LAN address with the box's `publicHost` label known. */
export function e2eLabel(serverUrl: string, publicHost: string | null | undefined): string | null {
  const direct = directLabel(serverUrl);
  if (direct) return direct;
  if (!isLanUrl(serverUrl) || !publicHost) return null;
  return directLabel(`https://${publicHost}`);
}

export function parseE2eReply(raw: unknown): E2eReply | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  const e = o && typeof o === "object" ? (o as Record<string, unknown>).e2e : undefined;
  if (!e || typeof e !== "object") return null;
  const r = e as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    active: r.active === true,
    enforce: r.enforce === true,
    keyId: typeof r.keyId === "string" ? r.keyId : null,
    rotateAfter: num(r.rotateAfter),
    expiresAt: num(r.expiresAt),
  };
}

/** Rotate before the next registration? */
export function rotationDue(reply: E2eReply | null, nowSecs: number): boolean {
  return !!reply && reply.rotateAfter != null && reply.rotateAfter <= nowSecs;
}

/** The register-device `e2e` field. */
export function e2eField(k: E2eKey): Record<string, unknown> {
  return { v: 1, suite: E2E_SUITE, publicKey: k.publicKey, psk: k.psk, createdAt: k.createdAt };
}

// ─── Plugin (iOS) ───

export function e2eCapablePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** This server's key (made on first use); null when the plugin can't. */
export async function e2eKey(server: string, subdomain: string, rotate = false): Promise<E2eKey | null> {
  try {
    const r = await invoke<Record<string, unknown>>(`plugin:${PLUGIN}|e2e_op`, {
      op: "key",
      server,
      subdomain,
      rotate,
    });
    if (r?.available !== true) return null;
    const s = (v: unknown) => (typeof v === "string" && v ? v : null);
    const deviceId = s(r.deviceId);
    const publicKey = s(r.publicKey);
    const psk = s(r.psk);
    const keyId = s(r.keyId);
    const createdAt = typeof r.createdAt === "number" ? r.createdAt : null;
    if (!deviceId || !publicKey || !psk || !keyId || createdAt == null) return null;
    return { deviceId, publicKey, psk, keyId, createdAt };
  } catch {
    return null;
  }
}

export async function e2eForget(server: string): Promise<void> {
  try {
    await invoke(`plugin:${PLUGIN}|e2e_op`, { op: "forget", server });
  } catch {
    /* not iOS, or nothing to forget */
  }
}

export async function e2eSetEnforce(subdomain: string, on: boolean): Promise<void> {
  try {
    await invoke(`plugin:${PLUGIN}|e2e_op`, { op: "enforce", subdomain, on });
  } catch {
    /* best effort */
  }
}

export type E2eDiagnostics = {
  available: boolean;
  keys: { server: string; subdomain: string; keyId: string; createdAt: number; retireAt?: number; enclave: boolean }[];
  pushes: Record<string, unknown>[];
};

export async function e2eDiagnostics(): Promise<E2eDiagnostics> {
  try {
    const r = await invoke<E2eDiagnostics>(`plugin:${PLUGIN}|e2e_op`, { op: "diagnostics" });
    return { available: r?.available === true, keys: r?.keys ?? [], pushes: r?.pushes ?? [] };
  } catch {
    return { available: false, keys: [], pushes: [] };
  }
}

// ─── Per-server bookkeeping (push.json) ───
//
// `e2eDevices[serverId]` = the per-server deviceId last registered there
// (unregister and read-back use it); `e2eMigrated[serverId]` = the
// install-wide id was unregistered there; `e2eRotate[serverId]` = the
// last reply said rotate.

type Book = {
  devices: Record<string, string>;
  migrated: Record<string, true>;
  rotate: Record<string, true>;
};

async function store() {
  return load(STORE_FILE, { defaults: {} });
}

export async function readBook(): Promise<Book> {
  try {
    const s = await store();
    return {
      devices: (await s.get<Record<string, string>>("e2eDevices")) ?? {},
      migrated: (await s.get<Record<string, true>>("e2eMigrated")) ?? {},
      rotate: (await s.get<Record<string, true>>("e2eRotate")) ?? {},
    };
  } catch {
    return { devices: {}, migrated: {}, rotate: {} };
  }
}

export async function writeBook(update: (b: Book) => void): Promise<void> {
  try {
    const s = await store();
    const b = await readBook();
    update(b);
    await s.set("e2eDevices", b.devices);
    await s.set("e2eMigrated", b.migrated);
    await s.set("e2eRotate", b.rotate);
    await s.save();
  } catch {
    /* best effort */
  }
}
