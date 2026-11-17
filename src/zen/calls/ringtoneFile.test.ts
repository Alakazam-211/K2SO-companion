// The DM call ringtone the push extension names (scripts/gen-ringtone.mjs →
// src-tauri/gen/apple/K2Sounds/k2-ring.caf): a CAF iOS plays for a
// notification (IMA4, mono), 30 s or less, small, and really the in-app
// ring's pattern (1.5 s of 440 + 480 Hz every 4 s).
import { beforeAll, describe, expect, it } from "vitest";

// Node's fs by name: the app's tsconfig has no Node types (DOM only).
type Any = any;
const load = (m: string): Promise<Any> => import(/* @vite-ignore */ m);

async function readRing(): Promise<Uint8Array> {
  const fs = await load("node:fs");
  const raw = fs.readFileSync(new URL("../../../src-tauri/gen/apple/K2Sounds/k2-ring.caf", import.meta.url));
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

type Desc = { rate: number; format: string; bytesPerPacket: number; framesPerPacket: number; channels: number };

function readCaf(buf: Uint8Array): { desc: Desc; audio: Uint8Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  expect(ascii(buf, 0, 4)).toBe("caff");
  expect(view.getUint16(4)).toBe(1);
  let at = 8;
  let desc: Desc | null = null;
  let audio: Uint8Array | null = null;
  while (at + 12 <= buf.length) {
    const type = ascii(buf, at, at + 4);
    // 64-bit sizes: the high word is 0 here, or -1 (to the end) for data.
    const high = view.getInt32(at + 4);
    const size = high < 0 ? -1 : high * 2 ** 32 + view.getUint32(at + 8);
    const body = at + 12;
    const end = size < 0 ? buf.length : body + size;
    if (type === "desc") {
      desc = {
        rate: view.getFloat64(body),
        format: ascii(buf, body + 8, body + 12),
        bytesPerPacket: view.getUint32(body + 16),
        framesPerPacket: view.getUint32(body + 20),
        channels: view.getUint32(body + 24),
      };
    } else if (type === "data") {
      audio = buf.subarray(body + 4, end); // after the edit count
    }
    at = end;
  }
  if (!desc || !audio) throw new Error("no desc or data chunk");
  return { desc, audio };
}

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

/** Apple IMA4, mono: 34-byte packets of 64 frames. */
function decodeIma4(audio: Uint8Array): Float64Array {
  const packets = Math.floor(audio.length / 34);
  const out = new Float64Array(packets * 64);
  for (let p = 0; p < packets; p++) {
    const o = p * 34;
    const head = (audio[o] << 8) | audio[o + 1];
    let pred = (head & 0xff80) << 16 >> 16;
    let index = Math.min(88, head & 0x7f);
    for (let i = 0; i < 64; i++) {
      const byte = audio[o + 2 + (i >> 1)];
      const nib = i & 1 ? byte >> 4 : byte & 0x0f;
      const step = STEPS[index];
      let diff = step >> 3;
      if (nib & 4) diff += step;
      if (nib & 2) diff += step >> 1;
      if (nib & 1) diff += step >> 2;
      pred = Math.max(-32768, Math.min(32767, nib & 8 ? pred - diff : pred + diff));
      index = Math.max(0, Math.min(88, index + INDEX[nib & 7]));
      out[p * 64 + i] = pred / 32768;
    }
  }
  return out;
}

describe("k2-ring.caf", () => {
  let buf: Uint8Array = new Uint8Array();
  let desc: Desc;
  let audio: Uint8Array = new Uint8Array();
  let seconds = 0;
  beforeAll(async () => {
    buf = await readRing();
    ({ desc, audio } = readCaf(buf));
    seconds = ((audio.length / desc.bytesPerPacket) * desc.framesPerPacket) / desc.rate;
  });

  it("is mono IMA4 in a CAF, small", () => {
    expect(desc).toMatchObject({ format: "ima4", channels: 1, bytesPerPacket: 34, framesPerPacket: 64 });
    expect(desc.rate).toBe(22050);
    expect(buf.length).toBeLessThan(1_000_000);
  });

  it("lasts about 28 s: under iOS's 30 s for a notification sound", () => {
    expect(seconds).toBeGreaterThan(27.9);
    expect(seconds).toBeLessThan(30);
  });

  it("rings 1.5 s every 4 s, and is quiet in between", () => {
    const pcm = decodeIma4(audio);
    const peak = (from: number, to: number) => {
      let m = 0;
      for (let i = Math.round(from * desc.rate); i < Math.round(to * desc.rate); i++) m = Math.max(m, Math.abs(pcm[i]));
      return m;
    };
    for (let start = 0; start + 1.5 <= 28; start += 4) {
      expect(peak(start + 0.2, start + 1.3)).toBeGreaterThan(0.5);
      expect(peak(start + 1.6, start + 3.9)).toBeLessThan(0.02);
    }
    expect(peak(0, seconds)).toBeLessThan(0.8);
  });
});
