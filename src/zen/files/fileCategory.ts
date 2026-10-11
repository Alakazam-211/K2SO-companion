// Port of desktop `FileViewerPane/fileCategory.ts`: extension → viewer.
// Pure (no React, no API) so it unit-tests without the lazy viewers.
// The phone is view-only: no Preview | Edit, only Preview | Source.

export type FileCategory =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "docx"
  | "csv"
  | "audio"
  | "video"
  | "zip"
  | "mermaid"
  | "diagram"
  | "cad2d"
  | "model3d"
  | "binary"
  | "json"
  | "text";

export const MARKDOWN_EXTS = [".md", ".markdown", ".mdx"];
export const HTML_EXTS = [".html", ".htm"];
export const IMAGE_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".heic",
  ".avif",
  ".tif",
  ".tiff",
];
export const PDF_EXTS = [".pdf"];
export const DOCX_EXTS = [".docx", ".doc"];
export const CSV_EXTS = [".csv", ".tsv"];
export const AUDIO_EXTS = [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"];
export const VIDEO_EXTS = [".mp4", ".webm", ".mov", ".mkv"];
export const ZIP_EXTS = [".zip"];
export const MERMAID_EXTS = [".mermaid", ".mmd"];
/** Diagram sources with no client renderer (desktop parity). */
export const DIAGRAM_EXTS = [".drawio", ".dio", ".puml", ".plantuml", ".dot", ".gv"];
/** 2D CAD drawings: parsed and drawn as SVG (ASCII DXF only). */
export const CAD2D_EXTS = [".dxf"];
/** 3D meshes: three.js in a WebGL canvas. `.gltf` previews only when
 *  its buffers are embedded (data: URIs); `.glb` is self-contained. */
export const MODEL3D_EXTS = [".stl", ".obj", ".3mf", ".ply", ".glb", ".gltf"];
/** Phone-only split of desktop "text": pretty-printed before highlighting. */
export const JSON_EXTS = [".json"];
export const BINARY_EXTS = [
  ".wasm",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".o",
  ".a",
  ".lib",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pyc",
  ".pyo",
  ".pdb",
  ".dat",
];

export function getFileExtension(filePath: string): string {
  const name = filePath.split("/").pop() || filePath;
  const match = name.toLowerCase().match(/(\.[^.]+)$/);
  return match ? match[1] : "";
}

export function getFileCategory(filePath: string): FileCategory {
  const ext = getFileExtension(filePath);
  if (MARKDOWN_EXTS.includes(ext)) return "markdown";
  if (HTML_EXTS.includes(ext)) return "html";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (PDF_EXTS.includes(ext)) return "pdf";
  if (DOCX_EXTS.includes(ext)) return "docx";
  if (CSV_EXTS.includes(ext)) return "csv";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (ZIP_EXTS.includes(ext)) return "zip";
  if (MERMAID_EXTS.includes(ext)) return "mermaid";
  if (DIAGRAM_EXTS.includes(ext)) return "diagram";
  if (CAD2D_EXTS.includes(ext)) return "cad2d";
  if (MODEL3D_EXTS.includes(ext)) return "model3d";
  if (BINARY_EXTS.includes(ext)) return "binary";
  if (JSON_EXTS.includes(ext)) return "json";
  return "text";
}

/** Categories that load bytes (`fs/read-binary`), never `fs/read-file`. */
export function isBinaryPreviewCategory(category: FileCategory): boolean {
  return (
    category === "image" ||
    category === "pdf" ||
    category === "docx" ||
    category === "audio" ||
    category === "video" ||
    category === "zip" ||
    category === "model3d" ||
    category === "binary"
  );
}

/** Rendered views that also offer the raw source (desktop's toggle set,
 *  minus image: raw image bytes are not text). */
export function supportsSourceToggle(category: FileCategory): boolean {
  return (
    category === "markdown" ||
    category === "html" ||
    category === "csv" ||
    category === "mermaid" ||
    category === "cad2d"
  );
}

const MEDIA_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

/** MIME for <audio>/<video> from the path extension. */
export function mediaMimeFromPath(path: string): string {
  const ext = getFileExtension(path).replace(/^\./, "");
  return MEDIA_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** True when the path is tab-separated (`.tsv`). */
export function isTsvPath(filePath: string): boolean {
  return getFileExtension(filePath) === ".tsv";
}
