// PDF page-1 rasterization through the Windows.Data.Pdf runtime API, which
// ships with Windows 10/11. No bundled renderer and no extra DLL. Only the
// first page is used: the gallery shows it as a thumbnail, and the viewer
// displays the whole document through the WebView's own PDF viewer.

use std::cell::Cell;
use std::path::Path;

use windows::core::HSTRING;
use windows::Data::Pdf::{PdfDocument, PdfPage, PdfPageRenderOptions};
use windows::Storage::StorageFile;
use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

// Runtime pages report device-independent pixels (1/96 inch). The gallery
// reports PDF pages in points (1/72 inch), which is what PDF tools show.
const DIP_TO_POINT: f32 = 72.0 / 96.0;

thread_local! {
    static WINRT_READY: Cell<bool> = const { Cell::new(false) };
}

// Blocking-pool threads are reused, so initialize each thread once. A thread
// already set up as single-threaded reports a mode error; it can still wait
// on these operations, so that error is ignored.
fn ensure_winrt() {
    WINRT_READY.with(|ready| {
        if !ready.get() {
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            ready.set(true);
        }
    });
}

// StorageFile rejects verbatim paths, which fs::canonicalize produces.
fn runtime_path(path: &Path) -> String {
    let s = path.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

fn err(e: windows::core::Error) -> String {
    format!("pdf: {}", e.message())
}

fn first_page(path: &Path) -> Result<PdfPage, String> {
    ensure_winrt();
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(runtime_path(path)))
        .and_then(|op| op.get())
        .map_err(err)?;
    let doc = PdfDocument::LoadFromFileAsync(&file)
        .and_then(|op| op.get())
        .map_err(err)?;
    if doc.PageCount().map_err(err)? == 0 {
        return Err("pdf: no pages".into());
    }
    doc.GetPage(0).map_err(err)
}

fn points(page: &PdfPage) -> Result<(u32, u32), String> {
    let size = page.Size().map_err(err)?;
    let w = (size.Width * DIP_TO_POINT).round().max(1.0) as u32;
    let h = (size.Height * DIP_TO_POINT).round().max(1.0) as u32;
    Ok((w, h))
}

/// First-page size in points, with page rotation already applied.
pub fn page_size(path: &Path) -> Result<(u32, u32), String> {
    points(&first_page(path)?)
}

/// Render the first page on its default white background so its longer edge
/// is `max_edge` pixels. Returns PNG bytes, the runtime's default encoding.
pub fn render_first_page_png(path: &Path, max_edge: u32) -> Result<Vec<u8>, String> {
    let page = first_page(path)?;
    let (w, h) = points(&page)?;
    let options = PdfPageRenderOptions::new().map_err(err)?;
    if w >= h {
        options.SetDestinationWidth(max_edge).map_err(err)?;
    } else {
        options.SetDestinationHeight(max_edge).map_err(err)?;
    }
    let stream = InMemoryRandomAccessStream::new().map_err(err)?;
    page.RenderWithOptionsToStreamAsync(&stream, &options)
        .and_then(|op| op.get())
        .map_err(err)?;
    let len = u32::try_from(stream.Size().map_err(err)?)
        .map_err(|_| "pdf: rendered page too large".to_string())?;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(err)?)
        .map_err(err)?;
    let loaded = reader.LoadAsync(len).and_then(|op| op.get()).map_err(err)?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).map_err(err)?;
    Ok(bytes)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Write a minimal one-page PDF with a correct cross-reference table.
    /// Width and height are in points. The page is filled solid red.
    pub fn synthetic_pdf(width: u32, height: u32) -> Vec<u8> {
        let content = format!("1 0 0 rg 0 0 {width} {height} re f");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents 4 0 R >>"),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for off in offsets {
            out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
        );
        out
    }

    fn write_fixture(width: u32, height: u32) -> std::path::PathBuf {
        let file = std::env::temp_dir().join(format!("gallery-synthetic-{}.pdf", uuid::Uuid::new_v4()));
        std::fs::write(&file, synthetic_pdf(width, height)).expect("write synthetic pdf");
        file
    }

    #[test]
    fn reports_first_page_size_in_points() {
        let file = write_fixture(400, 200);
        let size = page_size(&file);
        let _ = std::fs::remove_file(&file);
        assert_eq!(size.expect("read synthetic pdf"), (400, 200));
    }

    #[test]
    fn renders_first_page_within_edge_budget() {
        let file = write_fixture(300, 600);
        let png = render_first_page_png(&file, 256);
        let _ = std::fs::remove_file(&file);
        let img = image::load_from_memory(&png.expect("render synthetic pdf")).expect("decode page PNG");
        assert_eq!(img.height(), 256);
        assert!((img.width() as i32 - 128).abs() <= 1);
        let px = img.to_rgb8().get_pixel(img.width() / 2, img.height() / 2).0;
        assert!(px[0] > 200 && px[1] < 60 && px[2] < 60, "expected red page, got {px:?}");
    }

    #[test]
    fn rejects_files_that_are_not_pdfs() {
        let file = std::env::temp_dir().join(format!("gallery-synthetic-{}.pdf", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"not a pdf").expect("write fixture");
        let result = page_size(&file);
        let _ = std::fs::remove_file(&file);
        assert!(result.is_err());
    }

    #[test]
    fn strips_verbatim_prefixes() {
        assert_eq!(runtime_path(Path::new(r"\\?\C:\docs\a.pdf")), r"C:\docs\a.pdf");
        assert_eq!(runtime_path(Path::new(r"\\?\UNC\host\share\a.pdf")), r"\\host\share\a.pdf");
        assert_eq!(runtime_path(Path::new(r"C:\docs\a.pdf")), r"C:\docs\a.pdf");
    }
}
