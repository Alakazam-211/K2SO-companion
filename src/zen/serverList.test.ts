import { describe, expect, it } from "vitest";
import { filterServers, sortServersActiveFirst } from "./serverList";

type S = { id: string; label: string; user?: string };
const label = (s: S) => s.label;
const ids = (xs: S[]) => xs.map((x) => x.id);

describe("sortServersActiveFirst", () => {
  const servers: S[] = [
    { id: "a", label: "zeta" },
    { id: "b", label: "Alpha" },
    { id: "c", label: "beta" },
    { id: "d", label: "Gamma" },
  ];

  it("puts the active server first, then the rest alphabetically", () => {
    expect(ids(sortServersActiveFirst(servers, "d", label))).toEqual(["d", "b", "c", "a"]);
  });

  it("sorts case-insensitively", () => {
    const xs: S[] = [
      { id: "1", label: "bravo" },
      { id: "2", label: "Alpha" },
      { id: "3", label: "alpha2" },
      { id: "4", label: "Charlie" },
    ];
    expect(ids(sortServersActiveFirst(xs, null, label))).toEqual(["2", "3", "1", "4"]);
  });

  it("keeps input order for labels equal ignoring case", () => {
    const xs: S[] = [
      { id: "x", label: "home" },
      { id: "y", label: "HOME" },
    ];
    expect(ids(sortServersActiveFirst(xs, null, label))).toEqual(["x", "y"]);
  });

  it("is alphabetical when the active id is missing or unknown", () => {
    expect(ids(sortServersActiveFirst(servers, "nope", label))).toEqual(["b", "c", "d", "a"]);
    expect(ids(sortServersActiveFirst(servers, undefined, label))).toEqual(["b", "c", "d", "a"]);
  });

  it("does not mutate the input", () => {
    const copy = [...servers];
    sortServersActiveFirst(servers, "a", label);
    expect(servers).toEqual(copy);
  });
});

describe("filterServers", () => {
  const servers: S[] = [
    { id: "1", label: "Home", user: "baden" },
    { id: "2", label: "Work", user: "rosson" },
  ];
  const fields = (s: S) => [s.label, s.user];

  it("keeps everything for a blank query", () => {
    expect(ids(filterServers(servers, "  ", fields))).toEqual(["1", "2"]);
  });

  it("matches any field case-insensitively", () => {
    expect(ids(filterServers(servers, "hOm", fields))).toEqual(["1"]);
    expect(ids(filterServers(servers, "ROSS", fields))).toEqual(["2"]);
    expect(ids(filterServers(servers, "zzz", fields))).toEqual([]);
  });
});
