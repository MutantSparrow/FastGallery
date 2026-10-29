# Favorites persistence

2026-10-28. Addresses audit findings F07 and F08, following the performance, blinking and deletion changes.

## Identity and compatibility

Native favorites now use a SHA-256 namespace derived from the canonical Windows root path already supplied by the native bridge. Separators, case and trailing slashes are normalized. The database does not gain an absolute native path field. Session-only native root IDs are not used as persistent identities.

Browser directory handles use `isSameEntry()` against opaque handles in a new `roots` store. Each distinct folder gets a random namespace; registrations are serialized so concurrent calls for the same folder cannot create separate identities. Picker and single-directory drop use this same path. Watch refreshes retain the current namespace rather than rebuilding it from the folder basename.

File-list and mixed-drop browser imports do not expose a durable folder identity. Their favorites remain in memory until another dataset is opened; starring an image shows a notice explaining this. Existing basename-keyed records remain intact. No content hashing of the media or speculative basename identity is used for these imports.

Old favorites cannot be assigned unambiguously to a physical root: earlier records used only its name. Matching records under the old picker/drop/directory-input keys are offered through an **Import old favorites** banner. Import merges matching paths into the current folder's favorites, translating the old fallback root prefix where needed. Dismissal and import decisions are recorded per new root. Old records are never deleted or reassigned automatically. Failed imports stay retryable; stale offers cannot affect a replacement dataset.

## Storage

The gallery is the only IndexedDB opener. The shim no longer opens version 1 or deletes the last-handle record on startup; native mode simply skips browser-handle restoration. Version 2 ensures `handles`, `favorites` and `roots` exist, repairing the empty version-1 databases the previous opener race could create. Upgrade handling preserves existing records and closes connections on version changes.

Reads and writes resolve after transaction completion. A successful `put` request followed by transaction abort is reported as failure. Failed openers can retry; read failures remain distinguishable from an absent favorites record. A root whose favorites failed to load cannot overwrite the stored set until a successful reload. Notices avoid raw database/native errors and filesystem identifiers.

## Verification

`node --test tests/favorites.test.cjs tests/deletion.test.cjs tests/performance.test.cjs`: 44 tests passed. New tests cover native root isolation and stable keys, browser handle identity and concurrent registration, temporary imports, read-failure overwrite prevention, migration/import/dismissal, stale offers, failed saves, schema creation/retry and transaction commit/abort behavior.

Three browser smoke scenarios used separate synthetic databases: fresh startup, empty version-1 repair, and version-1 legacy favorites/handle records. All passed schema, native same-name-folder isolation, reopening with a different session ID and watch-refresh identity checks. Legacy data remained intact and import was explicitly offered. Real browser OPFS directory handles verified `isSameEntry()`, structured-clone persistence and reopening after the database connection was closed. Media and native roots were synthetic/mocked; the actual Windows WebView and the user's existing database were not modified by these smoke tests.

This is an IndexedDB schema upgrade. Older executables remain preserved as files, but their version-1 database opener cannot read a database already upgraded to version 2. Use the new build for persisted favorites after upgrading; older binaries are not a storage rollback.

## Build

Separate cumulative Windows x64 portable release: `desktop/release/fast-gallery-v1.6.1-favorites-fix.exe`, 11,825,664 bytes. Includes the earlier performance, blinking and deletion fixes. Companion build record: `desktop/release/fast-gallery-v1.6.1-favorites-fix.build.json`.

SHA-256: `9dfbff766a31b130eef6617008b0c0b95a005d0e42b268f4e7fb0ae5446e62be`.

Optimized release build, exact HTML/shim composition and inline JavaScript syntax checks passed. The x64 GUI executable, source fingerprints, product/version/company resources, neutral PDB metadata, private metadata scan and copied checksum passed. Earlier performance, blinking and deletion EXEs retain their original checksums. Quit the running tray instance before launching the new build. User acceptance is pending.

Historical build filenames in this report refer to preserved local artifacts. Only the latest cumulative portable EXE and its build record are versioned; see [USABILITY_WORK.md](USABILITY_WORK.md).
