# Fast Gallery

Single-file, zero-dependency local image browser. Open an HTML file, point at a folder, get a fast masonry gallery with a canvas viewer, sort/filter, favorites, and Stable Diffusion prompt extraction.

## Features

- **Masonry grid** — virtualized. Only visible tiles live in the DOM, so 10k+ folders scroll smoothly.
- **Canvas viewer** — wheel zoom, drag pan, EXIF-oriented, downscaled preview by default with a `Full-res` button on demand.
- **Prev / next in viewer** — `←` / `→` walk the filtered order. Wraps.
- **Sort** — name, date, size, width, height, area, random. Direction toggle.
- **Filters** —
  - filename substring
  - format checkboxes (per extension present in the folder)
  - orientation (portrait / landscape / square)
  - dominant color (13 hue buckets + neutral, computed from thumbnails)
  - prompt keyword (AND-match against extracted metadata)
  - favorites only
- **Prompt extraction** — reads A1111 `parameters`, ComfyUI `prompt` graph, ComfyUI `workflow` (both UI and API shapes), generic `prompt_*` PNG chunks, JPEG EXIF UserComment. Cycles multiple prompts per image, copy to clipboard.
- **Favorites** — star tiles or press `F` in the viewer. Persisted per-folder in IndexedDB.
- **Reopen last folder** — File System Access API + IndexedDB. One click on load (Chrome/Edge).
- **Fallback picker** — `<input webkitdirectory>` on Firefox and Safari. All features work; favorites become session-only.
- **ZIP export** — select several tiles → `Download selected (zip)`. Writes an uncompressed ZIP in-browser. 512 MB cap.
- **Formats** — PNG, JPEG, WebP, GIF, AVIF, BMP.

## Usage

Open `fast-gallery.html` in a modern browser (Chrome/Edge/Firefox/Safari). Click **Open folder**. That's it — no server, no build, no install.

### Shortcuts

| key | action |
|-----|--------|
| `←` / `→` | prev / next image (viewer) |
| `P` | toggle prompt panel |
| `←` / `→` | cycle prompts (when panel open) |
| `F` | toggle favorite |
| `C` | copy path |
| `Esc` | hide panel, then close viewer |
| `?` | toggle shortcut help |

## Browser support

| feature | Chrome / Edge | Firefox | Safari |
|---------|:-:|:-:|:-:|
| grid, viewer, ZIP, prompt extraction | ✅ | ✅ | ✅ |
| reopen last folder | ✅ | — | — |
| persistent favorites | ✅ | session-only | session-only |
| WebP / AVIF thumbnails | ✅ | ✅ | ✅ (AVIF requires 16+) |

## Privacy

Runs entirely in-browser. No network requests. No telemetry. Nothing leaves the machine. The File System Access handle and favorites list are stored in IndexedDB, scoped to the file's origin — clearing site data forgets them.

## License

MIT — see `LICENSE`.
