// thread-attachments-v1 (K2 0.46.1): files riding a Thread message, and
// the read route that opens them. Pure (no React, no fetch) so it tests on
// its own; `threadAttachment.ts` moves the bytes.
//
//   doc.attachments[] = {kind, state, path, name, size, mime, modifiedAt,
//                        sha256, line?, lineEnd?}   (at most 10; `hidden`
//                        carries only {kind, state})
//   GET /cli/thread/attachment?addr|conversationId&id&n&mode=meta|preview|range
//
// A message never carries the server's absolute path: `path` is
// workspace-relative and only ever goes back to the server that owns the
// Thread. Gate every surface on `/boot-status` `thread-attachments-v1`.

export const FEATURE_THREAD_ATTACHMENTS = "thread-attachments-v1" as const;
/** K2 0.46.3: `mode=thumb` image thumbnails, drawn inline in the Thread. */
export const FEATURE_THREAD_IMAGES = "thread-images-v1" as const;
/** Thumb sizes the server makes (`px`). */
export type ThumbPx = 256 | 512;

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg|tiff?|avif)$/i;

/** An image the Thread can draw as a thumbnail: by MIME, else by name. */
export function isImageAttachment(a: Pick<ThreadAttachment, "kind" | "mime" | "name" | "path">): boolean {
  if (a.kind !== "file") return false;
  if (a.mime) return a.mime.startsWith("image/");
  return IMAGE_EXT.test(a.name || a.path);
}

/** Server cap per message; anything past it is ignored. */
export const MAX_ATTACHMENTS = 10;
/** `mode=range` chunk the phone asks for (the server allows up to 16 MB). */
export const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
/** Above this, a download asks first (contract: "above 25 MB on cellular";
 *  the phone has no network-type signal, so it always asks). */
export const LARGE_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** A list card shows at most this many rows (expanded). */
export const LIST_CARD_MAX_ROWS = 5;
/** Three or more files on a message: a compact list card. */
export const LIST_CARD_MIN_FILES = 3;

export type ThreadAttachmentState = "ok" | "changed" | "gone" | "hidden";

export type ThreadAttachment = {
  /** Index into the message's wire `attachments` array (the route's `n`). */
  n: number;
  /** `"file"` today; anything else is a plain card that never opens. */
  kind: string;
  state: ThreadAttachmentState;
  /** Workspace-relative, `/` separators. Empty for `hidden`. */
  path: string;
  /** Snapshot at send time. Empty for `hidden`. */
  name: string;
  size: number | null;
  mime: string;
  modifiedAt: number | null;
  sha256: string | null;
  line: number | null;
  lineEnd: number | null;
  /** The wire entry carried no (known) `state`: `state` is a guess, and a
   *  delta must not let it overwrite a state the phone already knows
   *  (`keepKnownAttachmentStates`). Absent when the server sent one. */
  stateMissing?: true;
};

const STATES = new Set<ThreadAttachmentState>(["ok", "changed", "gone", "hidden"]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function posInt(v: unknown): number | null {
  const n = num(v);
  return n != null && n >= 1 && Number.isInteger(n) ? n : null;
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

/** One wire entry, or null when it is not an object. */
function parseOne(raw: unknown, n: number): ThreadAttachment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = str(o.kind) || "file";
  const stateRaw = str(o.state).toLowerCase();
  const path = str(o.path);
  const nameRaw = str(o.name);
  // An unknown state: a file with a path is still worth a try (the route
  // re-checks it); without one there is nothing to show but a placeholder.
  const state: ThreadAttachmentState = STATES.has(stateRaw as ThreadAttachmentState)
    ? (stateRaw as ThreadAttachmentState)
    : path || nameRaw
      ? "ok"
      : "hidden";
  if (state === "hidden") {
    // Only {kind, state}: never show anything else the server let slip.
    return {
      n,
      kind,
      state,
      path: "",
      name: "",
      size: null,
      mime: "",
      modifiedAt: null,
      sha256: null,
      line: null,
      lineEnd: null,
    };
  }
  const size = num(o.size);
  const line = posInt(o.line);
  const lineEndRaw = posInt(o.lineEnd);
  const missing = !STATES.has(stateRaw as ThreadAttachmentState);
  return {
    ...(missing ? { stateMissing: true as const } : null),
    n,
    kind,
    state,
    path,
    name: nameRaw || baseName(path) || "File",
    size: size != null && size >= 0 ? size : null,
    mime: str(o.mime).toLowerCase(),
    modifiedAt: num(o.modifiedAt),
    sha256: str(o.sha256) || null,
    line,
    lineEnd: line != null && lineEndRaw != null && lineEndRaw >= line ? lineEndRaw : null,
  };
}

/** `doc.attachments`, defensively: not an array → none; non-object entries
 *  are skipped but keep their index (`n`); at most 10. */
export function parseThreadAttachments(raw: unknown): ThreadAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ThreadAttachment[] = [];
  for (let i = 0; i < raw.length && i < MAX_ATTACHMENTS; i++) {
    const a = parseOne(raw[i], i);
    if (a) out.push(a);
  }
  return out;
}

/** Does this chip open on tap? Files only, and only while they are there. */
export function attachmentOpenable(a: ThreadAttachment): boolean {
  return a.kind === "file" && (a.state === "ok" || a.state === "changed") && Boolean(a.path || a.name);
}

/** A stable key for "did anything a chip shows change". */
export function attachmentsKey(list: readonly ThreadAttachment[] | undefined): string {
  if (!list?.length) return "";
  return list.map((a) => `${a.n}:${a.kind}:${a.state}:${a.path}:${a.size ?? ""}`).join("|");
}

/** The list-row / push word for a files-only message: `[file]`, `[3 files]`.
 *  Names never appear in a preview. Empty for 0. */
export function attachmentCountLabel(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  const n = Math.floor(count);
  return n === 1 ? "[file]" : `[${n} files]`;
}

/** Bytes as the chip says them (B / KB / MB / GB). */
export function formatAttachmentSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** One message's chips with the state of `n` replaced (a tap's fresh
 *  `mode=meta`). Same array when nothing changes. */
export function withAttachmentState(
  list: readonly ThreadAttachment[],
  n: number,
  state: ThreadAttachmentState
): readonly ThreadAttachment[] {
  const i = list.findIndex((a) => a.n === n);
  if (i < 0 || list[i].state === "hidden") return list;
  if (list[i].state === state && !list[i].stateMissing) return list;
  const next = [...list];
  const { stateMissing: _guess, ...known } = list[i];
  next[i] = { ...known, state };
  return next;
}

/**
 * A message's chips as a delta re-delivered them (`next`), over the copy
 * the phone held (`prev`): an entry that came without a `state` keeps the
 * state already known for the same file (same `n` and path) instead of
 * reading as "ok". K2 0.46.1 sends `state` in delta items; this is
 * defensive. Same array when nothing is filled in.
 */
export function keepKnownAttachmentStates(
  prev: readonly ThreadAttachment[] | undefined,
  next: readonly ThreadAttachment[] | undefined
): readonly ThreadAttachment[] | undefined {
  if (!prev?.length || !next?.length || !next.some((a) => a.stateMissing)) return next;
  let out: ThreadAttachment[] | null = null;
  next.forEach((a, i) => {
    if (!a.stateMissing || !a.path) return;
    const old = prev.find((p) => p.n === a.n && p.path === a.path && !p.stateMissing);
    if (!old || old.state === "hidden" || old.state === a.state) return;
    out ??= [...next];
    out[i] = { ...a, state: old.state };
  });
  return out ?? next;
}

// ─── The read route ───

export type AttachmentRef = {
  /** The Thread, exactly as for `GET /cli/thread`: addr wins. */
  addr?: string | null;
  conversationId?: string | null;
  /** The message's doc id. */
  id: string;
};

/** Query for `GET /cli/thread/attachment` (null when the Thread or the
 *  message is unknown: nothing to ask). */
export function attachmentQuery(
  ref: AttachmentRef,
  n: number,
  mode: "meta" | "preview" | "range" | "thumb",
  range?: { offset: number; len: number },
  px?: ThumbPx
): Record<string, string> | null {
  const addr = str(ref.addr);
  const conv = str(ref.conversationId);
  const id = str(ref.id);
  if ((!addr && !conv) || !id || !Number.isInteger(n) || n < 0) return null;
  const q: Record<string, string> = addr ? { addr } : { conversationId: conv };
  q.id = id;
  q.n = String(n);
  q.mode = mode;
  if (mode === "range" && range) {
    q.offset = String(Math.max(0, Math.floor(range.offset)));
    q.len = String(Math.max(1, Math.floor(range.len)));
  }
  if (mode === "thumb") q.px = String(px === 256 ? 256 : 512);
  return q;
}

export type AttachmentErrorCode =
  | "usage"
  | "forbidden"
  | "missing_capability"
  | "unauthorized"
  | "not_found"
  | "attachment_gone"
  | "no_preview"
  | "preview_too_large"
  | "method_not_allowed"
  | "changed_during_download"
  | "bad_response"
  | "not_connected"
  | "network"
  | "http";

export type AttachmentError = {
  code: AttachmentErrorCode;
  status: number | null;
  /** The server's hint (or what went wrong), for detail lines. */
  hint: string;
};

export type AttachmentResult<T> = { ok: true; data: T } | { ok: false; error: AttachmentError };

/** The body's `error` as {code, hint, cap}: `{error:{code,hint,cap}}`,
 *  `{error:"…"}` or `{code}`; anything else is empty. */
function errorBody(text: string): { code: string; hint: string; cap?: string } {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j?.error;
    if (typeof e === "string") return { code: e, hint: e };
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      return { code: str(o.code), hint: str(o.hint) || str(o.message) || str(o.code), cap: str(o.cap) };
    }
    if (typeof j?.code === "string") return { code: j.code, hint: str(j.hint) || j.code };
  } catch {
    const t = text.trim();
    if (t && t.length < 200) return { code: t, hint: t };
  }
  return { code: "", hint: "" };
}

/** HTTP status + body → a typed error (the contract's errors table). */
export function mapAttachmentError(status: number, text: string): AttachmentError {
  const { code, hint, cap } = errorBody(text);
  const err = (c: AttachmentErrorCode): AttachmentError => ({ code: c, status, hint: hint || `HTTP ${status}` });
  if (status === 400) return err("usage");
  // A revoked guest pass: a bare 401 (go by status).
  if (status === 401) return err("unauthorized");
  if (status === 403) {
    // K2 f3da9a8ab: {code:"cap_not_granted", cap:"files:read"|"thread:read"};
    // "skin_room" (outside the room) and agents' "forbidden" stay as they
    // are. The old bare "missing capability files:read" still maps.
    if (code === "cap_not_granted") return err(cap === "files:read" ? "missing_capability" : "forbidden");
    if (/missing capability\s+files:read/i.test(code) || /missing capability\s+files:read/i.test(hint)) {
      return err("missing_capability");
    }
    return err("forbidden");
  }
  if (status === 404) return err(code === "attachment_gone" ? "attachment_gone" : "not_found");
  // 415 `no_preview`, or `no_thumbnail` (K2 0.46.3: e.g. HEIC on a box
  // without a converter): the chip, not a picture.
  if (status === 415 || code === "no_preview" || code === "no_thumbnail") return err("no_preview");
  if (status === 413 || code === "preview_too_large") return err("preview_too_large");
  if (status === 405) return err("method_not_allowed");
  return err("http");
}

/** What a person reads for an error (the sheet's line). */
export function attachmentErrorText(e: AttachmentError): string {
  switch (e.code) {
    case "attachment_gone":
      return "Not found (moved or deleted)";
    case "not_found":
      return "This file is no longer on that message.";
    case "missing_capability":
      return "This file isn't shared with you.";
    case "forbidden":
      return "You can't open files on this Thread.";
    case "unauthorized":
      return "Your access to this server has ended. Sign in again.";
    case "usage":
      return "The server could not read that request.";
    case "no_preview":
      return "No preview for this file type.";
    case "preview_too_large":
      return "Too large to preview.";
    case "changed_during_download":
      return "The file kept changing while it downloaded. Try again.";
    case "not_connected":
      return "Not connected to this server.";
    case "network":
      return "Could not reach the server.";
    default:
      return "Could not open the file.";
  }
}

export type AttachmentMeta = {
  kind: string;
  name: string;
  path: string;
  /** Bytes now (use this for the large-download prompt). */
  size: number | null;
  mime: string;
  modifiedAt: number | null;
  state: ThreadAttachmentState;
  line: number | null;
  lineEnd: number | null;
};

function badResponse(hint: string): { ok: false; error: AttachmentError } {
  return { ok: false, error: { code: "bad_response", status: null, hint } };
}

function stateOf(v: unknown): ThreadAttachmentState {
  const s = str(v).toLowerCase();
  return STATES.has(s as ThreadAttachmentState) ? (s as ThreadAttachmentState) : "ok";
}

export function parseAttachmentMeta(body: unknown): AttachmentResult<AttachmentMeta> {
  if (!body || typeof body !== "object") return badResponse("meta: not an object");
  const o = body as Record<string, unknown>;
  const line = posInt(o.line);
  const lineEnd = posInt(o.lineEnd);
  const path = str(o.path);
  return {
    ok: true,
    data: {
      kind: str(o.kind) || "file",
      name: str(o.name) || baseName(path),
      path,
      size: num(o.size),
      mime: str(o.mime).toLowerCase(),
      modifiedAt: num(o.modifiedAt),
      state: stateOf(o.state),
      line,
      lineEnd: line != null && lineEnd != null && lineEnd >= line ? lineEnd : null,
    },
  };
}

export type AttachmentPreview =
  | {
      kind: "text";
      mime: string;
      name: string;
      size: number | null;
      state: ThreadAttachmentState;
      text: string;
      truncated: boolean;
    }
  | {
      kind: "image" | "pdf";
      mime: string;
      name: string;
      size: number | null;
      state: ThreadAttachmentState;
      base64: string;
    };

export function parseAttachmentPreview(body: unknown): AttachmentResult<AttachmentPreview> {
  if (!body || typeof body !== "object") return badResponse("preview: not an object");
  const o = body as Record<string, unknown>;
  const kind = str(o.kind);
  const common = {
    mime: str(o.mime).toLowerCase(),
    name: str(o.name),
    size: num(o.size),
    state: stateOf(o.state),
  };
  if (kind === "text") {
    if (typeof o.text !== "string") return badResponse("preview: text missing");
    return { ok: true, data: { kind, ...common, text: o.text, truncated: o.truncated === true } };
  }
  if (kind === "image" || kind === "pdf") {
    if (typeof o.base64 !== "string") return badResponse("preview: base64 missing");
    return { ok: true, data: { kind, ...common, base64: o.base64 } };
  }
  return badResponse(`preview: unknown kind '${kind}'`);
}

export type AttachmentRange = {
  base64: string;
  len: number;
  offset: number;
  size: number;
  eof: boolean;
};

export function parseAttachmentRange(body: unknown): AttachmentResult<AttachmentRange> {
  if (!body || typeof body !== "object") return badResponse("range: not an object");
  const o = body as Record<string, unknown>;
  const len = num(o.len);
  const size = num(o.size);
  if (typeof o.base64 !== "string" || len == null || len < 0 || size == null || size < 0) {
    return badResponse("range: base64/len/size missing");
  }
  return {
    ok: true,
    data: { base64: o.base64, len, offset: num(o.offset) ?? 0, size, eof: o.eof === true },
  };
}

export type AttachmentThumb = {
  mime: string;
  width: number;
  height: number;
  px: number;
  base64: string;
  state: ThreadAttachmentState;
};

const THUMB_MIMES = new Set(["image/jpeg", "image/png", "image/svg+xml"]);

/** `mode=thumb` (K2 0.46.3): `{ok, kind:"image", mime, width, height, px,
 *  base64, name, size, state, sanitized?}`. Only the three MIME types the
 *  contract names are drawn. */
export function parseAttachmentThumb(body: unknown): AttachmentResult<AttachmentThumb> {
  if (!body || typeof body !== "object") return badResponse("thumb: not an object");
  const o = body as Record<string, unknown>;
  const mime = str(o.mime).toLowerCase();
  const width = num(o.width);
  const height = num(o.height);
  if (str(o.kind) !== "image" || typeof o.base64 !== "string" || !o.base64) {
    return badResponse("thumb: image/base64 missing");
  }
  if (!THUMB_MIMES.has(mime)) return badResponse(`thumb: unexpected mime '${mime}'`);
  if (width == null || height == null || width <= 0 || height <= 0) return badResponse("thumb: no size");
  return {
    ok: true,
    data: { mime, width, height, px: num(o.px) ?? 0, base64: o.base64, state: stateOf(o.state) },
  };
}
