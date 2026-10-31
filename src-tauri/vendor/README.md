# Vendored crates

## tauri-plugin-http 2.5.8 (patched)
Upstream (2.5.8, and still 2.8.0) builds a new `reqwest` client for every `fetch`, so the phone never reuses a
connection: every request pays a fresh TCP + TLS handshake through the K2 tunnel. The patch, in
`tauri-plugin-http/src/commands.rs` between the "K2 Companion patch" markers, shares one keep-alive client per
(connect timeout, redirect limit) for requests without a proxy or dangerous settings. Settings come from K2
(2026-10-31):
- HTTP/1.1 only (the tunnel offers ALPN http/1.1 only);
- idle connections close after 50 s (the daemon closes them at 60 s);
- up to 6 idle connections per host;
- TCP_NODELAY on.

Wired in by `[patch.crates-io]` in `src-tauri/Cargo.toml`. On a plugin upgrade, re-apply the patch to the new
version (or drop it if upstream reuses clients) and keep the JS package `@tauri-apps/plugin-http` on a matching
version.
