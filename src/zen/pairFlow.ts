// The phone's pairing steps (K2 0.46.4 `companion-pairing-v1`; requests in
// `api/pairing.ts`, the store commit in `stores/servers.ts`):
//
//   pair    a code (typed, scanned or from a link) → POST pair → commit
//   switch  a password session → pair-code {password} → pair → commit,
//           which logs the old session out after its push unregister

import { requestPairCode, pairDevice, phoneName } from "../api/pairing";
import { scopeFor } from "../api/scope";
import { getDeviceId } from "../lib/push";
import { commitPairedSession, useServersStore } from "../stores/servers";

/** This install's device for the pairing body: the push deviceId (stable
 *  per install; re-pairing the same install ends its earlier session). */
async function thisDevice(): Promise<{ id: string; name: string }> {
  let id = "";
  try {
    id = await getDeviceId();
  } catch {
    id = globalThis.crypto?.randomUUID?.() ?? `d-${Date.now().toString(36)}`;
  }
  return { id, name: phoneName() };
}

export type PairOutcome = { ok: true; id: string; username: string } | { ok: false; error: string };

/** Pair with `serverUrl` using `code` and save it. `replaceId`: the saved
 *  server this takes over (the user confirmed it). */
export async function pairServer(input: {
  serverUrl: string;
  code: string;
  nickname?: string;
  replaceId?: string | null;
  activate?: boolean;
}): Promise<PairOutcome> {
  const r = await pairDevice(input.serverUrl, input.code, await thisDevice());
  if (!r.ok) return { ok: false, error: r.error };
  const saved = await commitPairedSession({
    replaceId: input.replaceId ?? null,
    url: input.serverUrl,
    nickname: input.nickname ?? "",
    username: r.username,
    token: r.token,
    activate: input.activate,
  });
  return saved.ok ? { ok: true, id: saved.id, username: r.username } : saved;
}

/** Move a password-signed-in server onto pairing: the password once (never
 *  stored), a code for this login, then the pairing over the same entry. */
export async function switchToPairing(
  serverId: string,
  password: string
): Promise<PairOutcome & { wrongPassword?: boolean }> {
  const server = useServersStore.getState().servers.find((s) => s.id === serverId);
  if (!server) return { ok: false, error: "That server was removed from this phone." };
  const code = await requestPairCode(scopeFor(serverId), password);
  if (!code.ok) return { ok: false, error: code.error, wrongPassword: code.kind === "password" };
  return pairServer({ serverUrl: server.url, code: code.code, replaceId: serverId, activate: false });
}
