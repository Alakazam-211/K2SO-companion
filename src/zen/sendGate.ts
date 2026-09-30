/** Live overlay addrs are sendable. Empty addr and stub are not.
 *  There is no per-room allow-list. */
export function isSendableAddr(addr: string | null | undefined): addr is string {
  return typeof addr === "string" && addr.trim().length > 0;
}
