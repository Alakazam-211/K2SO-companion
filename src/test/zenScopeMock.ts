// MA21: a controllable stand-in for `zen/zenScope.ts`. A test mocks the
// module with this and steers the "room server" through `zen()` /
// `setZenScope()` instead of mocking `getToken` / `getActiveServer`:
//
//   vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
//   beforeEach(() => setZenScope(fakeScope()));
//   zen().setToken("");   // signed out

import { fakeScope, type FakeScope } from "./fakeScope";

let current: FakeScope = fakeScope();

export function setZenScope(scope: FakeScope): FakeScope {
  current = scope;
  return scope;
}

/** The scope the mocked `zenScope()` hands out right now. */
export function zen(): FakeScope {
  return current;
}

export const zenScopeModule = {
  zenServerId: () => current.id || null,
  zenScope: () => current,
  useZenScope: () => current,
  ticketsScope: () => current,
  useTicketsScope: () => current,
};
