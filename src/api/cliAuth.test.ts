import { describe, expect, it } from "vitest";
import { cliAuthHeaders } from "./cliAuth";

describe("cliAuthHeaders", () => {
  it("puts the token on Authorization Bearer", () => {
    expect(cliAuthHeaders("sekrit").Authorization).toBe("Bearer sekrit");
  });

  it("does not produce a query-string token shape", () => {
    expect(JSON.stringify(cliAuthHeaders("sekrit"))).not.toMatch(/token=/);
  });

  it("omits Authorization when the token is empty", () => {
    expect(cliAuthHeaders("")).not.toHaveProperty("Authorization");
  });
});
