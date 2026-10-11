<!-- Copied from the desktop K2 repo: src/renderer/assets/seti/ (+ NOTICE.md § Seti) -->
# Seti UI file icons (MIT)

The Files drawer and the file viewer header use the **Seti** icon font for
file-type glyphs, the same set desktop K2 uses (VS Code's default file icon
theme family).

| | |
|--|--|
| **What** | `seti.woff` here + the generated name/extension map `src/zen/fileIcons/setiData.ts` (dark colours only) |
| **Upstream** | [Seti UI](https://github.com/jesseweed/seti-ui) (Jesse Weed), packaged via VS Code `extensions/theme-seti` |
| **License** | **MIT** (Copyright 2014 Jesse Weed). Full text: `THIRD_PARTY_NOTICES.txt` in this folder |
| **K2 code** | Stays FSL-1.1-Apache-2.0. The MIT assets do not relicense the app. |
| **Not** | Not affiliated with Microsoft or Visual Studio Code. |

Folder icons are K2's own gold open/closed SVGs (desktop `FileTree.tsx`
`FolderIcon`), not Seti. Ship this notice with builds that include the font.
