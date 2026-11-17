#!/usr/bin/env bash
set -euo pipefail

# ─── DeepFilterNet3 weights for Sew's noise removal ───
#
# Sew's voice plugin (feature `dfn3`) runs DeepFilterNet3's low-latency
# model as Standard noise removal, with RNNoise as its automatic fallback.
# The app bundles the weights as a resource: tauri.ios.conf.json maps
# src-tauri/resources/dfn3/* to dfn3/ in the app's resource directory
# (K2.app/assets/dfn3/ on iOS), where the plugin looks by default.
#
# The 39 MB weights file is not in git (.gitignore). This script downloads
# sew-dfn3-<version>.tar.gz from Sew's public GitHub release, checks the
# asset's size and sha256, extracts it, checks every file's sha256, and puts
# the four files in src-tauri/resources/dfn3/. NOTICE, LICENSE-MIT and
# LICENSE-APACHE are committed too (the acknowledgements generator reads
# NOTICE); the copies from the tarball must match them.
#
# Usage:
#   scripts/fetch-dfn3.sh              fetch unless the files are already there and verified
#   scripts/fetch-dfn3.sh --force      fetch again
#   scripts/fetch-dfn3.sh --verify DIR only check the four files in DIR (e.g. the
#                                      archived K2.app/assets/dfn3); fetches nothing
#
# DFN3_TARBALL=<path> uses a local copy of the tarball instead of
# downloading (still size- and sha-checked). Exits non-zero on any mismatch;
# scripts/release.sh runs it before the build and --verify on the archive.

# The release that carries the weights' asset. Sew 0.10.3 (the plugin 0.8.1
# the app pins) checks the same weights (sew-noise's WEIGHTS_SHA256 is
# unchanged) and its release has no dfn3 asset, so this stays 0.10.2.
SEW_VERSION="0.10.2"
RELEASE_REPO="Alakazam-211/sew-releases"
ASSET="sew-dfn3-${SEW_VERSION}.tar.gz"
ASSET_URL="https://github.com/${RELEASE_REPO}/releases/download/v${SEW_VERSION}/${ASSET}"
ASSET_SHA256="153721fd5f9f33663da7d831b3b611adcb9ca9e65233a6128d94941ad48d6697"
ASSET_SIZE=36353582
WEIGHTS="dfn3_ll.nnef.tar"
# The four files and their sha256 (the weights' value is Sew's published
# one; the text files' are those in the tarball above).
FILES=(
  "$WEIGHTS b6e52c0bc66b82e42e3403d22cdd3b847143026d6a41cc4380a97b044f7766af"
  "NOTICE 2df40825f5f3dba0dba9a40fcb195a048a94c36f99aa32642411da7e47d763f1"
  "LICENSE-MIT 24e6bb09c928af8d8e56268082f87413247ce36b39dd5d33add2f9893968065e"
  "LICENSE-APACHE 1eaee808c5fb6b4e895ba30425285a5cdc5dd25bba2cd230f264c2200c331aec"
)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$PROJECT_DIR/src-tauri/resources/dfn3"

fail() {
  echo "fetch-dfn3: $*" >&2
  exit 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# verify_dir DIR: every one of the four files is there with its sha256.
verify_dir() {
  local dir="$1" entry name want got
  for entry in "${FILES[@]}"; do
    name="${entry%% *}"
    want="${entry##* }"
    [ -f "$dir/$name" ] || { echo "fetch-dfn3: missing $dir/$name" >&2; return 1; }
    got="$(sha256_of "$dir/$name")"
    if [ "$got" != "$want" ]; then
      echo "fetch-dfn3: sha256 mismatch for $dir/$name" >&2
      echo "  expected $want" >&2
      echo "  got      $got" >&2
      return 1
    fi
  done
}

FORCE=""
case "${1:-}" in
  --verify)
    [ -n "${2:-}" ] || fail "--verify needs a directory"
    verify_dir "$2" || exit 1
    echo "fetch-dfn3: verified $2"
    exit 0
    ;;
  --force) FORCE=1 ;;
  "") ;;
  *) fail "unknown argument: $1 (use --force or --verify DIR)" ;;
esac

if [ -z "$FORCE" ] && verify_dir "$DEST" 2>/dev/null; then
  echo "fetch-dfn3: $DEST already verified (Sew $SEW_VERSION)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fetch-dfn3.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
TARBALL="$WORK/$ASSET"

if [ -n "${DFN3_TARBALL:-}" ]; then
  [ -f "$DFN3_TARBALL" ] || fail "DFN3_TARBALL=$DFN3_TARBALL not found"
  cp "$DFN3_TARBALL" "$TARBALL"
else
  echo "fetch-dfn3: downloading $ASSET (Sew $SEW_VERSION release)..."
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh release download "v$SEW_VERSION" -R "$RELEASE_REPO" -p "$ASSET" -D "$WORK" \
      || fail "gh release download failed"
  else
    curl -fsSL --retry 3 -o "$TARBALL" "$ASSET_URL" || fail "download failed: $ASSET_URL"
  fi
fi

SIZE="$(wc -c <"$TARBALL" | tr -d ' ')"
[ "$SIZE" = "$ASSET_SIZE" ] || fail "$ASSET is $SIZE bytes, expected $ASSET_SIZE"
GOT="$(sha256_of "$TARBALL")"
[ "$GOT" = "$ASSET_SHA256" ] || fail "sha256 mismatch for $ASSET: expected $ASSET_SHA256, got $GOT"

# Only the expected entries: no other paths, nothing outside dfn3/.
LISTING="$(tar -tzf "$TARBALL" | sed 's|/$||' | sort | tr '\n' ' ')"
EXPECTED="$(printf '%s\n' dfn3 "dfn3/$WEIGHTS" dfn3/LICENSE-APACHE dfn3/LICENSE-MIT dfn3/NOTICE | sort | tr '\n' ' ')"
[ "$LISTING" = "$EXPECTED" ] || fail "unexpected tarball contents: $LISTING"

mkdir -p "$WORK/x"
tar -xzf "$TARBALL" -C "$WORK/x"
verify_dir "$WORK/x/dfn3" || fail "the extracted files don't match the pinned sha256s"

mkdir -p "$DEST"
for entry in "${FILES[@]}"; do
  name="${entry%% *}"
  cp "$WORK/x/dfn3/$name" "$DEST/$name.part"
  mv -f "$DEST/$name.part" "$DEST/$name"
done
verify_dir "$DEST" || fail "the installed files don't verify"
echo "fetch-dfn3: installed and verified $DEST (Sew $SEW_VERSION, $WEIGHTS)"
