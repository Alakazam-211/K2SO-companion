// Validates T4's ported Orca byte tables (lib/terminalKeys.ts): chord
// builders (Ctrl = charCode-96, Alt = ESC prefix, Shift tables), the
// CSI/SS3/CSI-tilde special-key encodings incl. the SS3→CSI flip under
// modifiers, the 1;N modifier math (shift+1 alt+2 ctrl+4), the
// KeyboardEvent.key → bytes map (Enter deliberately absent), and the
// accessory-bar default set.
//
// Run:  node scripts/test-terminal-keys.mjs   (Node native TS
// type-stripping — the test-send-mode.mjs idiom).

import {
  buildTerminalShortcutKey,
  getLiveSpecialKeyBytes,
  TERMINAL_ACCESSORY_KEYS,
} from "../src/lib/terminalKeys.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };
const bytes = (key, modifiers = []) => buildTerminalShortcutKey({ key, modifiers })?.bytes ?? null;
const ESC = "\x1b";

// ── Ctrl chords: charCode − 96 + the punctuation table ──
console.log("[ctrl] control-byte chords");
assert(bytes("a", ["ctrl"]) === "\x01", "Ctrl+A = \\x01");
assert(bytes("c", ["ctrl"]) === "\x03", "Ctrl+C = \\x03");
assert(bytes("z", ["ctrl"]) === "\x1a", "Ctrl+Z = \\x1a");
assert(bytes("space", ["ctrl"]) === "\x00", "Ctrl+Space = NUL");
assert(bytes("[", ["ctrl"]) === "\x1b", "Ctrl+[ = ESC");
assert(bytes("_", ["ctrl"]) === "\x1f", "Ctrl+_ = \\x1f (unit separator)");
assert(bytes("?", ["ctrl"]) === "\x7f", "Ctrl+? = DEL");
assert(bytes("2", ["ctrl", "shift"]) === "\x00", "Ctrl+Shift+2 shifts to @ then NUL");

// ── Shift / Alt on printables ──
console.log("\n[printable] shift table + alt prefix");
assert(bytes("1", ["shift"]) === "!", "Shift+1 = !");
assert(bytes("a", ["shift"]) === "A", "Shift+A uppercases");
assert(bytes("/", ["shift"]) === "?", "Shift+/ = ?");
assert(bytes("x", ["alt"]) === `${ESC}x`, "Alt+X = ESC-prefixed x");
assert(bytes("b", ["ctrl", "alt"]) === `${ESC}\x02`, "Ctrl+Alt+B = ESC + \\x02");

// ── Tab / Escape / Enter / Backspace specials ──
console.log("\n[special] tab family + editing keys");
assert(bytes("tab") === "\t", "Tab = \\t");
assert(bytes("tab", ["shift"]) === `${ESC}[Z`, "Shift+Tab = ESC[Z (reverse tab)");
assert(bytes("tab", ["alt"]) === `${ESC}\t`, "Alt+Tab = ESC \\t");
assert(bytes("escape") === ESC, "Esc = ESC");
assert(bytes("enter") === "\r", "Enter = \\r");
assert(bytes("enter", ["alt"]) === `${ESC}\r`, "Alt+Enter = ESC \\r");
assert(bytes("backspace") === "\x7f", "Backspace = DEL byte");
assert(bytes("backspace", ["ctrl"]) === "\b", "Ctrl+Backspace = \\b");

// ── Arrows: CSI finals + the 1;N modifier math ──
console.log("\n[csi] arrows + modifier parameters");
assert(bytes("arrowUp") === `${ESC}[A`, "↑ = ESC[A");
assert(bytes("arrowDown") === `${ESC}[B`, "↓ = ESC[B");
assert(bytes("arrowRight") === `${ESC}[C`, "→ = ESC[C");
assert(bytes("arrowLeft") === `${ESC}[D`, "← = ESC[D");
assert(bytes("arrowUp", ["shift"]) === `${ESC}[1;2A`, "Shift+↑ = ESC[1;2A (1+shift1)");
assert(bytes("arrowUp", ["alt"]) === `${ESC}[1;3A`, "Alt+↑ = ESC[1;3A (1+alt2)");
assert(bytes("arrowUp", ["ctrl"]) === `${ESC}[1;5A`, "Ctrl+↑ = ESC[1;5A (1+ctrl4)");
assert(bytes("arrowUp", ["ctrl", "alt", "shift"]) === `${ESC}[1;8A`, "Ctrl+Alt+Shift+↑ = ESC[1;8A (1+1+2+4)");
assert(bytes("home") === `${ESC}[H` && bytes("end") === `${ESC}[F`, "Home/End = ESC[H / ESC[F");

// ── F-keys: SS3 base → CSI flip under modifiers; CSI-tilde block ──
console.log("\n[fkeys] SS3→CSI flip + tilde keys");
assert(bytes("f1") === `${ESC}OP`, "F1 unmodified = SS3 (ESC O P)");
assert(bytes("f4") === `${ESC}OS`, "F4 unmodified = SS3 (ESC O S)");
assert(bytes("f1", ["shift"]) === `${ESC}[1;2P`, "Shift+F1 FLIPS to CSI 1;2P");
assert(bytes("f5") === `${ESC}[15~`, "F5 = ESC[15~");
assert(bytes("f5", ["ctrl"]) === `${ESC}[15;5~`, "Ctrl+F5 = ESC[15;5~");
assert(bytes("f12") === `${ESC}[24~`, "F12 = ESC[24~");
assert(bytes("delete") === `${ESC}[3~`, "Del = ESC[3~");
assert(bytes("pageUp", ["shift"]) === `${ESC}[5;2~`, "Shift+PgUp = ESC[5;2~");

// ── Labels + unknown keys ──
console.log("\n[surface] labels + rejects");
const built = buildTerminalShortcutKey({ key: "a", modifiers: ["shift", "ctrl"] });
assert(built.label === "Ctrl+Shift+A", "label orders modifiers Ctrl→Alt→Shift");
assert(built.accessibilityLabel === "Ctrl Shift A", "accessibility label drops the +");
assert(buildTerminalShortcutKey({ key: "", modifiers: [] }) === null, "empty key rejected");
assert(bytes("é") === null, "non-ASCII printable rejected");

// ── KeyboardEvent.key map (hardware keyboards) ──
console.log("\n[keydown] KeyboardEvent.key → bytes");
assert(getLiveSpecialKeyBytes("ArrowLeft") === `${ESC}[D`, "ArrowLeft maps to ESC[D");
assert(getLiveSpecialKeyBytes("Escape") === ESC, "Escape maps to ESC");
assert(getLiveSpecialKeyBytes("PageDown") === `${ESC}[6~`, "PageDown maps to ESC[6~");
assert(getLiveSpecialKeyBytes("Enter") === null, "Enter is ABSENT (capture keydown owns \\r — no double-send)");
assert(getLiveSpecialKeyBytes("a") === null, "printables don't map (input event owns them)");

// ── Accessory bar default set ──
console.log("\n[bar] accessory default set");
const ids = TERMINAL_ACCESSORY_KEYS.map((k) => k.id);
assert(
  ids.join(",") ===
    "escape,tab,shiftTab,newline,arrowLeft,arrowDown,arrowUp,arrowRight,ctrlC,ctrlD,ctrlZ,ctrlL,ctrlR,ctrlA,ctrlE,ctrlW,ctrlU,backspace",
  "bar order: Esc Tab Shift+Tab ⇧⏎ ←↓↑→ Ctrl+C/D/Z/L/R/A/E/W/U ⌫"
);
const byId = Object.fromEntries(TERMINAL_ACCESSORY_KEYS.map((k) => [k.id, k]));
assert(byId.shiftTab.bytes === `${ESC}[Z`, "bar Shift+Tab carries ESC[Z");
assert(byId.newline.bytes === `${ESC}\r`, "bar ⇧⏎ carries ESC+CR (meta-Enter newline, no submit)");
assert(byId.newline.repeatable !== true, "⇧⏎ is NOT repeatable (chord press model)");
assert(byId.ctrlC.bytes === "\x03" && byId.ctrlU.bytes === "\x15" && byId.ctrlW.bytes === "\x17", "bar Ctrl chords carry control bytes");
assert(
  ["arrowLeft", "arrowDown", "arrowUp", "arrowRight", "backspace"].every((id) => byId[id].repeatable === true),
  "arrows + backspace are repeatable"
);
assert(
  ["escape", "tab", "shiftTab", "ctrlC", "ctrlD", "ctrlZ", "ctrlL", "ctrlR", "ctrlA", "ctrlE", "ctrlW", "ctrlU"].every((id) => !byId[id].repeatable),
  "chord keys are NOT repeatable"
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
