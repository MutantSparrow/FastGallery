# Blank gallery caused by an obsolete Windows association

2026-11-01. Opening an image through Windows and then browsing folders in that instance displayed no images.

## Cause and repair

The existing `FastGallery.Image` association still targeted `fast-gallery-v1.6.1.exe`, an older portable build. The current `fast-gallery-v1.6.1-usability.exe` uses favorites database version 2; the older build requests version 1. Opening the older build against the upgraded database throws `VersionError` during folder loading.

Reproduced with synthetic images and an isolated WebView profile: the older build displayed zero tiles on both image opening and folder browsing. Browsing emitted an unhandled `VersionError`. The current build loaded the same folder and database successfully.

Repaired the existing per-user Windows registration with the current build's own `assoc_install` command. The ProgID, Open with entries and capability registrations now target the verified usability executable. Existing default choices for other apps were retained. No favorites database was cleared and no media was modified. No application source change or replacement executable was necessary.

## Verification

- The registered target matches the current portable EXE's SHA-256: `46f80b84179187e6fc0a9d32b2661dfceafe36d5f32ff53428be7164883e84a1`.
- Actual Windows/WebView2 execution loaded three synthetic images: two directly in the root and one nested. The default non-recursive grid correctly showed two tiles, with both thumbnails loaded.
- Opening a synthetic PNG through its Windows default association selected the requested image in the current viewer.
- Closing to the tray hid the window; opening another synthetic PNG through Windows restored it and selected that image.
- A final check with the normal saved profile confirmed database version 2, a populated gallery and the requested synthetic image open in the viewer.
- Native fullscreen and real collection performance remain separate verification items.

When changing portable executable paths, register associations from the new build after quitting the old tray instance. Keep older builds as historical artifacts; they are not a rollback for the upgraded favorites database. Temporary debugging was used only for these local checks.

## Recurrence: black screen from the stale Program Files copy

2026-11-06. Double-clicking any media opened Fast Gallery on a black screen.

### Cause

A second stale registration. `FastGallery.Image` pointed at `C:\Program Files\FastGallery\fast-gallery-v1.6.1.exe` (SHA-256 prefix `3CBDCC59DF72`, built 2026-09-21), and that copy was running as the single tray instance, so every double-click was forwarded to it. Same failure class as above: the build predates favorites database version 2 (`fast-gallery.html` opens `fast_gallery` at version 2).

This was inferred from the version mismatch and the earlier reproduction; the old exe was not re-run to capture the black screen itself.

### Repair

- Quit the old tray instance.
- Started `desktop/release/fast-gallery-v1.6.1-live-refresh.exe` and used tray menu **Register file associations**. ProgID command, `SystemFileAssociations` entries and `UserChoice` for `.png`, `.jpg`, `.mp4` and `.webp` now resolve to that exe.
- Verified by launching the exe with a synthetic PNG (viewer opened on `1 / 2 - test1.png`), then by an Explorer double-click on a second synthetic PNG, which the user confirmed works.
- The old `C:\Program Files\FastGallery` copy (`fast-gallery-v1.6.0.exe`, `fast-gallery-v1.6.1.exe`) was a manual copy with no uninstaller entry. It should be deleted so it cannot be re-registered or picked from "Open with".

### Checklist when this recurs

1. `Get-Process fast-gallery*` — which exe path is the running tray instance?
2. `(Get-ItemProperty 'HKCU:\Software\Classes\FastGallery.Image\shell\open\command').'(default)'` — which exe does the association target?
3. Quit the old instance, run the current build, and use tray **Register file associations**.
