// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  PASSWORDS_STORE_KEY,
  purgeStoredPasswords,
  resolvePassword,
  setRememberedPassword,
  useServersStore,
} from "./servers";

const LS_PASSWORDS = `k2_servers.${PASSWORDS_STORE_KEY}`;
const mem = new Map<string, string>();
const ls = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => {
    mem.set(k, String(v));
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
  clear: () => mem.clear(),
};

beforeEach(() => {
  mem.clear();
  Object.defineProperty(globalThis, "localStorage", {
    value: ls,
    configurable: true,
  });
});

describe("OPEN 12 passwords key", () => {
  it("purge deletes the passwords key, not an empty map", async () => {
    const keys = new Set<string>([PASSWORDS_STORE_KEY, "tokens"]);
    await purgeStoredPasswords({
      delete: async (key) => {
        keys.delete(key);
      },
    });
    expect(keys.has(PASSWORDS_STORE_KEY)).toBe(false);
    expect(keys.has("tokens")).toBe(true);
  });

  it("resolvePassword never returns a stored password", async () => {
    expect(await resolvePassword("anything")).toBeNull();
  });

  it("hydrate deletes a leftover passwords key with no servers and no login", async () => {
    localStorage.setItem(LS_PASSWORDS, JSON.stringify({ s1: "should-not-survive" }));
    localStorage.setItem("k2_servers.servers", JSON.stringify([]));
    localStorage.setItem("k2_servers.tokens", JSON.stringify({}));
    localStorage.setItem("k2_servers.activeServerId", JSON.stringify(null));
    await useServersStore.getState().hydrate();
    expect(localStorage.getItem(LS_PASSWORDS)).toBeNull();
    expect(useServersStore.getState().hydrated).toBe(true);
  });

  it("setRememberedPassword never writes a password, and still deletes the key", async () => {
    localStorage.setItem(LS_PASSWORDS, JSON.stringify({ s1: "leftover" }));
    await setRememberedPassword("s1", "new-secret");
    expect(localStorage.getItem(LS_PASSWORDS)).toBeNull();
  });
});
