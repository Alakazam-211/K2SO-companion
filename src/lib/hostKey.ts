// Host keys — the one spelling of "which server" (multi-server PRD MS1,
// amended by MA1). A port of desktop K2 `src/renderer/lib/host-key.ts`
// (`homeHostKey` + `canonicalHostKey`), minus `local`: the phone has no
// daemon of its own, so `local` is just a hostname here.
//
// Canonical form:
//   - https on 443: the bare lowercase hostname (`dtl.k2.dev`);
//   - anything else carries its port, plain http on 80 included
//     (`box.lan:80`, `192.168.1.20:38471`), so `http://x` and `https://x`
//     never share a key on default ports;
//   - a non-default port gives the SAME key for http and https
//     (`https://x:8443` and `http://x:8443` are both `x:8443`);
//   - an IPv6 literal is always `[addr]:port`, even on 443;
//   - no scheme means https only when there is no port or the port is 443;
//     any other port means http.
//
// What it is for (MA2): dedupe of saved servers, row addresses
// (`handle::hostKey`) and display. Storage and cache keys stay on the
// stable `ServerEntry.id` (`<serverId>|…`), which survives an address edit.
//
// Pure: no app imports, so the store and the request layer can both use it.

export interface HostParts {
  hostname: string;
  port: number;
  secure: boolean;
}

function stripBrackets(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

function isIpv6(hostname: string): boolean {
  return hostname.includes(":");
}

/** Host key for parsed parts (desktop `homeHostKey`). */
export function homeHostKey(h: HostParts): string {
  const hostname = stripBrackets(h.hostname);
  if (isIpv6(hostname)) return `[${hostname}]:${h.port}`;
  if (h.secure && h.port === 443) return hostname;
  return `${hostname}:${h.port}`;
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV6_RE = /^[0-9a-f:.]+$/;

function notAHostKey(input: string): Error {
  return new Error(`not a host key: ${JSON.stringify(input)}`);
}

function parsePort(raw: string, input: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw notAHostKey(input);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw notAHostKey(input);
  return port;
}

/** Parse any spelling of a server address into its canonical host key.
 *  Throws on anything that is not a hostname or an IPv4/IPv6 literal,
 *  optionally with a scheme, a port and ONE trailing `/` (a path, `@`,
 *  `?`, `#`, a bad port or a trailing dot all throw). */
export function canonicalHostKey(input: string): string {
  let s = input.trim().toLowerCase();
  let secure: boolean | null = null;
  const scheme = /^(https|wss|http|ws):\/\//.exec(s);
  if (scheme) {
    secure = scheme[1] === "https" || scheme[1] === "wss";
    s = s.slice(scheme[0].length);
  }
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (s.length === 0 || s.includes("/") || s.includes("@") || s.includes("?") || s.includes("#")) {
    throw notAHostKey(input);
  }
  let hostname: string;
  let port: number | null = null;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) throw notAHostKey(input);
    hostname = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) throw notAHostKey(input);
      port = parsePort(rest.slice(1), input);
    }
    if (!IPV6_RE.test(hostname) || !hostname.includes(":")) throw notAHostKey(input);
  } else {
    const colon = s.lastIndexOf(":");
    if (colon >= 0) {
      if (s.indexOf(":") !== colon) {
        // Unbracketed IPv6 literal — only valid without a port.
        if (!IPV6_RE.test(s)) throw notAHostKey(input);
        hostname = s;
      } else {
        hostname = s.slice(0, colon);
        port = parsePort(s.slice(colon + 1), input);
      }
    } else {
      hostname = s;
    }
    if (!isIpv6(hostname) && !HOSTNAME_RE.test(hostname)) throw notAHostKey(input);
  }
  // No scheme: a missing port or 443 means the default https server.
  const isSecure = secure === null ? port === null || port === 443 : secure;
  const effectivePort = port === null ? (isSecure ? 443 : 80) : port;
  return homeHostKey({ hostname, port: effectivePort, secure: isSecure });
}

/** `canonicalHostKey`, or null for input that is not a server address. */
export function tryHostKey(input: string): string | null {
  try {
    return canonicalHostKey(input);
  } catch {
    return null;
  }
}
