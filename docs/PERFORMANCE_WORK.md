# Large-image stability pass

2026-10-28. User priority: extra-large image viewing first, followed by large collections of large images in nested subfolders. Existing UI changes and release artifacts were preserved. No installer or release executable was replaced.

## Runnable release build

Built 2026-10-28: `desktop/release/fast-gallery-v1.6.1-performance.exe`, Windows x64 portable release, 11,823,616 bytes. Quit any older Fast Gallery instance using its tray menu before launching this build; closing its window only hides it, and the single-instance mechanism would otherwise activate the older process.

SHA-256: `cfa3dbab51e4f78cb20d8ea5b7c57121140440b11a902a3810927f7380c1f663`.

The optimized build completed successfully. Verification checked the x64 GUI executable format, product/version/company resources, fresh output and unchanged source fingerprints, new implementation markers, a neutral PDB filename, and absence of the original workspace/profile paths, machine name, and private registry endpoints. The copied executable's checksum matches the build output. A companion `.build.json` records checks and relative source fingerprints. Existing release files were preserved.

User acceptance, 2026-10-28: the user reported that this build is better and asked to keep it. Preserve this executable as the accepted baseline for subsequent changes. Specific media, collection sizes, timings, and peak-memory measurements were not recorded; this feedback does not establish a measured large-library performance result.

## Discovery blinking fix

2026-10-28 follow-up: the user is satisfied with current performance but reports gallery blinking as thumbnails arrive during discovery. Dimension scanning calls `applyFilters()` periodically; its layout rebuild previously detached and reset every mounted tile, clearing image sources and loaded states before requesting thumbnails again.

Layout rebuilds now reconcile existing tiles in place. Mounted tiles are keyed by file index rather than view position, so dimension changes and metadata-driven reordering retain each file's image and pending decode. Geometry and tile labels still update; tiles outside the visible range or removed by filters are recycled and cancelled normally. Dataset replacement still invalidates old work.

Verification: 22 Node regression tests passed, including progressive layout updates with loaded/pending images, view reordering, filter removal, and cancellation of removed thumbnails. A browser smoke test with 96 synthetic entries and delayed dimension results completed seven layout updates with zero resets or detachments of the first tile; its thumbnail remained loaded. Inline JavaScript syntax and exact desktop HTML/shim composition passed. These checks do not replace testing the actual desktop build against the user's collection.

Separate optimized Windows x64 portable build: `desktop/release/fast-gallery-v1.6.1-blink-fix.exe`, 11,823,616 bytes. SHA-256: `d2f302abd94fe96e95ab288f7e9b80978dd0db7fb97487268e3d8cfa1af0a17e`. Executable format, source fingerprints, neutral PDB metadata, copied checksum, and private metadata checks passed. The accepted performance EXE's original checksum was verified unchanged. Quit the running tray instance before launching the new binary.

## Changes

- Large supported desktop images use a dedicated Rust preview command before any original-file read in JavaScript. The intermediate PNG is lossless and retains alpha; EXIF orientation is applied after resizing so rotations do not duplicate the full source. A cached grid thumbnail appears immediately while the larger preview is prepared.
- Normal previews retain the 16 million pixel / 8,192 px frontend budget. On-demand higher resolution is limited to 96 million pixels and a 16,384 px edge. A failed resized browser decode no longer retries without a size limit. Capped requests are marked as capped and cannot repeatedly request the same unavailable detail.
- Thumbnail and native viewer requests share one priority queue. Only one heavy native decode is submitted at a time; a viewer request takes precedence over queued thumbnails. Queued requests have abort signals. Already-running native decoding completes before the next request; its obsolete response is discarded.
- A Rust mutex also serializes source image decoding across the thumbnail and preview commands. Decoder allocation limits are reduced from 4 GiB to 2 GiB, with the existing 32,768 px source-edge limit. This is an allocation guard, not a guaranteed process memory ceiling; a full source decode still happens in Rust.
- Browser viewer workers are created per decode and terminated on navigation/close. Folder generations, entry identity, and viewer request IDs prevent old work from painting or populating caches in a replacement dataset.
- Repainting a pending grid tile no longer queues the same decode again. Recycling/resetting a tile aborts its queued thumbnail. Filmstrip requests are aborted on close/reset, late results are revoked, URL caching is capped at 256, prefetch concurrency/radius are reduced, and large originals are excluded from speculative filmstrip prefetch.
- Background dimensions, prompt scans, and color scans pause while the viewer is open and resume on close. Native directory stats supply size/date sorting and scan estimates without reading originals. Native color scans use 64 px thumbnails. Nested walking uses a cursor instead of repeated array shifting and supports cancellation when another root is opened.
- Dimension arrivals rebuild geometry at a throttled cadence and on completion, including folders below 400 items. Visibility search now uses monotonic maximum bottom edges so tall images are retained. Prompt keyword filters reapply after scanning. Watch refresh and delete/reset paths cancel obsolete work and clear invalid thumbnail indexes.
- Giant GIF/WebP images use bounded static viewing instead of an unrestricted animation overlay; smaller animated overlays retain their previous behavior. AVIF still depends on the existing browser path.

## Checks

Run from the repository root:

```text
node --test tests/performance.test.cjs
```

The dependency-free Node suite exercises real source sections with synthetic handles, deferred responses, mocked native calls, and bitmap workers. It verifies scheduling, cancellation, original-byte avoidance, preview limits, fallback routing, cached initial display, stale-result rejection, nested stat retention, scan completion, tall-image visibility, background pause/resume, pending tile deduplication, and filmstrip cache lifetime. These are regression checks, not native memory benchmarks.

Native checks from `desktop/src-tauri`:

```text
cargo check --locked
cargo test --locked --offline --lib -j 2
cargo test --locked --offline --lib -j 2 large_preview_smoke -- --ignored --nocapture
```

The manual smoke test creates an 8192x4096 synthetic RGBA PNG, releases the generator buffer, then runs the real native decode/resize/PNG pipeline to 2048x1024 and removes the fixture. It reports elapsed time and encoded size without any local paths or user media.

JavaScript syntax, exact desktop HTML/shim composition, and the 20 Node tests passed. The native implementation compiled successfully. Browser smoke tests verified real worker viewing/navigation, restored landscape/portrait geometry, and the frontend native-preview integration using a mocked native service; those browser checks do not replace a run inside WebView2.

Native results: all three unit tests passed (preview limits, no upscaling, and transparency through the encoded PNG). The separately invoked large-image smoke test passed: 8192x4096 -> 2048x1024, 43,130 encoded bytes, 5,442 ms for decode/resize/encode in an **unoptimized debug build**. This is one synthetic input, not a release-build speed comparison or a peak-memory measurement. The fixture was removed after the run.

## Profiling and remaining limits

Inside the desktop webview's developer console, `window.__fgDecodeStats()` returns only numeric active/queued/completed counts and the most recent native request duration. It intentionally excludes filenames and paths. The queue's active heavy decode count should remain at most one. Duration includes IPC/cache/decode time and is not a pure codec benchmark.

The architecture remains one shared frontend with an explicit native media service. This pass reduces avoidable copies, overlap, and obsolete work; it does not implement tiled/region decoding. Opening a gigantic original can still require roughly its full decoded pixel buffer in Rust, plus resizing/encoding buffers. Unsupported codecs, corrupt files, unusually large 16-bit sources, and files exceeding decode limits can still show an unavailable-preview message. PNG intermediates do not currently forward embedded ICC profiles.

Real-world latency and peak process memory for the user's largest images and actual library remain to be measured. If one serialized decode still causes unacceptable pressure, the next architecture step is a codec-aware, memory-budgeted thumbnail/region service with persistent bounded preview caching. Full-root watch rescans, sidecar-change fingerprinting, persistent cache cleanup, the unused native write boundary, and failed-delete reporting remain separate audit work.

Historical build filenames in this report refer to preserved local artifacts. Only the latest cumulative portable EXE and its build record are versioned; see [USABILITY_WORK.md](USABILITY_WORK.md).
