/** Temporary send allow-list for the QA authorship/tunnel build.
 *  There is no delete door. Only these overlay addrs may be posted to. */
export const SEND_TEST_ADDRS = ["skin-test-a", "k2so-companion-qa"] as const;

export const SEND_TEST_REFUSED =
  "Cannot send — this build only posts to skin-test-a or k2so-companion-qa";

export function isSendTestAddr(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return (SEND_TEST_ADDRS as readonly string[]).includes(addr);
}
