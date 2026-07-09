// Native filesystem bridge for the desktop build.
// Every command validates that the requested path is inside one of the
// user-authorized roots before doing any I/O.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use image::{ImageEncoder, ImageReader};
use serde::Serialize;
use sha1::{Digest, Sha1};
use tauri::{command, AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

#[derive(Default)]
pub struct FsState {
    // root_id -> canonicalized absolute path
    inner: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Serialize)]
pub struct RootInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub rel: String,          // forward-slash, root-relative
    pub abs: String,          // OS-absolute path, verbatim prefix stripped
    pub kind: &'static str,   // "file" | "directory"
    pub size: u64,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: i64,
}

fn to_rel(root: &Path, p: &Path) -> Option<String> {
    let stripped = p.strip_prefix(root).ok()?;
    let mut s = String::with_capacity(stripped.as_os_str().len());
    for comp in stripped.components() {
        if !s.is_empty() {
            s.push('/');
        }
        s.push_str(comp.as_os_str().to_str()?);
    }
    Some(s)
}

fn resolve_child(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    if rel.contains("..") {
        return Err("rejected path".into());
    }
    let mut joined = root.to_path_buf();
    for part in rel.split(['/', '\\']).filter(|s| !s.is_empty()) {
        joined.push(part);
    }
    let canon = fs::canonicalize(&joined).map_err(|e| e.to_string())?;
    if !canon.starts_with(root) {
        return Err("path escapes root".into());
    }
    Ok(canon)
}

fn register_root(state: &State<FsState>, root: PathBuf) -> RootInfo {
    let id = uuid::Uuid::new_v4().to_string();
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let disp = root.to_string_lossy().into_owned();
    let path = disp
        .strip_prefix(r"\\?\")
        .unwrap_or(&disp)
        .to_string();
    state.inner.lock().unwrap().insert(id.clone(), root);
    RootInfo { id, name, path }
}

fn root_for<'a>(
    state: &'a State<FsState>,
    id: &str,
) -> Result<PathBuf, String> {
    state
        .inner
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("unknown root id: {id}"))
}

#[command]
pub async fn fs_open_root(
    app: AppHandle,
    state: State<'_, FsState>,
    path: Option<String>,
) -> Result<Option<RootInfo>, String> {
    let chosen: PathBuf = if let Some(p) = path {
        PathBuf::from(p)
    } else {
        // native folder picker
        let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
        app.dialog().file().pick_folder(move |f| {
            let _ = tx.send(f.and_then(|p| p.into_path().ok()));
        });
        match rx.recv() {
            Ok(Some(p)) => p,
            _ => return Ok(None),
        }
    };
    let canon = fs::canonicalize(&chosen).map_err(|e| e.to_string())?;
    Ok(Some(register_root(&state, canon)))
}

#[command]
pub async fn fs_list(
    state: State<'_, FsState>,
    root_id: String,
    recursive: bool,
) -> Result<Vec<Entry>, String> {
    let root = root_for(&state, &root_id)?;
    // Walk in a blocking task so the async runtime and the webview IPC thread
    // stay responsive on huge trees (30k+ files).
    tauri::async_runtime::spawn_blocking(move || walk_tree(root, recursive))
        .await
        .map_err(|e| e.to_string())?
}

/// List a single directory (non-recursive). This is what the shim iterates
/// per-folder to mirror the browser's FSA behavior — lazy, streaming.
#[command]
pub async fn fs_list_dir(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
) -> Result<Vec<Entry>, String> {
    let root = root_for(&state, &root_id)?;
    let target = if rel.is_empty() {
        root.clone()
    } else {
        resolve_child(&root, &rel)?
    };
    let root2 = root.clone();
    tauri::async_runtime::spawn_blocking(move || read_one_dir(&root2, &target))
        .await
        .map_err(|e| e.to_string())?
}

fn read_one_dir(root: &Path, target: &Path) -> Result<Vec<Entry>, String> {
    let iter = fs::read_dir(target).map_err(|e| e.to_string())?;
    let mut out: Vec<Entry> = Vec::new();
    for de in iter.flatten() {
        let p = de.path();
        let meta = match de.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if meta.is_dir() { "directory" } else { "file" };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let Some(rel) = to_rel(root, &p) else { continue };
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let abs_disp = p.display().to_string();
        let abs = abs_disp.strip_prefix(r"\\?\").unwrap_or(&abs_disp).to_string();
        out.push(Entry {
            name,
            rel,
            abs,
            kind,
            size: if meta.is_file() { meta.len() } else { 0 },
            mtime_ms,
        });
    }
    Ok(out)
}

fn walk_tree(root: PathBuf, recursive: bool) -> Result<Vec<Entry>, String> {
    let max_depth = if recursive { usize::MAX } else { 1 };
    let mut out: Vec<Entry> = Vec::with_capacity(1024);
    for entry in WalkDir::new(&root)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if p == root {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if meta.is_dir() { "directory" } else { "file" };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let Some(rel) = to_rel(&root, p) else { continue };
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let abs_disp = p.display().to_string();
        let abs = abs_disp.strip_prefix(r"\\?\").unwrap_or(&abs_disp).to_string();
        out.push(Entry {
            name,
            rel,
            abs,
            kind,
            size: if meta.is_file() { meta.len() } else { 0 },
            mtime_ms,
        });
    }
    Ok(out)
}

#[command]
pub fn fs_read_bytes(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let root = root_for(&state, &root_id)?;
    let p = resolve_child(&root, &rel)?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[command]
pub fn fs_delete(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
) -> Result<(), String> {
    let root = root_for(&state, &root_id)?;
    let p = resolve_child(&root, &rel)?;
    if p == root {
        return Err("refuse to delete root".into());
    }
    fs::remove_file(&p).map_err(|e| e.to_string())
}

#[command]
pub fn fs_write_bytes(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let root = root_for(&state, &root_id)?;
    // parent must exist inside the root
    let (parent_rel, _fname) = match rel.rsplit_once('/') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (String::new(), rel.clone()),
    };
    let parent = resolve_child(&root, &parent_rel)?;
    let target = parent.join(&_fname);
    // ensure target is inside the root even if not yet existing
    if let Ok(canon_parent) = fs::canonicalize(&parent) {
        if !canon_parent.starts_with(&root) {
            return Err("path escapes root".into());
        }
    }
    fs::write(&target, &bytes).map_err(|e| e.to_string())
}

#[command]
pub fn fs_reveal(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
) -> Result<(), String> {
    let root = root_for(&state, &root_id)?;
    let p = resolve_child(&root, &rel)?;
    // Strip Windows verbatim prefix so Explorer accepts it.
    let display = p.display().to_string();
    let clean = display
        .strip_prefix(r"\\?\")
        .unwrap_or(&display)
        .to_string();
    let arg = format!("/select,{}", clean);
    std::process::Command::new("explorer")
        .arg(arg)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ------------- thumbnail generation -------------

fn thumb_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn thumb_key(abs: &str, mtime_ms: i64, max: u32) -> String {
    let mut h = Sha1::new();
    h.update(abs.as_bytes());
    h.update(mtime_ms.to_le_bytes());
    h.update(max.to_le_bytes());
    let digest = h.finalize();
    let mut s = String::with_capacity(40);
    for b in digest.iter() { s.push_str(&format!("{:02x}", b)); }
    s
}

fn render_thumb(src: &Path, max: u32) -> Result<Vec<u8>, String> {
    // Large-image safety: raise the image crate's default guard (default ~64Mp)
    // to something that covers the 12k x 26k monsters people actually produce
    // with tiled samplers. We only decode once here, then downscale hard.
    let mut reader = ImageReader::open(src).map_err(|e| e.to_string())?
        .with_guessed_format().map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    // Allow up to 4 GiB per allocation and 32k px on each side. Some upscaled
    // tiled samplers produce 12k×26k PNGs (~1.2 GB uncompressed RGBA).
    limits.max_alloc = Some(4u64 * 1024 * 1024 * 1024);
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    reader.limits(limits);

    let img = reader.decode().map_err(|e| format!("decode: {e}"))?;
    let (w, h) = (img.width(), img.height());
    let scaled = if w.max(h) <= max { img } else {
        img.resize(max, max, FilterType::Triangle)
    };
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut cur = Cursor::new(&mut buf);
    let rgb = scaled.to_rgb8();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cur, 78);
    encoder.write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Read only the first `max_bytes` of a file. Used by the JS side to scan
/// PNG/JPEG metadata chunks without hauling multi-MB pixel data over IPC.
#[command]
pub async fn fs_read_head(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let root = root_for(&state, &root_id)?;
    let p = resolve_child(&root, &rel)?;
    let max = max_bytes.min(16 * 1024 * 1024).max(4096);
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        let n = meta.len().min(max) as usize;
        let bytes = if n == meta.len() as usize {
            fs::read(&p).map_err(|e| e.to_string())?
        } else {
            use std::io::Read;
            let mut f = fs::File::open(&p).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; n];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            buf
        };
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
}

#[command]
pub async fn fs_dims(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
) -> Result<(u32, u32), String> {
    let root = root_for(&state, &root_id)?;
    let p = resolve_child(&root, &rel)?;
    tauri::async_runtime::spawn_blocking(move || {
        let reader = ImageReader::open(&p).map_err(|e| e.to_string())?
            .with_guessed_format().map_err(|e| e.to_string())?;
        reader.into_dimensions().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn fs_thumb(
    app: AppHandle,
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
    max: u32,
) -> Result<tauri::ipc::Response, String> {
    let root = root_for(&state, &root_id)?;
    let p = resolve_child(&root, &rel)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let abs_disp = p.display().to_string();
    let abs = abs_disp.strip_prefix(r"\\?\").unwrap_or(&abs_disp).to_string();
    let max = max.max(64).min(1024);

    let cache = thumb_cache_dir(&app)?;
    let key = thumb_key(&abs, mtime_ms, max);
    let cached = cache.join(format!("{}.jpg", key));
    if cached.exists() {
        let bytes = fs::read(&cached).map_err(|e| e.to_string())?;
        return Ok(tauri::ipc::Response::new(bytes));
    }

    let bytes = tauri::async_runtime::spawn_blocking(move || render_thumb(&p, max))
        .await
        .map_err(|e| e.to_string())??;
    // best-effort cache write
    let _ = fs::write(&cached, &bytes);
    Ok(tauri::ipc::Response::new(bytes))
}

// ------------- fg-image:// custom protocol -------------
// URL shape: fg-image://<host-ignored>/<root_id>/<url-encoded rel>
// e.g.       fg-image://x/abc123/2024%2Fphoto.png

pub fn fg_image_handler(
    ctx: tauri::UriSchemeContext<tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let app = ctx.app_handle().clone();
    let uri = request.uri().clone();
    match resolve_fg_image(&app, &uri) {
        Ok(bytes) => {
            let mime = guess_mime(uri.path());
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Cache-Control", "no-store")
                .body(bytes)
                .unwrap_or_else(|_| empty_response(500))
        }
        Err(_) => empty_response(404),
    }
}

fn empty_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap()
}

fn resolve_fg_image(
    app: &AppHandle,
    uri: &tauri::http::Uri,
) -> Result<Vec<u8>, String> {
    // path is "/<root_id>/<rel>"
    let path = uri.path();
    let trimmed = path.trim_start_matches('/');
    let (root_id, rel) = trimmed.split_once('/').ok_or("bad uri")?;
    let rel = percent_encoding::percent_decode_str(rel)
        .decode_utf8_lossy()
        .into_owned();

    let state: State<FsState> = app.state();
    let root = root_for(&state, root_id)?;
    let p = resolve_child(&root, &rel)?;
    fs::read(&p).map_err(|e| e.to_string())
}

fn guess_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") { return "image/png"; }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { return "image/jpeg"; }
    if lower.ends_with(".webp") { return "image/webp"; }
    if lower.ends_with(".gif") { return "image/gif"; }
    if lower.ends_with(".avif") { return "image/avif"; }
    if lower.ends_with(".bmp") { return "image/bmp"; }
    if lower.ends_with(".html") || lower.ends_with(".htm") { return "text/html; charset=utf-8"; }
    "application/octet-stream"
}
