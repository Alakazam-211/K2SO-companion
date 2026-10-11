// Writes the CAD viewer's sample files (STL, OBJ, 3MF) next to the
// existing cad/k2-bracket.dxf. Geometry is built with three.js in Node
// and written with three's own exporters (STL, OBJ) or by hand (3MF:
// a zip of three XML parts, packed with the fflate copy three ships).
//
// Run:  node scripts/gen-cad-samples.mjs <out-dir>
// Then: node scripts/test-cad-samples.mjs <out-dir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, Path, Shape } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { strToU8, zipSync } from "three/addons/libs/fflate.module.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/gen-cad-samples.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// ── The bracket from k2-bracket.dxf: 120 × 60, R8 corners, 2× Ø10 holes
//    at (15,30) and (105,30), a 30 × 10 slot centred at (60,30); 6 thick.
function bracketGeometry() {
  const s = new Shape();
  const W = 120, H = 60, R = 8;
  s.moveTo(R, 0);
  s.lineTo(W - R, 0);
  s.absarc(W - R, R, R, -Math.PI / 2, 0, false);
  s.lineTo(W, H - R);
  s.absarc(W - R, H - R, R, 0, Math.PI / 2, false);
  s.lineTo(R, H);
  s.absarc(R, H - R, R, Math.PI / 2, Math.PI, false);
  s.lineTo(0, R);
  s.absarc(R, R, R, Math.PI, Math.PI * 1.5, false);
  for (const cx of [15, 105]) {
    const h = new Path();
    h.absarc(cx, 30, 5, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  const slot = new Path();
  slot.moveTo(45, 25);
  slot.absarc(45, 30, 5, -Math.PI / 2, Math.PI / 2, true);
  slot.lineTo(75, 35);
  slot.absarc(75, 30, 5, Math.PI / 2, -Math.PI / 2, true);
  slot.lineTo(45, 25);
  s.holes.push(slot);
  return new ExtrudeGeometry(s, { depth: 6, bevelEnabled: false, curveSegments: 4 });
}

// ── A rounded 40 mm cube with a blocky "K2" standing 2 mm off the front.
function k2Shapes() {
  const poly = (pts) => {
    const sh = new Shape();
    sh.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) sh.lineTo(p[0], p[1]);
    sh.closePath();
    return sh;
  };
  // K: stem + two arms (glyph box 0..10 × 0..16).
  const k = [
    poly([[0, 0], [3, 0], [3, 16], [0, 16]]),
    poly([[3, 7], [8, 16], [11, 16], [4.5, 5]]),
    poly([[3, 9], [8, 0], [11, 0], [4.5, 11]]),
  ];
  // 2: top bar, right upper, middle, left lower, base (x offset 13).
  const o = 13;
  const r = (x, y, w, h) => poly([[o + x, y], [o + x + w, y], [o + x + w, y + h], [o + x, y + h]]);
  const two = [r(0, 13, 10, 3), r(7, 8, 3, 5), r(0, 6.5, 10, 3), r(0, 3, 3, 3.5), r(0, 0, 10, 3)];
  return [...k, ...two];
}

function k2Cube() {
  const group = new Group();
  const cube = new Mesh(new RoundedBoxGeometry(40, 40, 40, 2, 4), new MeshStandardMaterial());
  cube.name = "rounded_cube";
  group.add(cube);
  const letters = new ExtrudeGeometry(k2Shapes(), { depth: 2, bevelEnabled: false });
  // Glyphs are 23 × 16: centre them on the +Z face.
  letters.translate(-11.5, -8, 20);
  const k2 = new Mesh(letters, new MeshStandardMaterial());
  k2.name = "k2_letters";
  group.add(k2);
  return group;
}

// ── 3MF: core-spec XML in a zip.
function threeMf(geometry) {
  // Position only, so shared corners merge into one indexed vertex.
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  const g = mergeVertices(geometry, 1e-4);
  const pos = g.getAttribute("position");
  const idx = g.index;
  const f = (v) => String(Math.round(v * 1e4) / 1e4);
  const verts = [];
  for (let i = 0; i < pos.count; i++) {
    verts.push(`<vertex x="${f(pos.getX(i))}" y="${f(pos.getY(i))}" z="${f(pos.getZ(i))}"/>`);
  }
  const tris = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (a === b || b === c || a === c) continue;
    tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Title">K2 mounting bracket</metadata>
 <metadata name="Designer">K2 Companion sample</metadata>
 <resources>
  <basematerials id="1">
   <base name="K2 teal" displaycolor="#2EC4B6FF"/>
  </basematerials>
  <object id="2" type="model" pid="1" pindex="0" name="bracket">
   <mesh>
    <vertices>
     ${verts.join("\n     ")}
    </vertices>
    <triangles>
     ${tris.join("\n     ")}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="2"/>
 </build>
</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return {
    zip: zipSync({
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(rels),
      "3D/3dmodel.model": strToU8(model),
    }),
    triangles: tris.length,
  };
}

const bracket = bracketGeometry();
const stl = new STLExporter().parse(new Mesh(bracket), { binary: false }).replace(/^solid exported/m, "solid k2_bracket").replace(/endsolid exported/, "endsolid k2_bracket")
  .replace(/-?\d+\.\d{5,}(e-?\d+)?/g, (v) => String(Math.round(Number(v) * 1e4) / 1e4));
writeFileSync(join(out, "k2-bracket.stl"), stl);
console.log(`k2-bracket.stl  ${(stl.match(/facet normal/g) || []).length} triangles, ${stl.length} bytes`);

// Four decimals is plenty for a 40 mm part (and quarters the file).
const obj = `# K2 Companion sample: rounded 40 mm cube with a raised "K2"\n${new OBJExporter()
  .parse(k2Cube())
  .replace(/-?\d+\.\d{5,}(e-?\d+)?/g, (v) => String(Math.round(Number(v) * 1e4) / 1e4))}`;
writeFileSync(join(out, "k2-cube.obj"), obj);
console.log(`k2-cube.obj     ${(obj.match(/^f /gm) || []).length} faces, ${obj.length} bytes`);

const mf = threeMf(bracketGeometry());
writeFileSync(join(out, "k2-bracket.3mf"), mf.zip);
console.log(`k2-bracket.3mf  ${mf.triangles} triangles, ${mf.zip.length} bytes`);
