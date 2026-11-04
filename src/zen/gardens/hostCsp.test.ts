import { describe, expect, it } from "vitest";

import conf from "../../../src-tauri/tauri.conf.json";

// K2's security review (2026-11-03): without this a sealed frame can navigate
// itself, to the app's own origin under `default-src 'self'` and to anywhere
// with no policy, carrying a value in the query. Srcdoc frames still run.
describe("the app's CSP", () => {
  it("lets no frame navigate", () => {
    expect(conf.app.security.csp).toMatch(/(^|; )frame-src 'none'(;|$)/);
  });
});
