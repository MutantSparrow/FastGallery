// Windows file-association registration. HKCU only, no admin required.
// Registers a Capabilities block + ProgID so Fast Gallery appears in
// Settings > Default apps and in the "Open with" picker.

#![cfg(windows)]

use std::path::PathBuf;

use serde::Serialize;
use winreg::enums::*;
use winreg::RegKey;

const APP_NAME: &str = "Fast Gallery";
const PROG_ID: &str = "FastGallery.Image";
const APP_KEY: &str = r"Software\FastGallery";
const CAP_KEY: &str = r"Software\FastGallery\Capabilities";
const CAP_FA:  &str = r"Software\FastGallery\Capabilities\FileAssociations";
const REG_APPS: &str = r"Software\RegisteredApplications";
const CLASSES: &str = r"Software\Classes";

const EXTS: &[&str] = &[".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".mp4", ".webm"];

#[derive(Serialize)]
pub struct AssocStatus {
    pub registered: bool,
    pub exe: String,
    pub exts: Vec<String>,
}

fn exe_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

fn command_string(exe: &str) -> String {
    format!("\"{}\" \"%1\"", exe)
}

fn hkcu() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}

pub fn install_associations() -> Result<AssocStatus, String> {
    let exe = exe_path()?;
    let exe_str = exe.to_string_lossy().replace('/', "\\");
    let cmd = command_string(&exe_str);
    let icon = format!("{},0", exe_str);

    let root = hkcu();

    // ProgID
    let (progid, _) = root
        .create_subkey(format!(r"{}\{}", CLASSES, PROG_ID))
        .map_err(|e| e.to_string())?;
    progid.set_value("", &"Fast Gallery Image").map_err(|e| e.to_string())?;
    progid.set_value("FriendlyTypeName", &APP_NAME).map_err(|e| e.to_string())?;

    let (progid_icon, _) = root
        .create_subkey(format!(r"{}\{}\DefaultIcon", CLASSES, PROG_ID))
        .map_err(|e| e.to_string())?;
    progid_icon.set_value("", &icon).map_err(|e| e.to_string())?;

    let (progid_cmd, _) = root
        .create_subkey(format!(r"{}\{}\shell\open\command", CLASSES, PROG_ID))
        .map_err(|e| e.to_string())?;
    progid_cmd.set_value("", &cmd).map_err(|e| e.to_string())?;
    progid_cmd.set_value("FriendlyAppName", &APP_NAME).map_err(|e| e.to_string())?;

    // Capabilities
    let (cap, _) = root.create_subkey(CAP_KEY).map_err(|e| e.to_string())?;
    cap.set_value("ApplicationName", &APP_NAME).map_err(|e| e.to_string())?;
    cap.set_value("ApplicationDescription", &"Fast local image gallery.")
        .map_err(|e| e.to_string())?;
    cap.set_value("ApplicationIcon", &icon).map_err(|e| e.to_string())?;

    let (cap_fa, _) = root.create_subkey(CAP_FA).map_err(|e| e.to_string())?;
    for ext in EXTS {
        cap_fa.set_value(*ext, &PROG_ID).map_err(|e| e.to_string())?;
    }

    // RegisteredApplications
    let (reg_apps, _) = root.create_subkey(REG_APPS).map_err(|e| e.to_string())?;
    reg_apps
        .set_value("FastGallery", &CAP_KEY)
        .map_err(|e| e.to_string())?;

    // Per-ext context entry + OpenWithProgids
    for ext in EXTS {
        // OpenWithProgids
        let owp_path = format!(r"{}\{}\OpenWithProgids", CLASSES, ext);
        let (owp, _) = root.create_subkey(&owp_path).map_err(|e| e.to_string())?;
        owp.set_raw_value(
            PROG_ID,
            &winreg::RegValue {
                bytes: vec![],
                vtype: REG_NONE,
            },
        )
        .map_err(|e| e.to_string())?;

        // Context-menu entry "Open with Fast Gallery"
        let entry = format!(
            r"{}\SystemFileAssociations\{}\shell\FastGallery",
            CLASSES, ext
        );
        let (ek, _) = root.create_subkey(&entry).map_err(|e| e.to_string())?;
        ek.set_value("", &"Open with Fast Gallery").map_err(|e| e.to_string())?;
        ek.set_value("Icon", &icon).map_err(|e| e.to_string())?;
        let (ekc, _) = root
            .create_subkey(format!("{}\\command", entry))
            .map_err(|e| e.to_string())?;
        ekc.set_value("", &cmd).map_err(|e| e.to_string())?;
    }

    notify_shell();

    Ok(AssocStatus {
        registered: true,
        exe: exe_str,
        exts: EXTS.iter().map(|s| s.to_string()).collect(),
    })
}

pub fn uninstall_associations() -> Result<(), String> {
    let root = hkcu();

    // Best-effort delete each key. Ignore not-found.
    let _ = root.delete_subkey_all(APP_KEY);
    let _ = root.delete_subkey_all(format!(r"{}\{}", CLASSES, PROG_ID));
    if let Ok(ra) = root.open_subkey_with_flags(REG_APPS, KEY_ALL_ACCESS) {
        let _ = ra.delete_value("FastGallery");
    }
    for ext in EXTS {
        let _ = root.delete_subkey_all(format!(
            r"{}\SystemFileAssociations\{}\shell\FastGallery",
            CLASSES, ext
        ));
        // remove our ProgID hint from OpenWithProgids
        let owp_path = format!(r"{}\{}\OpenWithProgids", CLASSES, ext);
        if let Ok(owp) = root.open_subkey_with_flags(&owp_path, KEY_ALL_ACCESS) {
            let _ = owp.delete_value(PROG_ID);
        }
    }

    notify_shell();
    Ok(())
}

pub fn is_registered() -> bool {
    let root = hkcu();
    root.open_subkey(CAP_KEY).is_ok()
        && root.open_subkey(format!(r"{}\{}", CLASSES, PROG_ID)).is_ok()
}

pub fn status() -> AssocStatus {
    let exe = exe_path()
        .map(|p| p.to_string_lossy().replace('/', "\\"))
        .unwrap_or_default();
    AssocStatus {
        registered: is_registered(),
        exe,
        exts: EXTS.iter().map(|s| s.to_string()).collect(),
    }
}

fn notify_shell() {
    // SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL)
    use std::ffi::c_void;
    #[link(name = "shell32")]
    extern "system" {
        fn SHChangeNotify(w_event_id: i32, u_flags: u32, dw_item1: *const c_void, dw_item2: *const c_void);
    }
    unsafe {
        SHChangeNotify(0x08000000, 0x0000, std::ptr::null(), std::ptr::null());
    }
}
