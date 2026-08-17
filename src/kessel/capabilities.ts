// GET /companion/capabilities — probe for the k1 grid upgrade.
//
// Answered in the companion listener (not /cli/mode). `{gridProto:["k1"]}`
// only when `/companion/sessions/grid` is actually registered. A 404 /
// parse miss / missing key means the old daemon: stay on TerminalView.

export interface CompanionCapabilities {
  gridProto?: string[];
}

/** True only when the daemon advertises the live k1 grid route. */
export function supportsK1Grid(caps: unknown): boolean {
  if (!caps || typeof caps !== "object") return false;
  const proto = (caps as CompanionCapabilities).gridProto;
  return Array.isArray(proto) && proto.includes("k1");
}
