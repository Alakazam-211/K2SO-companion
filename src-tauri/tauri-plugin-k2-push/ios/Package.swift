// swift-tools-version:5.5
// Package name/product/target MUST equal the crate name — the Tauri
// plugin build (`link_apple_library`) compiles this package under
// `CARGO_PKG_NAME` when targeting iOS.

import PackageDescription

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
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
