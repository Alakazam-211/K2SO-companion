// swift-tools-version:5.5
// Package name/product/target MUST equal the crate name — the Tauri
// plugin build (`link_apple_library`) compiles this package under
// `CARGO_PKG_NAME` when targeting iOS.

import Foundation
import PackageDescription

// The app build (cargo → swift-rs) runs `swift build` on every target, for
// iOS, in release for the store: the macOS checks stay out of it.
let forApp = ProcessInfo.processInfo.environment["CARGO_PKG_NAME"] != nil

let package = Package(
  name: "tauri-plugin-k2-push",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-k2-push",
      type: .static,
      targets: ["tauri-plugin-k2-push"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-k2-push",
      dependencies: [
        .byName(name: "Tauri"),
        "K2VideoFrames",
      ],
      path: "Sources"),
    // PiP frame wrapping, no UIKit: the plugin uses it, and so does the
    // macOS check (`swift run PiPCheck`).
    .target(
      name: "K2VideoFrames",
      path: "VideoFrames"),
  ] + (forApp ? [] : [
    .executableTarget(
      name: "PiPCheck",
      dependencies: ["K2VideoFrames"],
      path: "PiPCheck"),
    // The broadcast extension's frame rules (K2Broadcast compiles the same
    // file itself, from project.yml): `swift run BroadcastCheck`.
    .target(
      name: "K2BroadcastFrames",
      path: "BroadcastFrames"),
    .executableTarget(
      name: "BroadcastCheck",
      dependencies: ["K2BroadcastFrames"],
      path: "BroadcastCheck"),
  ])
)
