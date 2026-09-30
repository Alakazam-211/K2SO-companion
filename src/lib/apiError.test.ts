import { describe, expect, it } from "vitest";
import { apiErrorText, asErrorText } from "./apiError";

describe("apiErrorText", () => {
  it("pulls hint out of a structured daemon error, never returns the object", () => {
    const raw = JSON.stringify({
      error: { code: "not_found", hint: "unknown overlay addr 'k2so-Skin-Test-A'" },
      ok: false,
    });
    const s = apiErrorText(raw, "HTTP 404");
    expect(typeof s).toBe("string");
    expect(s).toBe("unknown overlay addr 'k2so-Skin-Test-A'");
  });

  it("uses a string error as-is", () => {
    expect(apiErrorText(JSON.stringify({ error: "nope" }), "HTTP 500")).toBe("nope");
  });
});

describe("asErrorText", () => {
  it("stringifies a leftover error object so JSX cannot receive it", () => {
    expect(
      asErrorText({ code: "not_found", hint: "unknown overlay addr 'appa'" })
    ).toBe("unknown overlay addr 'appa'");
  });
});