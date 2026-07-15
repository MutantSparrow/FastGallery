mod fs_commands;
#[cfg(windows)]
mod assoc;

use fs_commands::{
    fg_image_handler, fs_delete, fs_dims, fs_list, fs_list_dir, fs_open_root, fs_read_bytes,
    fs_read_head, fs_reveal, fs_thumb, fs_watch_start, fs_watch_stop, fs_write_bytes, FsState,
};

use std::path::{Path, PathBuf};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn assoc_install() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        let s = assoc::install_associations()?;
        return Ok(serde_json::to_value(s).map_err(|e| e.to_string())?);
    }
    #[cfg(not(windows))]
    {
        Err("Not supported on this platform".into())
    }
}

#[tauri::command]
fn assoc_uninstall() -> Result<(), String> {
    #[cfg(windows)]
    {
        return assoc::uninstall_associations();
    }
    #[cfg(not(windows))]
    {
        Err("Not supported on this platform".into())
    }
}

#[tauri::command]
fn assoc_status() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        return Ok(serde_json::to_value(assoc::status()).map_err(|e| e.to_string())?);
    }
    #[cfg(not(windows))]
    {
        Ok(serde_json::json!({ "registered": false, "exe": "", "exts": [] }))
    }
}

#[tauri::command]
fn assoc_open_default_apps() -> Result<(), String> {
    // Windows: open Settings > Default apps directly on our app's card.
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", "ms-settings:defaultapps"])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        Err("Not supported on this platform".into())
    }
}

fn show_or_focus(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Extract the first argv path that points at an image file.
fn extract_image_arg(argv: &[String]) -> Option<PathBuf> {
    // argv[0] is the exe itself.
    for a in argv.iter().skip(1) {
        if a.starts_with('-') || a.starts_with("--") {
            continue;
        }
        let p = PathBuf::from(a);
        if p.is_file() && is_image_ext(&p) {
            return Some(p);
        }
    }
    None
}

fn is_image_ext(p: &Path) -> bool {
    match p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()) {
        Some(ext) => matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif"),
        None => false,
    }
}

/// Turn an image path into { file, root } JSON payload for the webview.
fn args_payload(image: &Path) -> serde_json::Value {
    let file = image
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let root = image
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    serde_json::json!({ "file": file, "root": root })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Another instance was launched — forward argv to the running window.
            show_or_focus(app);
            if let Some(img) = extract_image_arg(&argv) {
                let payload = args_payload(&img);
                let _ = app.emit("fg://open-args", payload);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin({
            #[cfg(desktop)]
            {
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        if event.state() == ShortcutState::Pressed
                            && shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyG)
                        {
                            if let Some(win) = app.get_webview_window("main") {
                                let visible = win.is_visible().unwrap_or(false);
                                let focused = win.is_focused().unwrap_or(false);
                                if visible && focused {
                                    let _ = win.hide();
                                } else {
                                    show_or_focus(app);
                                }
                            }
                        }
                    })
                    .build()
            }
            #[cfg(not(desktop))]
            { tauri_plugin_global_shortcut::Builder::new().build() }
        })
        .manage(FsState::default())
        .register_uri_scheme_protocol("fg-image", fg_image_handler)
        .invoke_handler(tauri::generate_handler![
            fs_open_root,
            fs_list,
            fs_list_dir,
            fs_read_bytes,
            fs_read_head,
            fs_thumb,
            fs_dims,
            fs_delete,
            fs_write_bytes,
            fs_reveal,
            fs_watch_start,
            fs_watch_stop,
            assoc_install,
            assoc_uninstall,
            assoc_status,
            assoc_open_default_apps,
        ])
        .setup(|app| {
            // Tray icon + menu
            let show_item = MenuItem::with_id(app, "show", "Show / hide", true, None::<&str>)?;
            let assoc_install = MenuItem::with_id(app, "assoc_install", "Register file associations", true, None::<&str>)?;
            let assoc_remove = MenuItem::with_id(app, "assoc_remove", "Remove file associations", true, None::<&str>)?;
            let default_apps = MenuItem::with_id(app, "default_apps", "Windows Default apps…", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &sep1,
                    &assoc_install,
                    &assoc_remove,
                    &default_apps,
                    &sep1,
                    &quit_item,
                ],
            )?;

            let _tray = TrayIconBuilder::with_id("fg-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Fast Gallery")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_or_focus(app),
                    "quit" => app.exit(0),
                    "assoc_install" => {
                        #[cfg(windows)]
                        {
                            let _ = assoc::install_associations();
                            let _ = app.emit("fg://assoc-changed", true);
                        }
                    }
                    "assoc_remove" => {
                        #[cfg(windows)]
                        {
                            let _ = assoc::uninstall_associations();
                            let _ = app.emit("fg://assoc-changed", false);
                        }
                    }
                    "default_apps" => {
                        #[cfg(windows)]
                        {
                            let _ = std::process::Command::new("cmd")
                                .args(["/c", "start", "", "ms-settings:defaultapps"])
                                .spawn();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_or_focus(tray.app_handle());
                    }
                })
                .build(app)?;

            // Global shortcut Ctrl+Alt+G -> toggle window
            #[cfg(desktop)]
            {
                let sc = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG);
                if let Err(e) = app.global_shortcut().register(sc) {
                    eprintln!("global shortcut register failed: {e}");
                }
            }

            // Cold-boot argv → set window.__FG_INITIAL_ARGS__ before the page's IIFE runs.
            // We use both an initialization script (runs on every navigation) and, as a
            // belt-and-braces, an eval after the window exists.
            let argv: Vec<String> = std::env::args().collect();
            if let Some(img) = extract_image_arg(&argv) {
                let payload = args_payload(&img).to_string();
                if let Some(win) = app.get_webview_window("main") {
                    let js = format!("window.__FG_INITIAL_ARGS__ = {};", payload);
                    let _ = win.eval(&js);
                }
            }

            // Close-to-tray: intercept X, hide instead of quit.
            if let Some(win) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        api.prevent_close();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Fast Gallery");
}
