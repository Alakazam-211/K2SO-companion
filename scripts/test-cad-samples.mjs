// Parses the CAD sample files with the viewer's own code paths:
// dxfModel.ts (dxf-parser → SVG model) and modelParse.ts (three.js
// STL/OBJ/3MF loaders → stats). Node 24 strips the .ts types.
//
// Run:  node scripts/test-cad-samples.mjs [cad-dir]
//       (default: ./cad, i.e. the repo's sample folder)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// 3MFLoader reads its XML with DOMParser.
globalThis.DOMParser = new JSDOM("").window.DOMParser;

const { buildDrawing } = await import("../src/zen/files/dxfModel.ts");
const { parseModel } = await import("../src/zen/files/modelParse.ts");

const dir = process.argv[2] || "cad";
let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error("  ✗ " + msg);
    failures++;
  } else console.log("  ✓ " + msg);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

console.log("\n[dxf] k2-bracket.dxf");
{
  const d = buildDrawing(readFileSync(join(dir, "k2-bracket.dxf"), "utf8"));
  const kinds = d.nodes.map((n) => n.k);
  assert(kinds.filter((k) => k === "line").length === 8, "8 LINEs");
  assert(kinds.filter((k) => k === "circle").length === 2, "2 CIRCLEs (holes)");
  assert(kinds.filter((k) => k === "path").length === 6, "6 ARCs as SVG arc paths");
  assert(kinds.filter((k) => k === "text").length === 1, "1 TEXT");
  assert(d.skippedTotal === 0, "nothing skipped");
  assert(d.bounds && near(d.bounds.minX, -6) && near(d.bounds.maxY, 66), "bounds include centre lines");
}

async function model(name, ext) {
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  return parseModel(bytes, ext);
}

console.log("\n[stl] k2-bracket.stl (ASCII)");
{
  const { stats } = await model("k2-bracket.stl", ".stl");
  assert(stats.triangles > 100 && stats.triangles <= 400, `triangles ${stats.triangles} (a few hundred)`);
  assert(near(stats.size[0], 120) && near(stats.size[1], 60) && near(stats.size[2], 6), `size ${stats.size.join(" × ")}`);
}

console.log("\n[obj] k2-cube.obj");
{
  const { stats, root } = await model("k2-cube.obj", ".obj");
  assert(stats.meshes === 2, "two objects (cube, K2 letters)");
  assert(stats.triangles > 100, `triangles ${stats.triangles}`);
  assert(near(stats.size[0], 40) && near(stats.size[1], 40) && near(stats.size[2], 42), `size ${stats.size.join(" × ")}`);
  let grey = true;
  root.traverse((o) => {
    if (o.isMesh && o.material.type !== "MeshStandardMaterial") grey = false;
  });
  assert(grey, "OBJ meshes get the grey MeshStandardMaterial");
}

console.log("\n[3mf] k2-bracket.3mf");
{
  const { stats, root } = await model("k2-bracket.3mf", ".3mf");
  assert(stats.triangles === 288, `triangles ${stats.triangles}`);
  assert(near(stats.size[0], 120) && near(stats.size[1], 60) && near(stats.size[2], 6), `size ${stats.size.join(" × ")}`);
  let teal = false;
  root.traverse((o) => {
    if (o.isMesh) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m.color && m.color.getHexString() !== "ffffff") teal = true;
    }
  });
  assert(teal, "3MF base material colour kept");
  assert(Math.abs(root.children[0].rotation.x + Math.PI / 2) < 1e-9, "Z-up turned to three's Y-up");
}

console.log("\n[stl] binary STL from bytes");
{
  // One triangle, binary: 80-byte header, count, 50 bytes per facet.
  const buf = new ArrayBuffer(84 + 50);
  const v = new DataView(buf);
  v.setUint32(80, 1, true);
  const f = [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0];
  f.forEach((x, i) => v.setFloat32(84 + i * 4, x, true));
  const { stats } = await parseModel(new Uint8Array(buf), ".stl");
  assert(stats.triangles === 1 && near(stats.size[0], 10), "binary STL parses");
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall CAD samples parse");
