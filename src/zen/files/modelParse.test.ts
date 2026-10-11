// The real three.js loaders (parsing needs no WebGL). Rendering is covered
// with a mocked scene in CadViews.test.tsx.

import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, Mesh, Points, PointsMaterial } from "three";
import { disposeObject, meshFromGeometry, parseModel, pointSizeFor } from "./modelParse";

const enc = (s: string): Uint8Array => Uint8Array.from(new TextEncoder().encode(s));

const PLY_POINTS = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
end_header
0 0 0
1 0 0
0 2 3
`;

const PLY_COLOURED_POINTS = `ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
0 0 0 255 0 0
10 0 0 0 0 255
`;

describe("PLY point clouds", () => {
  it("a PLY with no faces is a THREE.Points, sized from its bounds", async () => {
    const { root, stats } = await parseModel(enc(PLY_POINTS), ".ply");
    expect(root).toBeInstanceOf(Points);
    const mat = (root as Points).material as PointsMaterial;
    expect(mat).toBeInstanceOf(PointsMaterial);
    expect(mat.sizeAttenuation).toBe(true);
    expect(mat.vertexColors).toBe(false);
    expect(mat.size).toBeCloseTo(pointSizeFor((root as Points).geometry));
    expect(mat.size).toBeGreaterThan(0);
    expect(stats.triangles).toBe(0);
    expect(stats.size.map((v) => Math.round(v))).toEqual([1, 2, 3]);
    disposeObject(root);
  });

  it("vertex colours are used when the PLY has them", async () => {
    const { root } = await parseModel(enc(PLY_COLOURED_POINTS), ".ply");
    const mat = (root as Points).material as PointsMaterial;
    expect(mat.vertexColors).toBe(true);
    expect(mat.color.getHex()).toBe(0xffffff);
    disposeObject(root);
  });

  it("point size scales with the cloud", () => {
    const cloud = (scale: number) => {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, scale, scale, scale]), 3));
      return g;
    };
    expect(pointSizeFor(cloud(1000)) / pointSizeFor(cloud(1))).toBeCloseTo(1000);
  });

  it("a geometry with an index stays a mesh", () => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    g.setIndex([0, 1, 2]);
    expect(meshFromGeometry(g, !g.index)).toBeInstanceOf(Mesh);
  });
});

describe("loader exceptions become a readable refusal", () => {
  it("a truncated STL rejects with a named error, not a bare RangeError", async () => {
    const err = await parseModel(enc("solid e\nendsolid e\n"), ".stl").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/^This STL could not be read/);
  });

  it("a binary STL whose facet count overruns the bytes is refused the same way", async () => {
    const buf = new ArrayBuffer(84 + 10);
    new DataView(buf).setUint32(80, 1000, true);
    await expect(parseModel(new Uint8Array(buf), ".stl")).rejects.toThrow(/This STL could not be read/);
  });

  it("an STL with no triangles is still its own message", async () => {
    const empty = `solid ${"empty".repeat(20)}\nendsolid ${"empty".repeat(20)}\n`;
    await expect(parseModel(enc(empty), ".stl")).rejects.toThrow(/No triangles in this STL/);
  });

  it("a corrupt .gltf names the format", async () => {
    await expect(parseModel(enc("{not json"), ".gltf")).rejects.toThrow(/This glTF could not be read/);
  });

  it("a .gltf that needs Draco keeps its plain refusal", async () => {
    const gltf = JSON.stringify({ asset: { version: "2.0" }, extensionsRequired: ["KHR_draco_mesh_compression"] });
    await expect(parseModel(enc(gltf), ".gltf")).rejects.toThrow(/^This glTF needs KHR_draco_mesh_compression/);
  });
});
