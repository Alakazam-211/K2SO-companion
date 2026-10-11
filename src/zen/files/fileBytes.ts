// File bytes for the viewer: desktop `lib/load-host-binary.ts`, phone
// side. Always through the daemon (`fs/read-binary`, then `fs/read-range`
// for big media); playback and paint stay on the phone via Blob URLs.

import { getFsReadBinary, getFsReadRange } from "../../api/client";

/** Daemon `MAX_BINARY_SIZE`: one `read-binary` answer at most. */
export const READ_BINARY_MAX_BYTES = 50 * 1024 * 1024;
/** Ranged assembly chunk, under the daemon's 16MB slice cap. */
const RANGE_CHUNK_BYTES = 8 * 1024 * 1024;
/** Media assembled in RAM stops here: a phone tab dies well before 1GB. */
export const MEDIA_MAX_BYTES = 150 * 1024 * 1024;

export function decodeBase64(base64: unknown): Uint8Array {
  if (typeof base64 !== "string") {
    throw new Error("fs/read-binary returned no base64 payload");
  }
  const binary = atob(base64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function tooLarge(message: string): boolean {
  return /too large|50mb/i.test(message);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Whole file via `read-binary`. `ranged` falls back to `read-range`
 *  slices when the daemon refuses the size (audio/video only). */
export async function loadFileBytes(
  path: string,
  opts: { ranged?: boolean; isCancelled?: () => boolean; onProgress?: (r: number) => void } = {}
): Promise<Uint8Array> {
  const r = await getFsReadBinary(path);
  if (r.ok) return decodeBase64(r.data?.base64);
  const msg = r.error || "read-binary failed";
  if (!opts.ranged || !tooLarge(msg)) throw new Error(msg);

  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    if (opts.isCancelled?.()) throw new Error("cancelled");
    const s = await getFsReadRange(path, offset, RANGE_CHUNK_BYTES);
    if (!s.ok || !s.data) throw new Error(s.error || "read-range failed");
    if (s.data.size > MEDIA_MAX_BYTES) {
      throw new Error(
        `File is ${formatBytes(s.data.size)}, too large to play here (limit ${formatBytes(MEDIA_MAX_BYTES)}).`
      );
    }
    if (s.data.len > 0) {
      chunks.push(decodeBase64(s.data.base64));
      offset += s.data.len;
    }
    if (s.data.size > 0) opts.onProgress?.(Math.min(offset / s.data.size, 1));
    // An empty slice that is not EOF would loop forever.
    if (s.data.eof || s.data.len === 0) break;
  }
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** Blob URL for <img>/<audio>/<video>. Caller revokes. */
export function bytesToObjectUrl(bytes: Uint8Array, mime: string): string {
  // Copy the view: a subarray's `.buffer` carries unrelated bytes.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy], { type: mime || "application/octet-stream" }));
}

/** Image MIME from magic bytes. Misnamed files and PNG-in-ICO paint more
 *  reliably in WKWebView when the Blob type matches the payload. */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return "image/x-icon";
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(0, Math.min(256, b.length)))
    .trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}

/** First (largest) PNG inside an ICO. Most modern favicons embed one. */
function pngFromIco(b: Uint8Array): Uint8Array | null {
  if (b.length < 6) return null;
  const count = b[4] | (b[5] << 8);
  if (count === 0 || count > 64) return null;
  let best: Uint8Array | null = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > b.length) break;
    const size = b[e + 8] | (b[e + 9] << 8) | (b[e + 10] << 16) | (b[e + 11] << 24);
    const off = b[e + 12] | (b[e + 13] << 8) | (b[e + 14] << 16) | (b[e + 15] << 24);
    if (size <= 0 || off < 0 || off + size > b.length) continue;
    const s = b.subarray(off, off + size);
    if (s[0] === 0x89 && s[1] === 0x50 && s[2] === 0x4e && s[3] === 0x47) {
      if (!best || s.length > best.length) best = s;
    }
  }
  return best;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Bytes + MIME to paint: sniffed type first, extension as a fallback. */
export function imagePayload(raw: Uint8Array, path: string): { bytes: Uint8Array; mime: string } {
  const sniffed = sniffImageMime(raw);
  if (sniffed === "image/x-icon" || sniffed === null) {
    const png = pngFromIco(raw);
    if (png) return { bytes: png, mime: "image/png" };
  }
  if (sniffed) return { bytes: raw, mime: sniffed };
  const ext = (path.split(".").pop() || "").toLowerCase();
  return { bytes: raw, mime: IMAGE_MIME_BY_EXT[ext] ?? "application/octet-stream" };
}
