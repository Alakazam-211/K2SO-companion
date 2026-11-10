#!/usr/bin/env node
// Writes public/acknowledgements.txt, the notices the app shows in Settings →
// Acknowledgements: every npm and Rust package in the iOS and Android builds
// with the licence files from the package itself, plus the assets bundled
// by hand. Run with: npm run gen:notices (release.sh runs it too).
//
// It fails rather than ship a package it can't vouch for: an FSL or
// GPL-only licence, or Sew's FSL `sew-crypto` crate.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public/acknowledgements.txt");
const LICENSE_FILE = /^(un)?licen[cs]e|^copying|^notice|^copyright/i;
const TARGETS = ["aarch64-apple-ios", "aarch64-linux-android"];
const OWN_CRATES = new Set(["k2so-companion", "tauri-plugin-k2-push", "k2-broadcast-ring"]);
const read = (p) => readFileSync(p, "utf8");

// Licence files for packages that ship none, fetched once from upstream at
// the version's commit or tag: third-party-licenses/<name>-<version>/, with
// sources.tsv saying where each came from (and which upstream has none).
const UPSTREAM = join(ROOT, "third-party-licenses");
const upstreamRows = new Map(
  read(join(UPSTREAM, "sources.tsv"))
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split("\t"))
    .map(([name, version, , status, source]) => [`${name}@${version}`, { status, source }])
);
function upstreamFiles(name, version) {
  return licenseFiles(join(UPSTREAM, `${name.replace(/\//g, "__")}-${version}`));
}

/** The option taken from a dual licence: Apache-2.0, else Zlib. */
function optionTaken(license) {
  if (!/\bOR\b|\//.test(license)) return "";
  return /Apache-2\.0/.test(license) ? " (taken under Apache-2.0)" : /Zlib/.test(license) ? " (taken under Zlib)" : "";
}

const FORBIDDEN_LICENSE = /\b(FSL|BUSL|SSPL)\b|Functional Source/i;

const tidy = (s) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
const rule = (c = "=") => c.repeat(72);

function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ name: f, text: tidy(read(join(dir, f))) }))
    .filter((f) => f.text);
}

function refuse(name, why) {
  throw new Error(`gen-acknowledgements: ${name}: ${why}`);
}

/** Copyleft only when no permissive choice sits beside it. */
function checkLicense(name, license) {
  if (name === "sew-crypto") refuse(name, "this crate is FSL and must not ship");
  if (FORBIDDEN_LICENSE.test(license)) refuse(name, `not shippable: ${license}`);
  if (/\b[AL]?GPL/i.test(license) && !/\bOR\b|\//i.test(license)) refuse(name, `copyleft: ${license}`);
}

function npmRepo(dir) {
  if (!existsSync(join(dir, "package.json"))) return null;
  const r = JSON.parse(read(join(dir, "package.json"))).repository;
  return (typeof r === "string" ? r : r?.url) || null;
}

function npmPackages() {
  const lock = JSON.parse(read(join(ROOT, "package-lock.json")));
  const out = [];
  for (const [key, v] of Object.entries(lock.packages)) {
    if (!key || v.dev || v.devOptional || v.link) continue;
    const dir = join(ROOT, key);
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    let license = v.license;
    if (!license && existsSync(join(dir, "package.json"))) {
      const m = JSON.parse(read(join(dir, "package.json")));
      license = m.license?.type ?? m.license ?? m.licenses?.map((l) => l.type).join(" OR ");
    }
    out.push({ kind: "npm", name, version: v.version, license: license || "", files: licenseFiles(dir), repository: npmRepo(dir) });
  }
  return out;
}

function rustPackages() {
  const byId = new Map();
  for (const target of TARGETS) {
    const meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", target, "--offline"], {
        cwd: join(ROOT, "src-tauri"),
        maxBuffer: 1 << 28,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString()
    );
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    for (const node of meta.resolve.nodes) byId.set(node.id, pkgs.get(node.id));
  }
  const out = [];
  for (const p of byId.values()) {
    if (OWN_CRATES.has(p.name)) continue;
    const dir = dirname(p.manifest_path);
    let files = licenseFiles(dir);
    // A git dependency can keep its licence at the repository root. A root
    // licence that isn't the crate's declared one (K2's, FSL at that pin) is
    // left out.
    const m = /^(.*\/checkouts\/[^/]+\/[^/]+)\//.exec(dir + "/");
    if (!files.length && m && m[1] !== dir) {
      files = licenseFiles(m[1]).filter((f) => !FORBIDDEN_LICENSE.test(f.text));
    }
    out.push({ kind: "crate", name: p.name, version: p.version, license: p.license || "", files, authors: p.authors, repository: p.repository });
  }
  return out;
}

const pkgs = [...npmPackages(), ...rustPackages()]
  .map((p) => (p.files.length ? p : { ...p, files: upstreamFiles(p.name, p.version) }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.kind.localeCompare(b.kind));

const texts = new Map();
const unlisted = [];
for (const p of pkgs) {
  checkLicense(p.name, p.license);
  for (const f of p.files) {
    if (FORBIDDEN_LICENSE.test(f.text)) refuse(p.name, `${f.name} is an FSL-style licence`);
    const id = createHash("sha256").update(f.text).digest("hex");
    if (!texts.has(id)) texts.set(id, { text: f.text, users: new Set() });
    texts.get(id).users.add(`${p.name} ${p.version}`);
  }
  if (!p.files.length) unlisted.push(p);
  if (!p.license && !p.files.length) refuse(p.name, "no licence declared and no licence file");
}

const fontDir = join(ROOT, "src/assets/fonts");
const fontFiles = readdirSync(join(fontDir, "licenses")).sort();
const section = (title, body) => `${rule()}\n${title}\n${rule()}\n\n${body.trim()}\n`;

const parts = [
  "K2 is built with the open-source software and assets listed here.\nEach keeps its own licence, and those licences are reproduced below.\n",
  section("K2", read(join(ROOT, "LICENSE"))),
  section("Bundled: Seti UI file icons", read(join(ROOT, "src/assets/seti/THIRD_PARTY_NOTICES.txt"))),
  section("Bundled: LLM provider icons (Lobe Icons)", read(join(ROOT, "src/assets/llm/NOTICE.md"))),
  section("Bundled: terminal key tables, ported from Orca", read(join(ROOT, "src/lib/terminalKeys.ts")).split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")),
  section("Bundled: MesloLGM Nerd Font Mono", read(join(fontDir, "NOTICE.md"))),
  ...fontFiles.map((f) => section(`Font licence: ${f}`, read(join(fontDir, "licenses", f)))),
  section(
    "Packages",
    pkgs
      .map((p) => `${p.name} ${p.version} (${p.kind}): ${p.license || "see licence text"}${/MPL/.test(p.license) && p.repository ? `, source: ${p.repository}` : ""}`)
      .join("\n")
  ),
];

if (unlisted.length) {
  parts.push(
    section(
      "Packages whose licence is declared but ship no licence file",
      "The full text of each licence named here appears elsewhere on this page.\n\n" +
        unlisted
          .map((p) => {
            const checked = upstreamRows.get(`${p.name}@${p.version}`);
            return [
              `${p.name} ${p.version}: ${p.license}${optionTaken(p.license)}`,
              p.authors?.length ? p.authors.join(", ") : "",
              p.repository ? `source: ${p.repository}` : "",
              checked?.status === "none" ? `no licence file upstream either (checked ${checked.source})` : "",
            ]
              .filter(Boolean)
              .join(", ");
          })
          .join("\n")
    )
  );
}

const ordered = [...texts.values()].sort((a, b) => [...a.users][0].localeCompare([...b.users][0]));
for (const t of ordered) {
  parts.push(section(`Licence text for: ${[...t.users].sort().join(", ")}`, t.text));
}

writeFileSync(OUT, parts.join("\n") + "\n");
console.log(
  `gen-acknowledgements: ${pkgs.length} packages, ${texts.size} licence texts, ${unlisted.length} without a licence file → public/acknowledgements.txt`
);
for (const p of unlisted) console.log(`  no licence file: ${p.kind} ${p.name} ${p.version} (${p.license})`);
