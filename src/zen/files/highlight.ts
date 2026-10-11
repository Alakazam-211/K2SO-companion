// Shiki, loaded on first use (desktop `CodeHighlighter.tsx`). The import
// is dynamic so the grammar/theme/wasm chunks stay out of the main chunk.

/** Desktop's theme. */
export const SHIKI_THEME = "github-dark-default";

/** Above this, highlighting stalls a phone: show plain text instead. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  vue: "vue", svelte: "svelte", astro: "astro",
  json: "json", jsonc: "jsonc", json5: "json5",
  yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  csv: "csv", ini: "ini", properties: "ini",
  rs: "rust", go: "go", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  zig: "zig", swift: "swift", m: "objective-c",
  py: "python", rb: "ruby", lua: "lua", perl: "perl", pl: "perl",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  ps1: "powershell", psm1: "powershell",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  groovy: "groovy", gradle: "groovy",
  cs: "csharp", fs: "fsharp", vb: "vb",
  md: "markdown", mdx: "mdx", tex: "latex", rst: "rst",
  dockerfile: "dockerfile", tf: "terraform", hcl: "hcl",
  nginx: "nginx", graphql: "graphql", gql: "graphql",
  prisma: "prisma", proto: "proto",
  sql: "sql", r: "r", dart: "dart", elixir: "elixir", ex: "elixir",
  exs: "elixir", erl: "erlang", hs: "haskell", clj: "clojure",
  lisp: "lisp", rkt: "scheme", ml: "ocaml", nim: "nim",
  php: "php", twig: "twig",
  makefile: "makefile", cmake: "cmake",
  diff: "diff", patch: "diff", log: "log",
  env: "dotenv",
  mermaid: "mermaid", mmd: "mermaid", dot: "dot", gv: "dot",
  puml: "plantuml", plantuml: "plantuml", drawio: "xml", dio: "xml",
};

const FILENAME_TO_LANG: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  "CMakeLists.txt": "cmake",
  Gemfile: "ruby",
  Rakefile: "ruby",
  Vagrantfile: "ruby",
  Justfile: "just",
  ".editorconfig": "ini",
  ".eslintrc": "json",
  ".prettierrc": "json",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
};

/** Shiki language id for a path, or null for plain text. Not checked
 *  against the bundle here: that would import shiki. */
export function detectLanguage(filePath: string): string | null {
  const name = filePath.split("/").pop() || "";
  if (FILENAME_TO_LANG[name]) return FILENAME_TO_LANG[name];
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  const parts = name.split(".");
  if (parts.length < 2) return null;
  return EXT_TO_LANG[parts.pop()!.toLowerCase()] ?? null;
}

/** Fence info string → Shiki language (markdown code blocks). */
export function fenceLanguage(lang: string): string | null {
  const l = lang.toLowerCase().trim();
  const aliases: Record<string, string> = {
    js: "javascript", ts: "typescript", py: "python", rb: "ruby",
    sh: "bash", shell: "bash", zsh: "bash", yml: "yaml",
    cs: "csharp", "c++": "cpp", objc: "objective-c",
  };
  return aliases[l] ?? (l || null);
}

/** Highlighted HTML, or null when the language is unknown or shiki fails
 *  (the caller keeps its plain-text fallback). */
export async function highlightToHtml(code: string, lang: string | null): Promise<string | null> {
  if (!lang || code.length > HIGHLIGHT_MAX_CHARS) return null;
  try {
    const shiki = await import("shiki");
    if (!(lang in shiki.bundledLanguages)) return null;
    return await shiki.codeToHtml(code, { lang, theme: SHIKI_THEME });
  } catch {
    return null;
  }
}
