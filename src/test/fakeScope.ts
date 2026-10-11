// MA21: the test double for a `ServerScope`. Tests that used to mock the
// globals (`getBaseUrl` / `getToken`) build one of these and hand it to the
// code under test (or return it from a mocked `zenScope()`), then flip its
// token / base to simulate a sign-out or a dead server.

import type { DaemonFeature, ServerScope } from "../api/scope";

export interface FakeScope extends ServerScope {
  setId(id: string): void;
  setToken(token: string): void;
  setBase(base: string): void;
  setUsername(username: string): void;
  setVersion(version: string | null): void;
  setFeatures(features: DaemonFeature[] | null): void;
  /** Make every creds call throw, like a removed server. */
  remove(): void;
}

export function fakeScope(
  over: {
    id?: string;
    base?: string;
    token?: string;
    username?: string;
    hostKey?: string;
    label?: string;
    version?: string | null;
    features?: DaemonFeature[] | null;
  } = {}
): FakeScope {
  let base = over.base ?? "https://s1.k2.dev";
  let token = over.token ?? "tok";
  let username = over.username ?? "u";
  let version = over.version ?? null;
  let features: Set<string> | null = over.features ? new Set(over.features) : null;
  let removed = false;
  let id = over.id ?? "s1";
  const check = () => {
    if (removed) {
      const err = new Error(`${over.label ?? id} was removed from this phone`);
      err.name = "ServerRemovedError";
      throw err;
    }
  };
  return {
    get id() {
      return id;
    },
    hostKey: over.hostKey ?? base.replace(/^https?:\/\//, ""),
    label: over.label ?? id,
    httpBase: () => (check(), base),
    wsBase: () => (check(), base.replace(/^http/, "ws")),
    token: () => (check(), token),
    username: () => username,
    supports: (f) => features?.has(f) ?? false,
    version: () => version,
    setId: (next) => void (id = next),
    setToken: (t) => void (token = t),
    setBase: (b) => void (base = b),
    setUsername: (u) => void (username = u),
    setVersion: (v) => void (version = v),
    setFeatures: (f) => void (features = f ? new Set(f) : null),
    remove: () => void (removed = true),
  };
}
