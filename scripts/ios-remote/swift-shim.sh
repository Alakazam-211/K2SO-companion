#!/bin/sh
# `swift` for a K2 compute job on a Mac (scripts/ios-remote-build.sh puts it
# first on the PATH cargo's build scripts see, as .../swift).
#
# SwiftPM compiles each Package.swift (and runs build plugins) inside its own
# sandbox-exec. A compute job already runs inside the node's Seatbelt
# sandbox, and macOS refuses a sandbox inside a sandbox:
#   sandbox-exec: sandbox_apply: Operation not permitted
#   error: 'ios-api': Invalid manifest
# (tauri's and its plugins' build scripts run `swift build` through
# swift-rs). The outer sandbox still holds, so SwiftPM's is turned off:
# --disable-sandbox right after the subcommands that take it. Everything
# else goes to the real swift unchanged.
case "${1:-}" in
  build|package|run|test)
    sub="$1"; shift
    exec /usr/bin/xcrun swift "$sub" --disable-sandbox "$@" ;;
  *)
    exec /usr/bin/xcrun swift "$@" ;;
esac
