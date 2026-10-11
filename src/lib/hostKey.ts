// Host keys: the one spelling of "which server" in a Home row address
// (`handle::host`). A port of desktop `K2/src/renderer/lib/host-key.ts`
// (Home M1, MS8 + MS60), so phone rows match what desktop and the
// multi-server branch write:
//   - `https` on 443: the bare lowercase hostname (`dtl.k2.dev`);
//   - anything else carries its port, plain `http` on 80 included
//     (`192.168.1.20:38471`, `box.lan:80`);
//   - an IPv6 literal is always `[addr]:port`.
// The phone never runs a daemon, so `local` only round-trips.

export const LOCAL_HOME_HOST = "local";

export type HostParts = { hostname: string; port: number; secure: boolean };

function stripBrackets(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** Host key for a parsed server address. */
export function homeHostKey(h: "local" | HostParts): string {
  if (h === "local") return LOCAL_HOME_HOST;
  const hostname = stripBrackets(h.hostname);
  if (hostname.includes(":")) return `[${hostname}]:${h.port}`;
  if (h.secure && h.port === 443) return hostname;
  return `${hostname}:${h.port}`;
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV6_RE = /^[0-9a-f:.]+$/;

function bad(input: string): Error {
  return new Error(`not a host key: ${JSON.stringify(input)}`);
}

function parsePort(raw: string, input: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw bad(input);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw bad(input);
  return port;
}

/** Parse any spelling of a server address (`https://DTL.k2.dev/`,
 *  `dtl.k2.dev:443`, `dtl.k2.dev`) into its canonical host key. Throws on
 *  anything that is not `local`, a hostname or an IP literal, optionally
 *  with a scheme, a port and a trailing `/`. */
export function canonicalHostKey(input: string): string {
  let s = input.trim().toLowerCase();
  if (s === LOCAL_HOME_HOST) return LOCAL_HOME_HOST;
  let secure: boolean | null = null;
  const scheme = /^(https|wss|http|ws):\/\//.exec(s);
  if (scheme) {
    secure = scheme[1] === "https" || scheme[1] === "wss";
    s = s.slice(scheme[0].length);
  }
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (!s || /[/@?#]/.test(s)) throw bad(input);
  let hostname: string;
  let port: number | null = null;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) throw bad(input);
    hostname = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) throw bad(input);
      port = parsePort(rest.slice(1), input);
    }
    if (!IPV6_RE.test(hostname) || !hostname.includes(":")) throw bad(input);
  } else {
    const colon = s.lastIndexOf(":");
    if (colon >= 0) {
      if (s.indexOf(":") !== colon) {
        if (!IPV6_RE.test(s)) throw bad(input);
        hostname = s;
      } else {
        hostname = s.slice(0, colon);
        port = parsePort(s.slice(colon + 1), input);
      }
    } else {
      hostname = s;
    }
    if (!hostname.includes(":") && !HOSTNAME_RE.test(hostname)) throw bad(input);
  }
  const isSecure = secure === null ? port === null || port === 443 : secure;
  const effectivePort = port === null ? (isSecure ? 443 : 80) : port;
  return homeHostKey({ hostname, port: effectivePort, secure: isSecure });
}

/** A saved server's host key from its origin (`ServerEntry.url`). Null
 *  when the url does not parse (never throws). */
export function serverHostKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return canonicalHostKey(url);
  } catch {
    return null;
  }
}
