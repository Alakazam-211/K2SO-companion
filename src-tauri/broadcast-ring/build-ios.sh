#!/bin/sh
# K2Broadcast's "Build Frame Ring" phase (project.yml): kessel-frame-ring's
# static library for the SDK Xcode is building, always in release.
#   iphoneos         → target/aarch64-apple-ios/release/libk2_broadcast_ring.a
#   iphonesimulator  → target/aarch64-apple-ios-sim/release/libk2_broadcast_ring.a
# The extension's LIBRARY_SEARCH_PATHS point at the same folders.
#
# A clean environment for cargo: Xcode's (SDKROOT, the deployment targets,
# its compilers) would point the host build scripts at the iOS SDK. rustup's
# toolchain (rust-toolchain.toml) has the iOS targets; Homebrew's rust does not.
# rustup's proxies are in ~/.cargo/bin on a dev Mac. A K2 compute node keeps
# them elsewhere (on PATH, with RUSTUP_HOME and CARGO_HOME set): use the
# rustup on PATH then and keep those two (not CARGO_TARGET_DIR: the extension
# links from this folder's target/).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${PLATFORM_NAME:-iphoneos}" in
  iphonesimulator) TRIPLE=aarch64-apple-ios-sim ;;
  *) TRIPLE=aarch64-apple-ios ;;
esac
CARGO_BIN="$HOME/.cargo/bin"
if [ ! -x "$CARGO_BIN/cargo" ] && command -v rustup >/dev/null 2>&1; then
  CARGO_BIN="$(dirname "$(command -v rustup)")"
fi
cd "$HERE"
exec env -i HOME="$HOME" USER="${USER:-}" TMPDIR="${TMPDIR:-/tmp}" \
  ${CARGO_HOME:+CARGO_HOME="$CARGO_HOME"} ${RUSTUP_HOME:+RUSTUP_HOME="$RUSTUP_HOME"} \
  PATH="$CARGO_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  cargo build --locked --release --lib --target "$TRIPLE"
