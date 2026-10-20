// Image attachments drawn inline in a Thread message (K2 0.46.3
// `thread-images-v1`): a thumbnail from `GET /cli/thread/attachment
// ?mode=thumb`, kept on the device (thumbCache). One picture: its own
// shape, up to IMAGE_MAX_W × IMAGE_MAX_H. Two or more: a grid of square
// tiles. A tap opens the same sheet as a file chip. When the server can't
// make a thumbnail (415 `no_thumbnail`, 413 over 40 MP) the file shows as
// today's chip instead. An SVG thumbnail is only ever an <img> (data URL),
// never inline markup.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ServerScope } from "../api/scope";
import { getAttachmentMeta, getAttachmentThumb } from "../api/threadAttachment";
import type { AttachmentRef, ThreadAttachment, ThumbPx } from "../api/threadAttachmentPure";
import { CHANGED_TEXT } from "./threadFilesText";
import { thumbCache, thumbKey, thumbSrc, type CachedThumb } from "./thumbCache";

export const IMAGE_MAX_W = 220;
export const IMAGE_MAX_H = 260;
/** Before the thumb's size is known. */
export const IMAGE_PLACEHOLDER = { w: 200, h: 150 } as const;
export const GRID_TILE = 108;
const THUMB_PX: ThumbPx = 512;
/** Thumb reads in flight at once (the per-server HTTP cap is 4). */
const THUMB_CONCURRENCY = 2;
/** Start loading this far before a tile scrolls into view. */
const LOAD_MARGIN = "800px";

/** Where a Thread's thumbnails come from: its server and the Thread. */
export type ThreadImagesSource = {
  scope: ServerScope;
  addr: string | null;
  conversationId: string | null;
};

export const ThreadImagesContext = createContext<ThreadImagesSource | null>(null);

export type ThumbOutcome =
  | { kind: "ok"; thumb: CachedThumb }
  /** No thumbnail for this file: show the chip. */
  | { kind: "fallback" }
  | { kind: "error" };

// ─── Loading (deduped, at most THUMB_CONCURRENCY at once) ───

const inflight = new Map<string, Promise<ThumbOutcome>>();
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= THUMB_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** The cache key for a file in state `ok` (the message's values are the
 *  live ones). */
export function okThumbKey(scopeId: string, a: ThreadAttachment): string {
  return thumbKey(scopeId, a.path, a.modifiedAt, a.size, THUMB_PX);
}

/** One image attachment's thumbnail: memory, device, then the server.
 *  `changed` asks `mode=meta` first for the live (modifiedAt, size). */
export function loadThumb(src: ThreadImagesSource, messageId: string, a: ThreadAttachment): Promise<ThumbOutcome> {
  const scopeId = src.scope.id;
  const ref: AttachmentRef = { addr: src.addr, conversationId: src.conversationId, id: messageId };
  const known = a.state === "ok" ? okThumbKey(scopeId, a) : null;
  const flightKey = known ?? `${scopeId}|${messageId}|${a.n}|changed`;
  const running = inflight.get(flightKey);
  if (running) return running;
  const p = (async (): Promise<ThumbOutcome> => {
    let key = known;
    if (key) {
      const hit = await thumbCache().get(key);
      if (hit) return { kind: "ok", thumb: hit };
    }
    return slot(async () => {
      if (!key) {
        const meta = await getAttachmentMeta(src.scope, ref, a.n);
        if (!meta.ok) return outcomeOf(meta.error.code);
        if (meta.data.state === "gone" || meta.data.state === "hidden") return { kind: "fallback" };
        key = thumbKey(scopeId, a.path, meta.data.modifiedAt, meta.data.size, THUMB_PX);
        const hit = await thumbCache().get(key);
        if (hit) return { kind: "ok", thumb: hit };
      }
      const r = await getAttachmentThumb(src.scope, ref, a.n, THUMB_PX);
      if (!r.ok) return outcomeOf(r.error.code);
      const t = { key, serverId: scopeId, mime: r.data.mime, width: r.data.width, height: r.data.height, base64: r.data.base64 };
      thumbCache().put(t);
      return { kind: "ok", thumb: { ...t, savedAt: Date.now(), bytes: t.base64.length } };
    });
  })().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, p);
  return p;
}

function outcomeOf(code: string): ThumbOutcome {
  // No picture to be had (type, size, gone, not shared): the chip says why.
  return code === "no_preview" ||
    code === "preview_too_large" ||
    code === "attachment_gone" ||
    code === "not_found" ||
    code === "missing_capability" ||
    code === "forbidden"
    ? { kind: "fallback" }
    : { kind: "error" };
}

/** Tests: forget loads in flight. */
export function __resetThumbLoadsForTests(): void {
  inflight.clear();
  running = 0;
  waiting.length = 0;
}

// ─── Tiles ───

/** A thumbnail's drawn size: its own shape within the box, never upscaled
 *  past the box. */
export function fitImage(w: number, h: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { ...IMAGE_PLACEHOLDER };
  const scale = Math.min(IMAGE_MAX_W / w, IMAGE_MAX_H / h);
  return { w: Math.max(48, Math.round(w * scale)), h: Math.max(48, Math.round(h * scale)) };
}

/** Load once the tile is near the view (at once without
 *  IntersectionObserver). */
function useNearView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: LOAD_MARGIN }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

function ImageTile({
  a,
  messageId,
  grid,
  onOpen,
  onFallback,
}: {
  a: ThreadAttachment;
  messageId: string;
  grid: boolean;
  onOpen: (a: ThreadAttachment) => void;
  onFallback: (n: number) => void;
}) {
  const src = useContext(ThreadImagesContext);
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearView(ref);
  const [thumb, setThumb] = useState<CachedThumb | null>(() =>
    src && a.state === "ok" ? thumbCache().peek(okThumbKey(src.scope.id, a)) : null
  );
  const [failed, setFailed] = useState(false);
  const key = `${a.path}|${a.modifiedAt}|${a.size}|${a.state}`;

  useEffect(() => {
    if (!src || !near) return;
    let live = true;
    void loadThumb(src, messageId, a).then((o) => {
      if (!live) return;
      if (o.kind === "ok") {
        setThumb(o.thumb);
        setFailed(false);
      } else if (o.kind === "fallback") onFallback(a.n);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
    // `key` covers the file's identity; `a` itself changes per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, near, messageId, key]);

  const box = grid
    ? { w: GRID_TILE, h: GRID_TILE }
    : thumb
      ? fitImage(thumb.width, thumb.height)
      : { ...IMAGE_PLACEHOLDER };
  const changed = a.state === "changed";
  return (
    <button
      ref={ref}
      type="button"
      className="relative block overflow-hidden shrink-0"
      style={{
        width: box.w,
        height: box.h,
        maxWidth: "100%",
        borderRadius: 16,
        background: "var(--tile-raised)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
      onClick={() => onOpen(a)}
      aria-label={`Open image ${a.name}${changed ? `, ${CHANGED_TEXT}` : ""}`}
      data-testid="thread-image"
      data-state={a.state}
      data-loaded={thumb ? "true" : "false"}
    >
      {thumb ? (
        <img
          src={thumbSrc(thumb)}
          alt=""
          draggable={false}
          className="block w-full h-full"
          style={{ objectFit: "cover" }}
          data-testid="thread-image-img"
        />
      ) : failed ? (
        <span className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)]" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="1.6" />
            <path d="m21 16-5-5-9 9" />
          </svg>
        </span>
      ) : null}
      {changed ? (
        <span
          className="absolute top-1.5 right-1.5 rounded-full"
          style={{ width: 8, height: 8, background: "var(--warning)", boxShadow: "0 0 0 1.5px rgba(0,0,0,0.5)" }}
          data-testid="thread-image-changed"
          aria-hidden
        />
      ) : null}
    </button>
  );
}

/** The pictures under one message: one at its own shape, more in a grid. */
export function MessageImages({
  images,
  messageId,
  mine,
  onOpen,
  onFallback,
}: {
  images: readonly ThreadAttachment[];
  messageId: string;
  mine: boolean;
  onOpen: (a: ThreadAttachment) => void;
  /** This file has no thumbnail: draw it as a chip. */
  onFallback: (n: number) => void;
}) {
  if (!images.length) return null;
  const grid = images.length > 1;
  return (
    <div
      className={`${grid ? "grid grid-cols-2 gap-1" : "flex"} min-w-0 max-w-full ${mine ? "justify-items-end self-end" : "self-start"}`}
      data-testid="thread-images"
    >
      {images.map((a) => (
        <ImageTile key={a.n} a={a} messageId={messageId} grid={grid} onOpen={onOpen} onFallback={onFallback} />
      ))}
    </div>
  );
}
