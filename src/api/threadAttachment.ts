// `GET /cli/thread/attachment` (K2 0.46.1 `thread-attachments-v1`) on the
// scope it is given: the server that owns the Thread. A remote server's
// Thread opens through that server with the login held there; attachments
// never cross servers. Parsing and error mapping: `threadAttachmentPure.ts`.

import { decodeBase64 } from "../zen/files/fileBytes";
import { NOT_CONNECTED, scopedFetch } from "./scopedFetch";
import type { ServerScope } from "./scope";
import {
  RANGE_CHUNK_BYTES,
  attachmentQuery,
  mapAttachmentError,
  parseAttachmentMeta,
  parseAttachmentPreview,
  parseAttachmentRange,
  parseAttachmentThumb,
  type AttachmentMeta,
  type AttachmentPreview,
  type AttachmentRange,
  type AttachmentRef,
  type AttachmentResult,
  type AttachmentThumb,
  type ThumbPx,
} from "./threadAttachmentPure";

const PATH = "/cli/thread/attachment";

async function get<T>(
  scope: ServerScope,
  query: Record<string, string> | null,
  parse: (body: unknown) => AttachmentResult<T>,
  timeoutMs: number
): Promise<AttachmentResult<T>> {
  if (!query) return { ok: false, error: { code: "usage", status: null, hint: "no Thread or message id" } };
  try {
    const out = await scopedFetch(scope, PATH, { query, timeoutMs });
    if (!out.ok) return { ok: false, error: mapAttachmentError(out.status, out.text) };
    let body: unknown;
    try {
      body = JSON.parse(out.text);
    } catch {
      return { ok: false, error: { code: "bad_response", status: out.status, hint: "not JSON" } };
    }
    return parse(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === NOT_CONNECTED) return { ok: false, error: { code: "not_connected", status: null, hint: msg } };
    return { ok: false, error: { code: "network", status: null, hint: msg } };
  }
}

/** `mode=meta`: a fresh stat (`size` now, `state` re-checked). */
export function getAttachmentMeta(
  scope: ServerScope,
  ref: AttachmentRef,
  n: number
): Promise<AttachmentResult<AttachmentMeta>> {
  return get(scope, attachmentQuery(ref, n, "meta"), parseAttachmentMeta, 15_000);
}

/** `mode=preview`: text (first 512 KB), or an image / PDF up to 20 MB.
 *  415 `no_preview` / 413 `preview_too_large` mean: download with range. */
export function getAttachmentPreview(
  scope: ServerScope,
  ref: AttachmentRef,
  n: number
): Promise<AttachmentResult<AttachmentPreview>> {
  return get(scope, attachmentQuery(ref, n, "preview"), parseAttachmentPreview, 60_000);
}

/** `mode=thumb&px=256|512` (K2 0.46.3 `thread-images-v1`): the live
 *  file's thumbnail. 415 `no_thumbnail` / 413 `preview_too_large` →
 *  `no_preview` / `preview_too_large`: show the chip. */
export function getAttachmentThumb(
  scope: ServerScope,
  ref: AttachmentRef,
  n: number,
  px: ThumbPx
): Promise<AttachmentResult<AttachmentThumb>> {
  return get(scope, attachmentQuery(ref, n, "thumb", undefined, px), parseAttachmentThumb, 30_000);
}

/** `mode=range`: one slice (`len` 1..16 MB). */
export function getAttachmentRange(
  scope: ServerScope,
  ref: AttachmentRef,
  n: number,
  offset: number,
  len = RANGE_CHUNK_BYTES
): Promise<AttachmentResult<AttachmentRange>> {
  return get(scope, attachmentQuery(ref, n, "range", { offset, len }), parseAttachmentRange, 60_000);
}

/** Restarts allowed when the file's size moves under a download. */
const MAX_RESTARTS = 2;

/** The whole file through `mode=range`: 4 MB chunks, resumed by offset,
 *  stopped at `eof`; a `size` change between chunks means the file changed
 *  under us, so start again from 0 (twice at most). */
export async function downloadAttachment(
  scope: ServerScope,
  ref: AttachmentRef,
  n: number,
  opts: {
    chunkBytes?: number;
    isCancelled?: () => boolean;
    onProgress?: (done: number, size: number) => void;
  } = {}
): Promise<AttachmentResult<{ bytes: Uint8Array; size: number }>> {
  const chunk = opts.chunkBytes ?? RANGE_CHUNK_BYTES;
  let restarts = 0;
  restart: for (;;) {
    const parts: Uint8Array[] = [];
    let offset = 0;
    let size: number | null = null;
    for (;;) {
      if (opts.isCancelled?.()) {
        return { ok: false, error: { code: "network", status: null, hint: "cancelled" } };
      }
      const r = await getAttachmentRange(scope, ref, n, offset, chunk);
      if (!r.ok) return r;
      const s: AttachmentRange = r.data;
      if (size != null && s.size !== size) {
        restarts += 1;
        if (restarts > MAX_RESTARTS) {
          return { ok: false, error: { code: "changed_during_download", status: null, hint: "size changed" } };
        }
        continue restart;
      }
      size = s.size;
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(s.base64);
      } catch {
        return { ok: false, error: { code: "bad_response", status: null, hint: "range: bad base64" } };
      }
      if (bytes.length) {
        parts.push(bytes);
        offset += bytes.length;
      }
      opts.onProgress?.(offset, size);
      // An empty slice that is not EOF would loop forever.
      if (s.eof || bytes.length === 0 || offset >= size) break;
    }
    const out = new Uint8Array(offset);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return { ok: true, data: { bytes: out, size: size ?? offset } };
  }
}
