// Native filesystem bridge for the desktop build.
// Every command validates that the requested path is inside one of the
// user-authorized roots before doing any I/O.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::Serialize;
use sha1::{Digest, Sha1};
use tauri::{command, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

pub struct WatchHandle {
    _debouncer: Debouncer<notify::RecommendedWatcher, FileIdMap>,
}

#[derive(Default)]
pub struct FsState {
    // root_id -> canonicalized absolute path
    inner: Mutex<HashMap<String, PathBuf>>,
    // root_id -> live watcher handle (dropped on stop)
    watchers: Mutex<HashMap<String, WatchHandle>>,
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
    h.update(b"oriented-thumbs-v1");
    h.update(abs.as_bytes());
    h.update(mtime_ms.to_le_bytes());
    h.update(max.to_le_bytes());
    let digest = h.finalize();
    let mut s = String::with_capacity(40);
    for b in digest.iter() { s.push_str(&format!("{:02x}", b)); }
    s
}

// A small output thumbnail can still require a gigabyte-sized source decode.
// Share this gate between thumbnails and viewer previews, including IPC callers
// outside the shim's priority queue. Hold it until source pixels are released.
static IMAGE_DECODE_LOCK: Mutex<()> = Mutex::new(());

fn preview_dimensions(w: u32, h: u32, max_edge: u32, max_pixels: u64) -> (u32, u32) {
    let scale = (max_edge as f64 / w.max(h).max(1) as f64)
        .min((max_pixels as f64 / (w as f64 * h as f64).max(1.0)).sqrt())
        .min(1.0);
    ((w as f64 * scale).floor().max(1.0) as u32,
     (h as f64 * scale).floor().max(1.0) as u32)
}

fn decode_scaled(src: &Path, max_edge: u32, max_pixels: u64) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::open(src).map_err(|e| e.to_string())?
        .with_guessed_format().map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    // Still accommodates 12k x 26k RGBA artwork, but reject allocations beyond
    // 2 GiB rather than running several unrestricted decoders simultaneously.
    limits.max_alloc = Some(2u64 * 1024 * 1024 * 1024);
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    reader.limits(limits);

    let mut decoder = reader.into_decoder().map_err(|e| format!("decode: {e}"))?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let img = DynamicImage::from_decoder(decoder).map_err(|e| format!("decode: {e}"))?;
    let (w, h) = preview_dimensions(img.width(), img.height(), max_edge, max_pixels);
    let mut scaled = if (w, h) == (img.width(), img.height()) { img } else {
        let scaled = img.resize_exact(w, h, FilterType::Triangle);
        drop(img);
        scaled
    };
    // Rotate the small result, so EXIF orientations that require a copy never
    // duplicate the giant source bitmap.
    scaled.apply_orientation(orientation);
    Ok(scaled)
}

pub(crate) fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
}

#[cfg(windows)]
fn pdf_page_size(src: &Path) -> Result<(u32, u32), String> {
    crate::pdf::page_size(src)
}
#[cfg(not(windows))]
fn pdf_page_size(_src: &Path) -> Result<(u32, u32), String> {
    Err("pdf rendering is not supported on this platform".into())
}

// The page is rasterized straight to the requested edge, so no oversized
// source bitmap exists. Still serialize it with other heavy decodes.
#[cfg(windows)]
fn decode_pdf_page(src: &Path, max: u32) -> Result<DynamicImage, String> {
    let png = crate::pdf::render_first_page_png(src, max)?;
    image::load_from_memory_with_format(&png, ImageFormat::Png).map_err(|e| format!("decode: {e}"))
}
#[cfg(not(windows))]
fn decode_pdf_page(_src: &Path, _max: u32) -> Result<DynamicImage, String> {
    Err("pdf rendering is not supported on this platform".into())
}

fn render_thumb(src: &Path, max: u32) -> Result<Vec<u8>, String> {
    let _decode = IMAGE_DECODE_LOCK.lock().map_err(|_| "image decoder unavailable")?;
    let scaled = if is_pdf(src) {
        decode_pdf_page(src, max)?
    } else {
        decode_scaled(src, max, u64::from(max) * u64::from(max))?
    };
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut cur = Cursor::new(&mut buf);
    let rgb = scaled.to_rgb8();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cur, 78);
    encoder.write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn render_preview(src: &Path, max_edge: u32, max_pixels: u64) -> Result<Vec<u8>, String> {
    let _decode = IMAGE_DECODE_LOCK.lock().map_err(|_| "image decoder unavailable")?;
    let scaled = decode_scaled(src, max_edge, max_pixels)?;
    let mut bytes = Cursor::new(Vec::new());
    scaled.write_to(&mut bytes, ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(bytes.into_inner())
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
        if is_pdf(&p) {
            return pdf_page_size(&p);
        }
        let reader = ImageReader::open(&p).map_err(|e| e.to_string())?
            .with_guessed_format().map_err(|e| e.to_string())?;
        let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
        let (w, h) = decoder.dimensions();
        let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
        Ok(if orientation.to_exif() >= 5 { (h, w) } else { (w, h) })
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

/// Lossless, size-bounded viewer preview. Original file bytes and full-size
/// source pixels stay in Rust; only the resized PNG crosses into the webview.
#[command]
pub async fn fs_preview(
    state: State<'_, FsState>,
    root_id: String,
    rel: String,
    max_edge: u32,
    max_pixels: u64,
) -> Result<tauri::ipc::Response, String> {
    let root = root_for(&state, &root_id)?;
    let p = resolve_child(&root, &rel)?;
    let edge = max_edge.clamp(64, 16384);
    let pixels = max_pixels.clamp(4096, 96_000_000);
    tauri::async_runtime::spawn_blocking(move || render_preview(&p, edge, pixels))
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
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
    if lower.ends_with(".mp4") { return "video/mp4"; }
    if lower.ends_with(".webm") { return "video/webm"; }
    if lower.ends_with(".pdf") { return "application/pdf"; }
    if lower.ends_with(".html") || lower.ends_with(".htm") { return "text/html; charset=utf-8"; }
    "application/octet-stream"
}

// ------------- filesystem watcher -------------
// Emits `fg://fs-change` with { rootId } whenever something under the root
// changes. Debounced (300 ms) so a burst of writes coalesces into one JS-side
// refresh. Errors are logged but never propagated — the watcher must not tear
// the whole UI down on transient I/O hiccups.

#[command]
pub async fn fs_watch_start(
    app: AppHandle,
    state: State<'_, FsState>,
    root_id: String,
) -> Result<(), String> {
    let root = root_for(&state, &root_id)?;
    // Drop any previous watcher for this root so we don't leak listeners.
    state.watchers.lock().unwrap().remove(&root_id);

    let app_for_cb = app.clone();
    let root_id_for_cb = root_id.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |res: DebounceEventResult| {
            match res {
                Ok(_events) => {
                    // We don't forward path lists — the JS side re-walks the
                    // whole root and diffs. Cheaper on IPC, and it handles
                    // rename-across-directory naturally.
                    let _ = app_for_cb.emit(
                        "fg://fs-change",
                        serde_json::json!({ "rootId": root_id_for_cb.clone() }),
                    );
                }
                Err(errs) => {
                    for e in errs {
                        eprintln!("[fg] fs watch error: {e:?}");
                    }
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    state
        .watchers
        .lock()
        .unwrap()
        .insert(root_id, WatchHandle { _debouncer: debouncer });
    Ok(())
}

#[command]
pub fn fs_watch_stop(state: State<'_, FsState>, root_id: String) -> Result<(), String> {
    state.watchers.lock().unwrap().remove(&root_id);
    Ok(())
}

#[cfg(test)]
mod performance_tests {
    use super::*;

    #[test]
    fn giant_preview_dimensions_obey_both_limits() {
        for (w, h) in [(12000, 26000), (32768, 1000), (20000, 20000), (400, 800)] {
            let (pw, ph) = preview_dimensions(w, h, 8192, 16_000_000);
            assert!(pw <= w && ph <= h);
            assert!(pw.max(ph) <= 8192);
            assert!(u64::from(pw) * u64::from(ph) <= 16_000_000);
            assert!((pw as f64 / ph as f64 - w as f64 / h as f64).abs() < 0.02);
        }
    }

    #[test]
    fn small_images_are_not_upscaled() {
        assert_eq!(preview_dimensions(40, 80, 8192, 16_000_000), (40, 80));
    }

    #[test]
    fn bounded_native_decode_retains_transparency() {
        let file = std::env::temp_dir().join(format!("gallery-synthetic-{}.png", uuid::Uuid::new_v4()));
        let fixture = image::RgbaImage::from_pixel(600, 300, image::Rgba([10, 20, 30, 0]));
        fixture.save(&file).expect("write synthetic fixture");
        let result = render_preview(&file, 100, 8000);
        let _ = fs::remove_file(&file);
        let preview = image::load_from_memory(&result.expect("decode synthetic fixture"))
            .expect("decode preview PNG");
        assert_eq!((preview.width(), preview.height()), (100, 50));
        assert_eq!(preview.to_rgba8().get_pixel(0, 0)[3], 0);
    }

    #[cfg(windows)]
    #[test]
    fn pdf_thumbnail_is_a_bounded_jpeg_of_the_first_page() {
        let file = std::env::temp_dir().join(format!("gallery-synthetic-{}.pdf", uuid::Uuid::new_v4()));
        fs::write(&file, crate::pdf::tests::synthetic_pdf(800, 400)).expect("write synthetic pdf");
        let thumb = render_thumb(&file, 200);
        let _ = fs::remove_file(&file);
        let bytes = thumb.expect("render pdf thumbnail");
        assert_eq!(image::guess_format(&bytes).expect("thumbnail format"), ImageFormat::Jpeg);
        let img = image::load_from_memory(&bytes).expect("decode thumbnail");
        assert_eq!(img.width(), 200);
        assert!((img.height() as i32 - 100).abs() <= 1);
    }

    #[test]
    fn pdf_detection_ignores_case_and_other_formats() {
        assert!(is_pdf(Path::new("a/Report.PDF")));
        assert!(is_pdf(Path::new("b.pdf")));
        assert!(!is_pdf(Path::new("pdf.png")));
        assert!(!is_pdf(Path::new("noext")));
    }

    #[test]
    #[ignore = "manual large-image smoke test"]
    fn large_preview_smoke() {
        let file = std::env::temp_dir().join(format!("gallery-synthetic-{}.png", uuid::Uuid::new_v4()));
        let fixture = image::RgbaImage::from_pixel(8192, 4096, image::Rgba([30, 60, 90, 128]));
        fixture.save(&file).expect("write synthetic large fixture");
        drop(fixture);
        let start = std::time::Instant::now();
        let result = render_preview(&file, 2048, 4_000_000);
        let elapsed = start.elapsed();
        let _ = fs::remove_file(&file);
        let bytes = result.expect("decode large fixture");
        let preview = image::load_from_memory(&bytes).expect("decode preview PNG");
        assert_eq!((preview.width(), preview.height()), (2048, 1024));
        println!("Synthetic 8192x4096 -> 2048x1024 preview: {} ms, {} encoded bytes", elapsed.as_millis(), bytes.len());
    }
}
