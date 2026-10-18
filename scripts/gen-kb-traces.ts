// Writes the SYNTHETIC keyboard-drag traces (src/test/kbSynth.ts) to
// src/test/kbTraces/<name>.json for the replay suite.
//   npx vite-node scripts/gen-kb-traces.ts
// Real traces: Server settings → Diagnostics → Keyboard drag recorder →
// "Copy trace JSON", saved as src/test/kbTraces/<name>.json.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SYNTH_SCRIPTS, synthTrace } from "../src/test/kbSynth";

const dir = join(process.cwd(), "src/test/kbTraces");
mkdirSync(dir, { recursive: true });
for (const s of SYNTH_SCRIPTS) {
  const trace = synthTrace(s);
  writeFileSync(join(dir, `${s.name}.json`), JSON.stringify(trace) + "\n");
  console.log(`${s.name}: ${trace.samples.length} samples`);
}
