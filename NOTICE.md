# NOTICE

**K2** (K2 Companion), the phone app for K2 by Alakazam Labs.
Copyright 2025-2026 Alakazam Labs.

## Licensing

K2 Companion is licensed under the **MIT License**, from 4.2.2 on. See
[LICENSE](LICENSE). Releases up to and including 4.2.1 were licensed under
FSL-1.1-ALv2 and stay under it; each of those releases becomes available
under Apache 2.0 two years after its release.

## Trademarks

"K2 by Alakazam Labs" and the K2 logo are trademarks of Alakazam Labs. The
MIT License does not grant trademark rights.

## In the app

Settings → Acknowledgements shows `public/acknowledgements.txt`: every npm
and Rust package in the iOS and Android builds with its licence, and the
assets below. `npm run gen:notices` regenerates it.

## Third-party assets and code in this repository

| What | Where | Licence |
|--|--|--|
| MesloLGM Nerd Font Mono (Nerd Fonts 3.4.0, unmodified) | `src/assets/fonts/`, see its `NOTICE.md` and `licenses/` | Meslo: Apache-2.0. Nerd Fonts: MIT. Glyphs: each set's own (CC BY 4.0, SIL OFL 1.1, Apache-2.0, MIT) |
| Seti UI file icons | `src/assets/seti/` | MIT |
| LLM provider icons (Lobe Icons) | `src/assets/llm/` | MIT; the brand marks stay their owners' trademarks |
| Terminal key tables, ported from Orca | `src/lib/terminalKeys.ts` | MIT (Lovecast Inc.); header kept |
| wry and tauri-plugin-http, patched | `src-tauri/vendor/`, see its `README.md` | Apache-2.0 OR MIT |
| Sew's call kit and client packages | `vendor/sew-kit/` | MIT OR Apache-2.0 |
| Sew's native voice crates | Cargo git dependency (`sew-crates`) | MIT OR Apache-2.0; `sew-lk-compat` and `sew-lkproto` are Apache-2.0, with code ported from or generated from LiveKit (Apache-2.0, Copyright LiveKit, Inc.) |
| kessel-audio, kessel-frame-ring, kessel-video | Cargo dependencies | MIT OR Apache-2.0 |
| Gradle wrapper | `src-tauri/gen/android/gradlew*` | Apache-2.0 |

MPL-2.0 packages (`cssparser`, `cssparser-macros`, `selectors`,
`dtoa-short`, `option-ext`, through Tauri; `dompurify` is taken under
Apache-2.0) are used unmodified. Their source is at the addresses listed
in the Acknowledgements.

These do not relicense K2 Companion, and its MIT License does not relicense them.
