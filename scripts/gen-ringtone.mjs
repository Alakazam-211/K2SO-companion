#!/usr/bin/env node
// Writes the DM call ringtone the Notification Service Extension names for a
// ring push (NotificationService.swift `ringSound`):
//   src-tauri/gen/apple/K2Sounds/k2-ring.caf
// Our own sound, no third-party audio: the in-app ring (src/zen/calls/
// ringTone.ts) as a file. 440 Hz + 480 Hz together for 1.5 s every 4 s,
// the same soft envelope (50 ms in, 50 ms out), 28 s long (iOS plays a
// notification sound only when it's 30 s or less). Louder than the
// in-app Web Audio ring (that one sits under the app's other sound; this
// one follows the ringer volume).
//
// Mono 16-bit PCM WAV at 22.05 kHz, then macOS's afconvert to IMA4 in a CAF
// (an encoding iOS accepts for notification sounds; about 330 KB). Run on
// a Mac: node scripts/gen-ringtone.mjs
// src/zen/calls/ringtoneFile.test.ts checks the committed file.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src-tauri/gen/apple/K2Sounds/k2-ring.caf");

const RATE = 22_050;
const LENGTH_S = 28;
const CYCLE_S = 4;
const TONE_S = 1.5;
const RAMP_S = 0.05;
const TONES_HZ = [440, 480];
/** Each tone's peak; the two together peak at 0.7 of full scale. */
const LEVEL = 0.35;

function ringSamples() {
  const n = Math.round(RATE * LENGTH_S);
  const out = new Float64Array(n);
  for (let start = 0; start + TONE_S <= LENGTH_S; start += CYCLE_S) {
    const first = Math.round(start * RATE);
    const count = Math.round(TONE_S * RATE);
    for (let i = 0; i < count && first + i < n; i++) {
      const t = i / RATE;
      const env = t < RAMP_S ? t / RAMP_S : t > TONE_S - RAMP_S ? Math.max(0, (TONE_S - t) / RAMP_S) : 1;
      let v = 0;
      for (const hz of TONES_HZ) v += Math.sin(2 * Math.PI * hz * t);
      out[first + i] = v * LEVEL * env;
    }
  }
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const dir = mkdtempSync(join(tmpdir(), "k2-ring-"));
try {
  const src = join(dir, "k2-ring.wav");
  writeFileSync(src, wav(ringSamples()));
  mkdirSync(dirname(OUT), { recursive: true });
  execFileSync("afconvert", ["-f", "caff", "-d", "ima4", src, OUT], { stdio: "inherit" });
  console.log(`${OUT}: ${statSync(OUT).size} bytes, ${LENGTH_S} s, mono IMA4 ${RATE} Hz`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
