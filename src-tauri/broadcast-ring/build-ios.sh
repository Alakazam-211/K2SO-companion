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
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${PLATFORM_NAME:-iphoneos}" in
  iphonesimulator) TRIPLE=aarch64-apple-ios-sim ;;
  *) TRIPLE=aarch64-apple-ios ;;
esac
cd "$HERE"
exec env -i HOME="$HOME" USER="${USER:-}" TMPDIR="${TMPDIR:-/tmp}" \
  PATH="$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  cargo build --locked --release --lib --target "$TRIPLE"
