# PDF support — version 1.7.0

2026-11-06. PDFs are now discovered, shown in the grid and opened in the viewer, in both the HTML app and the desktop app. This feature release moves the version from 1.6.1 to 1.7.0. The tray menu's first entry, and the tray tooltip, now show the running version (`Fast Gallery v1.7.0`).

## Design

Approach chosen by the user: keep the single self-contained HTML without a bundled PDF renderer. Use the browser's or WebView2's own PDF viewer for documents, and native Windows rendering for desktop thumbnails.

| | HTML app | Desktop app |
|---|---|---|
| Discovery | `.pdf` added to `IMAGE_EXT_RE` (folder walk, drop, file-list fallback) | Same, plus shim filter and external-open arguments |
| Grid tile | Document card (shared SVG data URL) with filename | First page rendered by `Windows.Data.Pdf`, JPEG-cached like other thumbnails. Card fallback for password-protected or damaged files |
| Dimensions | First `/MediaBox` (with same-dictionary `/Rotate`) from the first 1 MB, else A4 portrait | First-page size from the runtime, rotation applied |
| Viewer | Built-in PDF viewer in an `<iframe>`, typed blob URL | Same viewer, asset-protocol URL, so no file bytes enter JS |
| Filmstrip | Card | First-page thumbnail, card fallback |
| Color filter | Skipped | From the rendered first page |
| Prompts / copy image | Skipped; Copy image explains why and points to path copy / download | Same |
| File association | — | `.pdf` added to Open-with / Default-apps capabilities (HKCU). Does not change the default PDF app |

Sizes are reported in points (`612×792 pt`) rather than pixels.

### Implementation notes

- `desktop/src-tauri/src/pdf.rs` wraps `StorageFile` → `PdfDocument` → first `PdfPage`. It renders straight to the requested thumbnail edge, so no full-size bitmap exists. Rendering still runs under `IMAGE_DECODE_LOCK` alongside other heavy decodes. Verbatim `\\?\` prefixes from canonicalized paths are stripped, because `StorageFile` rejects them. Each blocking-pool thread initializes WinRT once (multithreaded).
- The `windows` crate is pinned to 0.61, the version Tauri already resolves. Cargo.lock gains one dependency edge and no new crates.
- The viewer creates a fresh `<iframe>` per document and removes it on navigation or close. Reusing one frame would add session-history entries, so browser Back would step through earlier PDFs. Removing the frame also releases the document renderer. Owned blob URLs are revoked; asset URLs are not.
- Shim `File`s carry no MIME type, and an untyped blob would be offered as a download. `pdfObjectUrl` therefore always hands the frame an `application/pdf` blob.
- Tauri's asset protocol detects `%PDF` magic bytes and serves `application/pdf`, which WebView2's viewer requires.
- Video and PDF share `usesOwnControls(i)`. Canvas wheel/drag/click, the image context menu and the zoom/rotate keys stand aside for them.

### Known limits

- Once the document has focus, key presses go to the PDF viewer, so gallery shortcuts (including Escape and arrows) stop working. Click the viewer toolbar or outside the document to restore them. Cross-origin/plugin frames cannot forward keys.
- HTML-app dimensions fall back to A4 portrait when the page dictionary lives in a compressed object stream (common in PDF 1.5+). Tile aspect then may not match the page.
- No in-app page thumbnails beyond page 1, and no PDF text search across the gallery.
- PDF viewing depends on the host's built-in viewer. A browser with PDF viewing disabled (or set to "download PDFs") will show an empty frame or download the file.

## Verification

- 79 JavaScript tests passed, 8 of them new in `tests/pdf.test.cjs`. The new tests cover discovery gates in the HTML, shim, external-open and association lists. They also cover MediaBox parsing (rotation, offsets, malformed boxes), the head-only read, the A4 fallback, point labels, the browser card without file reads, and desktop native thumbnails with card fallback. Finally they check that prompt extraction skips PDFs, and that viewer frames are replaced per document with typed and revoked URLs. Existing harness stubs gained the new helpers. With `tests/version.test.cjs`, which requires all five version sources to agree, the total is 80.
- 11 native unit tests passed (1 manual test ignored). Two of them cover the tray label and require `tauri.conf.json` and `Cargo.toml` to agree. New tests write a synthetic PDF and render it through the real Windows runtime. They check page size in points, a bounded first-page render with correct color, JPEG thumbnails at the requested edge, rejection of non-PDF bytes, verbatim-prefix stripping and extension detection.
- Real Microsoft Edge (headless, DevTools protocol, synthetic PDF + PNG through the file-input fallback):
  - The PDF card tile showed the filename and `612×792 pt`.
  - Opening it rendered the document in Edge's PDF viewer with paging/zoom/search.
  - Arrow navigation to the PNG removed the frame and restored the canvas, and Escape closed the viewer.
  - `history.length` stayed constant, and no console errors appeared.
- Real Windows/WebView2 with the optimized desktop build, an isolated WebView2 profile and the synthetic PDF passed as the launch argument (the Open-with path):
  - The folder and the PDF opened directly, served from `asset.localhost`, and WebView2's viewer rendered the page.
  - After Escape, the grid tile showed the natively rendered first page (not the card), and no frames remained.
- Not verified: real-world PDFs (large, encrypted, object-stream, unusual page boxes), Firefox and Safari, and the association registration itself (tray → Register file associations was not run, to avoid changing this machine's registry).

## Build

[fast-gallery-v1.7.0.exe](../desktop/release/fast-gallery-v1.7.0.exe), 12,042,752 bytes, Windows FileVersion/ProductVersion 1.7.0. Companion build record: `desktop/release/fast-gallery-v1.7.0.build.json`.

SHA-256: `ca5013a95e41be3df07353c8f149916a1f6698c97839f47bc6a473b428f57fd6`.

Built with `npx tauri build --no-bundle` from `desktop`, with `RUSTFLAGS` remapping the user-profile and repository prefixes (`--remap-path-prefix=<profile>=~ --remap-path-prefix=<repo>=/fast-gallery`). Without remapping, the build embedded 188 cargo-registry paths containing the account folder. This binary has no account, project or host strings. It is an x64 GUI PE, and its PDB name is `fast_gallery.pdb`.

Checks on this exact binary:
- Windows UI Automation read the running tray icon as **Fast Gallery v1.7.0**. The tray menu's disabled first entry uses the same label.
- The WebView2 PDF check above passed.

An interim `fast-gallery-v1.6.1-pdf` build was replaced by this versioned release and removed. Earlier release executables are unchanged. `.gitignore`'s keep list still names only the usability and live-refresh builds.

After switching, quit the old tray instance and start this build. Its tray menu should read **Fast Gallery v1.7.0**. Then run **Register file associations** from it, which moves Windows to this executable and adds the `.pdf` Open-with entry.
