import { sha256, sha384, sha512 } from "@noble/hashes/sha2";
import type { ServerScope } from "../../api/scope";
import {
  fetchGardenLibFile,
  requestGardenLib,
  type GardenFrameBody,
  type GardenLib,
  type GardenRefusal,
  type GardenResult,
} from "./gardensApi";

// A widget's document (§4.2): the server serves every library, the phone
// checks each one and fills its slot. Fail closed: a frame whose library
// didn't check never loads.

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The text is exactly the file the frame's row names. */
export function fileChecks(text: string, file: { bytes: number; sha256: string }): boolean {
  const bytes = encoder.encode(text);
  return bytes.length === file.bytes && hex(sha256(bytes)) === file.sha256.toLowerCase();
}

/** The text matches a `sha256-…` / `sha384-…` / `sha512-…` integrity value. */
export function integrityChecks(text: string, integrity: string): boolean {
  const dash = integrity.indexOf("-");
  if (dash < 0) return false;
  const bytes = encoder.encode(text);
  const algo = integrity.slice(0, dash);
  const want = integrity.slice(dash + 1);
  if (algo === "sha256") return base64(sha256(bytes)) === want;
  if (algo === "sha384") return base64(sha384(bytes)) === want;
  if (algo === "sha512") return base64(sha512(bytes)) === want;
  return false;
}

/** Library text inside a `<script>`: `</script`, in any case, can't end the
 *  element. Its case stays, so a string in the library means the same. */
export function escapeForScript(text: string): string {
  return text.replace(/<\/(script)/gi, "<\\/$1");
}

/** Fill every slot in one pass, so text a library brings in is never
 *  mistaken for a later slot. Unknown slots stay as they are. */
export function fillSlots(srcdoc: string, texts: ReadonlyMap<string, string>): string {
  return srcdoc.replace(/__K2_LIB_\d+__/g, (slot) => {
    const text = texts.get(slot);
    return text === undefined ? slot : escapeForScript(text);
  });
}

const libMemory = new Map<string, string>();

export function forgetGardenLibs(): void {
  libMemory.clear();
}

function refused(code: string, hint = ""): GardenResult<string> {
  return { ok: false, refusal: { status: 0, code, hint } satisfies GardenRefusal };
}

async function namedFile(
  scope: ServerScope,
  lib: GardenLib,
  file: { name: string; sha256: string; bytes: number }
): Promise<GardenResult<string>> {
  const query = { id: lib.id ?? "", version: lib.version ?? "", file: file.name };
  let r = await fetchGardenLibFile(scope, query);
  // A `download` library the server doesn't hold yet: ask it once.
  if (!r.ok && r.refusal.code === "not_cached") {
    const asked = await requestGardenLib(scope, { id: lib.id ?? "", version: lib.version ?? "" });
    if (!asked.ok) return asked;
    r = await fetchGardenLibFile(scope, query);
  }
  if (!r.ok) return r;
  return fileChecks(r.data, file) ? r : refused("lib_mismatch", `${lib.key} didn't check`);
}

async function libText(scope: ServerScope, lib: GardenLib): Promise<GardenResult<string>> {
  if (lib.source === "cdn") {
    if (!lib.url || !lib.integrity) return refused("lib_mismatch", `${lib.key} has no integrity`);
    const memo = `${lib.key}|${lib.integrity}`;
    const hit = libMemory.get(memo);
    if (hit !== undefined) return { ok: true, data: hit };
    const asked = await requestGardenLib(scope, { url: lib.url, integrity: lib.integrity });
    if (!asked.ok) return asked;
    const r = await fetchGardenLibFile(scope, { integrity: lib.integrity });
    if (!r.ok) return r;
    if (!integrityChecks(r.data, lib.integrity)) return refused("lib_mismatch", `${lib.key} didn't check`);
    libMemory.set(memo, r.data);
    return r;
  }
  const parts: string[] = [];
  for (const file of lib.files ?? []) {
    const memo = `${lib.key}|${file.name}|${file.sha256}`;
    const hit = libMemory.get(memo);
    if (hit !== undefined) {
      parts.push(hit);
      continue;
    }
    const r = await namedFile(scope, lib, file);
    if (!r.ok) return r;
    libMemory.set(memo, r.data);
    parts.push(r.data);
  }
  return { ok: true, data: parts.join("\n;\n") };
}

/** The frame's document with every library in, or why it can't load. */
export async function buildFrameDoc(scope: ServerScope, frame: GardenFrameBody): Promise<GardenResult<string>> {
  const results = await Promise.all((frame.libs ?? []).map((lib) => libText(scope, lib)));
  const texts = new Map<string, string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) return r;
    texts.set(frame.libs[i].slot, r.data);
  }
  return { ok: true, data: fillSlots(frame.srcdoc, texts) };
}
