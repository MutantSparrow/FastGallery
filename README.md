# Fast Gallery

Local image browser. Two flavors from one codebase:

- **`fast-gallery.html`** — single-file HTML. Open in any modern browser, point at a folder, done. No install.
- **Fast Gallery desktop** (Windows) — Tauri 2 wrapper around the same HTML. Native filesystem I/O, Rust-side thumbnails, file associations, tray + global shortcut, single-instance argv forwarding for real double-click-image → viewer flow.

Fast masonry gallery, canvas viewer, hierarchical folder navigation, prompt extraction (A1111 / ComfyUI / [JustRayzist](https://github.com/MutantSparrow/JustRayzist) / Fooocus `log.html` sidecars), delete, drag-and-drop.

## Screenshots

![Masonry gallery grid with the Gallery controls panel open: column slider, prompt and color scans, sorting, and filters](docs/assets/gallery-controls.webp)

<p align="center">
  <img src="docs/assets/viewer-prompt.webp" width="520" alt="Viewer showing a 2048×3072 image with the prompt panel open below it, displaying the extracted generation prompt">
</p>

## Compact controls

The gallery keeps Open folder, filename search, selection, and **Controls** in a compact toolbar. Open **Controls** for columns, metadata scans, sorting, filters, subfolder inclusion, and random browsing. The button shows the number of active filters even when the panel is closed. Selection downloads and deletion remain in the toolbar when items are selected.

The viewer uses the same **Controls** panel in standard and fullscreen modes, with icon actions grouped into playback, image actions, and view options. Hover an icon for its label and shortcut. The orange **Gallery** button beside **Controls** returns to browsing. Click outside a panel to dismiss it, or press Escape to close it and return focus to its button.

## Features

- **PDF documents** — PDFs appear in the grid beside images. The desktop app shows a rendered first page, produced by Windows' built-in PDF engine and cached like other thumbnails. The HTML app, which has no PDF renderer, shows a document card with the filename. Opening a PDF uses the browser's or WebView2's own PDF viewer, with paging, zoom, search and print. Sizes are shown in points. Prompt extraction and image copying skip PDFs; in the HTML app they also have no color signature. Click outside the document, for example on the viewer toolbar, before using gallery shortcuts again.
- **Video hover previews** — hover over an MP4 or WebM tile to play a muted, looping preview. Leaving the tile restores its poster. Only one preview plays at a time; opening the viewer, scrolling, or leaving the app stops it. Click the tile for full playback controls.
- **Masonry grid** — virtualized, with 1–12 columns. Visible thumbnails remain mounted as discovery updates the layout.
- **Canvas viewer** — wheel zoom below fit size, drag pan with corners movable to viewport center, EXIF orientation, bounded preview by default with higher resolution on demand, rotation, optional filmstrip (closed initially), and slideshow with an editable 0.25–3600 second interval.
- **Fullscreen** — native window fullscreen on desktop; browser fullscreen in the HTML app.
- **Prev / next in viewer** — `←` / `→` walk the filtered order. Wraps.
- **Hierarchical folder navigation** — breadcrumb path + subfolder chips. Drill down / up; `Include subfolders` starts off and can be enabled to browse the whole subtree.
- **Drag-and-drop** — drop a folder (or images) anywhere on the window. Uses the File System Access API when available, falls back to the legacy Entries API.
- **Delete** — trashcan button on tiles, `Delete` button in the viewer, `Delete selected` in multi-select. Confirm modal shows what will be removed. On FSA folders, files are permanently deleted from disk; otherwise they are removed from the gallery only.
- **Sort** — name, date, size, width, height, area, random. Direction toggle.
- **Filters** —
  - filename substring
  - format checkboxes (per extension present in the folder)
  - orientation (portrait / landscape / square)
  - dominant color (13 hue buckets + neutral, computed from thumbnails)
  - prompt keyword (AND-match against extracted metadata)
  - favorites only
- **Prompt extraction** — reads A1111 `parameters`, ComfyUI `prompt` graph, ComfyUI `workflow` (UI + API shapes), [JustRayzist](https://github.com/MutantSparrow/JustRayzist) `prompt` and wildcard-expanded `prompt_effective` chunks, generic `prompt_*` PNG chunks, JPEG EXIF UserComment, and **Fooocus `log.html` sidecars** (per-folder). Cycles multiple prompts per image, copy to clipboard.
- **Favorites** — star tiles or press `F` in the viewer. Persisted per-folder in IndexedDB.
- **Copy image** — `C` / `Ctrl+C` copies source-sized PNG pixels without viewport bars, independently of zoom and pan. Still images up to 64 million pixels and a 16,384 px edge are supported; use Download original for larger sources.
- **Copy path / folder** — `Alt+C` copies the image path, `Shift+C` copies the folder path (paste into Explorer's address bar to reveal).
- **Reopen last folder** — File System Access API + IndexedDB. One click on load (Chrome/Edge).
- **Fallback picker** — `<input webkitdirectory>` on Firefox and Safari. All features work; favorites become session-only.
- **ZIP export** — select several tiles → `Download`. Writes an uncompressed ZIP in-browser. 512 MB cap.
- **Loader feedback** — progress panel during folder scan and dimension reading.
- **Formats** — PNG, JPEG, WebP, GIF, AVIF, BMP, MP4, WebM and PDF, subject to browser codec and PDF viewer support. Native AVIF thumbnails/previews remain incomplete.

## Usage

Open `fast-gallery.html` in a modern browser (Chrome / Edge / Firefox / Safari). Click **Open folder** or drop a folder onto the window. No server, no build, no install.

Note: **drag-and-drop of folders requires an `http://` origin**. Chrome blocks the FileSystem entries API on `file://` URLs. If you double-click the HTML, drag-and-drop of a *folder* will fail with an `EncodingError`. Serve locally instead:

```
python -m http.server 8000
```

Then open `http://localhost:8000/fast-gallery.html`.

## Desktop app (Windows)

Tauri 2 wrapper that eliminates browser sandbox friction. `desktop/` in the repo.

### Extras vs. the plain HTML

- Native folder picker — no FSA permission prompt.
- Rust thumbnail service: downscaled JPEG thumbs with on-disk cache. Heavy image decodes run one at a time, with viewer requests ahead of queued thumbnails.
- Header-only dimension probe, header-only metadata read (2 MB slice). Prompt prefetch never ships pixels.
- Large-image previews: supported large images are resized in Rust before entering the webview. Cached thumbnails appear while the larger preview loads; navigating away cancels queued work and discards obsolete results. Normal previews use at most 16 million pixels; the on-demand higher-resolution view is capped at 96 million pixels and a 16,384px edge.
- Real absolute paths in `Copy path` / `Copy folder path`.
- System tray, close-to-tray. Global shortcut `Ctrl+Alt+G` to toggle window. The tray menu's first line (and the tray tooltip) shows the running version, e.g. `Fast Gallery v1.7.0`.
- Windows file association: `Open with Fast Gallery` on `.png/.jpg/.jpeg/.webp/.gif/.bmp/.avif/.mp4/.webm/.pdf` (Settings → Default apps → pick Fast Gallery to promote to default). Registering does not replace your default PDF app.
- PDF first-page thumbnails rendered natively through Windows.Data.Pdf, with no bundled renderer. Password-protected or damaged PDFs fall back to the document card.
- Single-instance forwarding: double-clicking a second image while the app is running jumps that window to the new file.
- Dynamic tab title reflecting state (working, scanning, viewing, browsing).

Background dimension, prompt, and color scans pause while the viewer is open. Large animated GIF/WebP files use a static preview to keep viewing within the pixel budget; smaller animations keep playing normally. Original files are unchanged. Native decoding still needs memory for the source image, so extremely large or unsupported files may show an unavailable-preview message.

Regression checks: `node --test tests/*.test.cjs` from the repository root. See [working notes](docs/PROJECT_NOTES.md) for architecture and remaining audit items, [performance work](docs/PERFORMANCE_WORK.md) for native limits, and [usability work](docs/USABILITY_WORK.md) for the latest behavior and verification scope.

The latest portable build and its checksum record are in `desktop/release/fast-gallery-v1.7.0.exe` and its adjacent `.build.json`. Version 1.7.0 adds PDF support (see [PDF work](docs/PDF_WORK.md)) on top of the 1.6.1 live-refresh build. Release builds are numbered by version; check the tray menu's first line to confirm which one is running. Quit any running tray instance before launching a replacement executable. Older executables cannot read the upgraded favorites database; retaining an old EXE does not roll back that database.

After switching portable builds, use **Register file associations** in the new build's tray menu. Windows retains the previous executable path until this registration is updated. An older build opening the upgraded database can fail with a blank gallery; use the current build without clearing favorites. See [opening diagnostics](docs/OPENING_WORK.md).

### Build

Prereqs: Rust stable (MSVC toolchain), Node 20+, Windows 10/11 with WebView2 runtime (present on Windows 11 by default).

```
cd desktop
npm install
npm run tauri build
```

Output:

- `desktop/src-tauri/target/release/fast-gallery.exe` — portable binary (~11 MB).
- `desktop/src-tauri/target/release/bundle/nsis/*.exe` — NSIS installer.

Dev cycle: `npm run tauri dev`.

### Install from source

1. Run `npm run tauri build`.
2. Copy `fast-gallery.exe` anywhere on disk.
3. First launch → tray menu → **Register file associations** (writes HKCU only, no admin). Fast Gallery now shows up in Settings → Apps → Default apps.

Uninstall the associations from the tray menu.

### Shortcuts

**Viewer**

| key | action |
|-----|--------|
| `←` / `→` | Previous / next image |
| `Shift+←` / `Shift+→` | Cycle prompts (when panel open) |
| `X` | Open a random image |
| `Shift+X` | Toggle shuffle slideshow |
| `P` | Prompt panel |
| `F` | Favorite |
| `C` / `Ctrl+C` | Copy image pixels |
| `Alt+C` | Copy image path |
| `Shift+C` | Copy folder path |
| `+` / `-` | Zoom in / out |
| `0` / `1` | Fit / 1:1 |
| `R` / `Shift+R` | Rotate cw / ccw |
| `S` | Slideshow |
| `T` | Filmstrip |
| `Del` | Delete image |
| `Esc` | Close panel, then viewer |

**Grid**

| key | action |
|-----|--------|
| `Ctrl+A` | Select all in view |
| `Ctrl+Shift+A` | Clear selection |
| `Shift+Click` | Range select |
| `X` | Open a random image |
| `Shift+X` | Toggle shuffle slideshow |
| `Del` | Delete selection |
| `Esc` | Clear selection / exit select mode |
| `?` | Toggle shortcut help |

## Fooocus prompt sidecars

Fooocus writes a `log.html` next to each day's images with prompt, negative prompt, model, LoRA, seed, and settings. Fast Gallery indexes any `log.html` found during folder scan and merges those entries into the prompt panel for the matching images. Works alongside PNG/JPEG metadata — if both are present, the sidecar's prompt is shown first, then embedded metadata, then the sidecar's technical fields.

## Browser support

| feature | Chrome / Edge | Firefox | Safari |
|---------|:-:|:-:|:-:|
| grid, viewer, ZIP, prompt extraction | ✅ | ✅ | ✅ |
| reopen last folder | ✅ | — | — |
| persistent favorites | ✅ | session-only | session-only |
| delete file from disk | ✅ (FSA) | — (gallery only) | — (gallery only) |
| WebP / AVIF thumbnails | ✅ | ✅ | ✅ (AVIF requires 16+) |

## Privacy

Runs entirely in-browser. No network requests. No telemetry. Nothing leaves the machine. The File System Access handle and favorites list are stored in IndexedDB, scoped to the file's origin — clearing site data forgets them.

## License

MIT — see `LICENSE`.
