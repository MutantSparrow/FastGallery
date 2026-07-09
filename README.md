# Fast Gallery

Single-file, zero-dependency local image browser. Open an HTML file, point at a folder, get a fast masonry gallery with a canvas viewer, hierarchical folder navigation, prompt extraction, delete, and drag-and-drop.

## Features

- **Masonry grid** — virtualized. Only visible tiles live in the DOM, so 10k+ folders scroll smoothly.
- **Canvas viewer** — wheel zoom, drag pan, EXIF-oriented, downscaled preview by default with a `Full-res` button on demand, rotate, filmstrip, slideshow.
- **Prev / next in viewer** — `←` / `→` walk the filtered order. Wraps.
- **Hierarchical folder navigation** — breadcrumb path + subfolder chips. Drill down / up, `Recursive` toggle switches between "images in this folder only" and "images in the whole subtree".
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
- **Prompt extraction** — reads A1111 `parameters`, ComfyUI `prompt` graph, ComfyUI `workflow` (UI + API shapes), generic `prompt_*` PNG chunks, JPEG EXIF UserComment, and **Fooocus `log.html` sidecars** (per-folder). Cycles multiple prompts per image, copy to clipboard.
- **Favorites** — star tiles or press `F` in the viewer. Persisted per-folder in IndexedDB.
- **Copy path / folder** — `C` copies the image path, `Shift+C` copies the folder path (paste into Explorer's address bar to reveal).
- **Reopen last folder** — File System Access API + IndexedDB. One click on load (Chrome/Edge).
- **Fallback picker** — `<input webkitdirectory>` on Firefox and Safari. All features work; favorites become session-only.
- **ZIP export** — select several tiles → `Download`. Writes an uncompressed ZIP in-browser. 512 MB cap.
- **Loader feedback** — progress panel during folder scan and dimension reading.
- **Formats** — PNG, JPEG, WebP, GIF, AVIF, BMP.

## Usage

Open `fast-gallery.html` in a modern browser (Chrome / Edge / Firefox / Safari). Click **Open folder** or drop a folder onto the window. No server, no build, no install.

Note: **drag-and-drop of folders requires an `http://` origin**. Chrome blocks the FileSystem entries API on `file://` URLs. If you double-click the HTML, drag-and-drop of a *folder* will fail with an `EncodingError`. Serve locally instead:

```
python -m http.server 8000
```

Then open `http://localhost:8000/fast-gallery.html`.

### Shortcuts

**Viewer**

| key | action |
|-----|--------|
| `←` / `→` | Previous / next image |
| `P` | Prompt panel |
| `F` | Favorite |
| `C` | Copy image path |
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
