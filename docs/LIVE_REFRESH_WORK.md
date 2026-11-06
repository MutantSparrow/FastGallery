# Preserve viewing position while images arrive

2026-11-01. Background additions could send the viewer back to an earlier image.

## Cause and change

The watch refresh captured the active image before its asynchronous directory walk. Moving from image 1 to image 3 during that walk was then undone when the stale image-1 snapshot was restored. Selection and gallery scroll had the same timing problem. The shared reset also reloaded favorites asynchronously, leaving another opportunity for user interaction during dataset replacement.

Refresh now captures viewer, selection, scroll and metadata state after the directory walk, immediately before replacing the file list. A same-root reset keeps the live favorites set, skips external-open replay and performs its data replacement synchronously. Restoration remaps the active file's relative path into the updated filtered/sorted view, updates its title and filmstrip extent, and retains a completed bitmap, zoom, pan and rotation. An unfinished canceled bitmap decode resumes with guards against later navigation. Temporary empty metadata caches no longer clear filters during a watch refresh. A removed or filtered-out active file still closes the viewer.

The full-root rescan and path-based metadata reuse remain; incremental watching and changed-file/sidecar fingerprint invalidation are separate audit work.

## Verification

- 71 JavaScript tests passed, including 11 live-refresh tests. Coverage includes navigation during a scan, earlier insertions, descending/filtered order, viewer closure, selection/favorites edits, pending decode cancellation, external-open ownership, metadata filters and gallery scroll anchors.
- An optimized Windows x64 build, exact HTML/shim composition, JavaScript syntax, source fingerprints, PE/PDB metadata and privacy checks passed. Earlier release executables were preserved.
- An actual Windows/WebView2 test used three synthetic root images and added a fourth through the filesystem. The native watcher initiated the scan. Its directory iterator was held while navigating from image 1 to image 3, then released. The viewer remained at **3 / 4**, its canvas content was unchanged, and Next opened the new fourth image.
- The previous executable did not receive this source change; Windows registration is updated to the new portable build when activating it.

## Build

[fast-gallery-v1.6.1-live-refresh.exe](../desktop/release/fast-gallery-v1.6.1-live-refresh.exe), 11,726,336 bytes. Companion build record: `desktop/release/fast-gallery-v1.6.1-live-refresh.build.json`.

SHA-256: `1ffaec70ccdef732f609eaf1b24704bc0e5e2ea487e7894b9f41ed7aafdac5e6`.

Existing media and favorites are retained. Quit the old tray instance when switching builds; register associations from the replacement so Windows does not keep opening an older executable.
