// GET /companion/capabilities — probe for the k1 companion-tunnel upgrade.
//
// `{gridProto:["k1"]}` only when `/companion/sessions/grid` is registered
// on this origin. A 404 / parse miss means this origin is a Connect
// daemon — dial `/cli/sessions/grid` Watch. Do not treat miss as
// "old tunnel + claim-on-open".

export interface CompanionCapabilities {
  gridProto?: string[];
}

/** True only when the daemon advertises the live k1 grid route. */
export function supportsK1Grid(caps: unknown): boolean {
  if (!caps || typeof caps !== "object") return false;
  const proto = (caps as CompanionCapabilities).gridProto;
  return Array.isArray(proto) && proto.includes("k1");
}
