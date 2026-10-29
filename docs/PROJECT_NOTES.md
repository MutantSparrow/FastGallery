# Fast Gallery working notes

Captured 2026-10-28 from the current working tree (version 1.6.1 manifests, including existing uncommitted compact-controls changes). Detailed evidence and verification limits: [PROJECT_AUDIT.md](PROJECT_AUDIT.md).

## Updates since the audit

The large-image stability pass is documented in [PERFORMANCE_WORK.md](PERFORMANCE_WORK.md). Consult that report before treating all audit findings below as unchanged. It adds bounded native viewer previews, serial prioritized/cancellable native decoding, viewer worker cancellation, generation/entry checks, bounded filmstrip URLs, cheap native stat/color paths, paused background scans, and geometry/visibility corrections. F03–F06, F10, and parts of F11/F13 are addressed by these changes; AVIF, full-root watch/fingerprint behavior, disk cache cleanup, ZIP, and broader accessibility/security work remain. F01–F02 and F07–F08 are addressed by subsequent passes below. Native compilation now passes; see the reports for newer test results and limitations.

An optimized Windows x64 portable EXE is now available at `desktop/release/fast-gallery-v1.6.1-performance.exe`, with a companion build record. Older binaries were preserved. Quit the older tray instance before testing the new binary, because window close hides the process and single-instance forwarding can activate the old app.

Accepted baseline, 2026-10-28: the user reported an improvement and asked to keep this build. Preserve the performance executable and its build record when making further changes. The user subsequently said performance is satisfactory and prioritized blinking while thumbnails are discovered, deferring further performance work.

Discovery blinking fix: `rebuildLayout()` now keeps mounted tiles and reconciles geometry in place; `mounted` uses file indices rather than view positions so sorting does not replace thumbnails unnecessarily. Visible loaded/pending images survive dimension-scan updates, while filtered/offscreen tiles still recycle and cancel work. Separate candidate build: `desktop/release/fast-gallery-v1.6.1-blink-fix.exe`. The accepted performance EXE remains unchanged. See [PERFORMANCE_WORK.md](PERFORMANCE_WORK.md) for verification and build details; user acceptance of this follow-up is pending.

Deletion reliability (F02): failed disk deletions now remain in the gallery with their selection and favorites; a dismissible notice reports failures above the viewer. Only successes and explicitly confirmed gallery-only removals compact the dataset. Stale confirmations are rejected, overlapping batches are blocked, and watch refreshes wait for deletion. See [DELETION_WORK.md](DELETION_WORK.md) for details and verification limits. Candidate build: `desktop/release/fast-gallery-v1.6.1-deletion-fix.exe`; earlier EXEs are preserved.

Favorites persistence (F07–F08): native roots use opaque hashes of canonical paths; browser directory roots use persisted FSA handles and `isSameEntry()` with random namespaces. Single-directory drop, picker and watch refresh agree on identity. Old basename-keyed favorites remain intact and matching entries are offered for explicit import. Browser file-list/mixed imports without durable identity use temporary favorites. The single IndexedDB opener upgrades to v2 (`handles`, `favorites`, `roots`), repairs empty v1 databases, waits for transaction completion and prevents failed reads from overwriting stored favorites. Native startup skips stale browser-handle restoration without deleting records. See [FAVORITES_WORK.md](FAVORITES_WORK.md). Cumulative candidate: `desktop/release/fast-gallery-v1.6.1-favorites-fix.exe`; 44 tests and three real-browser storage scenarios passed. Older v1 executables cannot read the upgraded favorites database; preserved EXEs are not a database rollback. User acceptance is pending.

Native command and confirmation cleanup (F01, part of F14): removed the unused native write command, including its Tauri registration. Confirmation starts on Cancel; Enter/Space activate the focused native button, repeated keys cannot confirm, Tab stays within the buttons and close restores prior focus. Explicit Y and N/Escape remain supported. See [CLEANUP_WORK.md](CLEANUP_WORK.md). Latest cumulative candidate: `desktop/release/fast-gallery-v1.6.1-cleanup.exe`. Verification: 51 JavaScript tests, three native unit tests, and real browser keyboard checks passed. User acceptance is pending; move next to the user's everyday annoyances while retaining the backlog below.

2026-10-29 usability pass: all twelve reported annoyances are implemented; see [USABILITY_WORK.md](USABILITY_WORK.md) for behavior, limits and verification. Native image dispatch now waits for frontend preparation before presenting the retained tray window. Viewer sessions start without a filmstrip; include-subfolders defaults/reset are off with explicit preference migration. Zoom supports below-fit scaling and corner-to-center panning. Gallery navigation is always visible; action icons, editable slideshow seconds, source-sized image clipboard copying, stable scan rows, actual fullscreen APIs and exact 1–12 columns are added. The browser clipboard round-trip confirmed 640×960 source bounds. There are now 60 passing JavaScript tests and three passing native unit tests. Latest cumulative candidate: `desktop/release/fast-gallery-v1.6.1-usability.exe`; the `usability-fix` file is an intermediate build. Live Windows tray/fullscreen verification and user acceptance are pending.

## Product and invariants

- Local media browser with strong support for AI generation prompt inspection. No application backend, account, analytics, or remote library service in reviewed source.
- Browser deliverable is one self-contained `fast-gallery.html`; desktop wraps that same frontend using Tauri 2/WebView2 on Windows.
- Preserve the shared browser/native behavior, immediate local-folder workflow, large-library responsiveness, and dense keyboard-oriented inspection tools.
- Rotation changes the displayed view; it does not rewrite the image. Disk deletion is permanent and requires a clear confirmation.
- Do not edit generated `desktop/dist` as source.

## Where changes belong

| Need | Start here |
|---|---|
| Visual appearance, markup, controls, grid/viewer behavior | `fast-gallery.html` |
| Metadata parsing, prompts, colors, filter/sort, ZIP | Named sections/functions inside the same HTML |
| Browser/native bridge and native fast paths | `desktop/src/shim.js` |
| Root/path validation, filesystem IO, dimensions, thumbnail cache, watching | `desktop/src-tauri/src/fs_commands.rs` |
| Tray, global shortcut, window lifecycle, boot arguments | `desktop/src-tauri/src/lib.rs` |
| Windows associations | `desktop/src-tauri/src/assoc.rs` |
| HTML/shim composition | `desktop/src/build.mjs` |
| Window, asset protocol, installer, security | `desktop/src-tauri/tauri.conf.json` and `capabilities/default.json` |

## Architecture to remember

- Plain CSS/DOM/JavaScript in one strict-mode IIFE, no frontend framework or runtime npm dependencies. Root HTML is about 6,292 lines/249 KB at audit.
- `files` is canonical; `view` holds filtered/sorted numeric indexes. Dimensions/prompts/colors and their pending promises use parallel arrays. Selection and thumbnail/filmstrip caches also use indexes. Favorites use relative paths.
- FSA picker/walk and native FSA-shaped handles converge on `resetAndLoadFiles`. Fallback directory input and legacy drop paths also feed it.
- Build script inserts `shim.js` before `</head>` and copies both outputs to `desktop/dist`. Shim installs native equivalents before gallery startup.
- Grid: shortest-column masonry, 12 px gap, explicit 1–12 columns, 1,200 px overscan, recycled DOM nodes. The earlier implicit 240 px column cap was removed in the usability pass.
- Viewer: canvas plus cancellable bitmap workers, with bounded native previews for large supported desktop images. Small GIF/selected WebP use a transformed image overlay; MP4/WebM use a video overlay. Fullscreen uses the native window or browser Fullscreen API; CSS follows actual state. Filmstrip starts closed, is virtualized and has a bounded URL cache.
- Native thumbnails decode in Rust, cache JPEGs on disk by path/mtime/size request, and return blob URLs. Native asset URLs avoid JS copies for overlay media. File-head reads avoid whole-file prompt IPC.
- IndexedDB `fast_gallery` v2: `handles`, `favorites`, `roots`. Root records retain opaque browser handles and per-root legacy-import decisions; native root namespaces are hashed and do not store absolute paths. localStorage: view/filter settings, columns, mute. Native handles are not persisted for reopening.
- Native watch events trigger a whole-root rescan with attempted state restoration, rather than incremental event application.

## Current design language

- Near-black background `#0a0a0a`; surfaces `#141414`/`#1c1c1c`; warm text `#e6e2d8`; subtle warm-gray borders.
- Sparse orange `#d97b2a` for primary/active/focus, red `#d84a3a` for destructive actions, gold `#f2c14e` for favorites.
- Square compact controls, system sans UI, monospace metadata/prompts, small uppercase eyebrow labels, restrained blur and panel shadows.
- Later CSS overrides are authoritative: effective 30 px main controls and mostly 12 px sentence-case labels. Earlier comments describing 28 px uppercase buttons are stale.
- Gallery keeps Open folder, search, Select, Controls, and help visible. Less frequent display/scanning/filter options live in a floating panel with an active-filter count.
- Viewer shares one Controls panel across standard and in-app fullscreen modes, grouped into playback, image actions, and view/help. Buttons are reparented at startup rather than duplicated.
- Responsive adjustments at 600 px; desktop native minimum is 800x600. Narrow phone layouts still need verification.

## Remaining audit work

See audit finding IDs for source references and confidence levels.

1. **F09:** Watch refresh still restores metadata by relative path without checking whether image contents or prompt sidecars changed. Full-root rescans also remain a scaling concern. Generation guards, deletion coordination and post-restore filter/layout rebuilding are already added.
2. **F11:** Native AVIF thumbnails and ICC/color-profile handling remain incomplete. Native EXIF orientation, transparent viewer previews, worker rescue and bounded large-image viewing are addressed; broader format fixtures remain useful.
3. **F12:** ZIP fallback can emit duplicate basenames; UTF-8 flags, count/size limits and cancellation need a shared policy.
4. **F13:** Persistent thumbnail-cache budgets/cleanup and actual collection memory/latency measurements remain. Native stat/color paths, priority/cancellation and bounded filmstrip URLs are addressed. A serialized native decode still allocates the original's pixel buffer.
5. **F14:** Grid media/favorites/prompts and filmstrip need keyboard semantics; the main viewer still needs focus/inert handling. The delete confirmation keyboard/focus/title issues are addressed by the cleanup pass.
6. **F15:** Native CSP is disabled and asset scope broad; review remaining privileges before distribution. Existing raw path/error logging still needs attention. Private registry endpoints were replaced with public npm package URLs during push preparation, preserving package versions and integrity hashes. The unused write command is removed (F01).

F01–F08 and F10 are addressed by the documented passes; F11/F13/F14 are partly addressed. The original audit remains historical evidence, not the current completion checklist. NSFW filtering remains a requested future feature.

## Working and verification conventions

From `desktop`, use `npm run build:web` to compose the web assets, `npm run dev` for Tauri development, and `npm run build` for native packaging. The HTML can be served over a loopback HTTP origin for browser testing; folder drop on `file:` has browser restrictions.

Current verification: 60 JavaScript regression tests and three native unit tests pass; one manual large-image native smoke remains opt-in. Optimized Windows x64 builds, source fingerprints, exact HTML/shim composition and executable metadata/privacy checks pass. Browser checks cover progressive layout, synthetic deletion outcomes, actual IndexedDB storage, confirmation keyboard activation and the usability pass's clipboard/layout/playback/navigation behavior. The user's real collection and actual Windows WebView runtime have not been comprehensively tested by the agent. Do not describe every advertised format/platform as verified. Consult the individual reports for scope and limits; the original audit's dependency-resolution failure is superseded by successful native builds.

Version appears in Node and Cargo manifests/locks and Tauri configuration. Only the latest verified cumulative portable executable and its build record are selected for versioning under `desktop/release`; historical builds remain local. Preserve pre-existing work and verify which source produced a binary before distributing it.

## Privacy for every later action

The user's standing privacy instructions apply to source, notes, screenshots, logs, exports, and metadata. Never copy real names, contacts, credentials, machine/account paths, private registry hosts, or organization identifiers into outgoing content. Existing configuration/history does not authorize disclosure. Review actual content and metadata before every commit, push, comment, upload, or publication. Use only an explicitly approved public Git identity; do not inherit local author/committer defaults. Do not publish local assistant settings or treat them as permission. Use synthetic media for reproducible tests whenever possible.
