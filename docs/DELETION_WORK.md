# Deletion reliability

2026-10-28. Addresses audit finding F02. The user authorized this fix after the performance and discovery-blinking work.

## Behavior

- A disk-backed entry leaves the gallery only when its parent handle's `removeEntry()` resolves successfully. Rejected operations remain in the collection, retaining their favorites and any existing selection.
- Mixed batches compact metadata and selection only around successfully removed entries. An open viewer retains the same file if it survives; deleting the viewed item advances within the remaining view as before.
- An entirely failed batch leaves the grid, viewer and caches untouched. A dismissible status notice displays the number of failures and suggests checking permissions or whether a file is in use. The notice is visible above the viewer. Native exception messages and filenames are not added to the notice or console logs.
- Browser-only entries without a writable directory handle retain the explicitly disclosed gallery-only removal behavior. Confirmation and completion text distinguish it from disk deletion.
- Only one deletion batch runs at a time. Confirmation captures the dataset generation, root and entry identities; changed contents require a fresh selection and confirmation. Switching datasets during a pending deletion stops further batch operations and stale UI updates; an already-submitted filesystem operation cannot be cancelled.
- Native watch refreshes wait for an active batch and coalesce afterward. A walk that finishes with an obsolete generation queues a fresh walk instead of replacing the current dataset with stale contents.

## Verification

`node --test tests/deletion.test.cjs tests/performance.test.cjs`: 32 tests passed. The deletion suite executes the actual deletion and refresh functions with synthetic handles and deferred outcomes. It covers complete failure, complete success, mixed success/failure/gallery-only removal, metadata and selection remapping, favorite retention, viewer identity, stale confirmation, overlapping requests, dataset replacement and watcher timing.

A browser smoke test used three synthetic images with mocked parent handles: one successful deletion, one rejected deletion and one gallery-only removal. The failed image remained selected, favorited and open; retrying the failure retained it. The status notice was visibly verified above the viewer. No real media or filesystem deletion was used in these tests; actual Windows locking/permission failures have not been exercised with this build. The native delete command itself is unchanged.

Inline JavaScript syntax and exact desktop HTML/shim composition passed. The optimized Windows x64 portable build completed; executable format, unchanged source fingerprints, neutral PDB metadata, private metadata scan and copied checksum passed. Product/version and neutral company resources were also checked. Earlier performance and blinking-fix executables retain their original checksums.

## Build

`desktop/release/fast-gallery-v1.6.1-deletion-fix.exe`, 11,824,128 bytes. Companion build record: `desktop/release/fast-gallery-v1.6.1-deletion-fix.build.json`.

SHA-256: `e04611379db602b2604c004ff3c680c1316c1e9a6c376103609bfe4c3be636b2`.

Quit the running tray instance before launching the new binary; window close only hides the old process. User acceptance of this build is pending. Favorites root isolation, IndexedDB startup races and other audit findings outside this change remain separate work.

Historical build filenames in this report refer to preserved local artifacts. Only the latest cumulative portable EXE and its build record are versioned; see [USABILITY_WORK.md](USABILITY_WORK.md).
