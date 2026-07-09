// Fast Gallery — desktop shim.
// Runs BEFORE fast-gallery.html's IIFE. Replaces the browser's File System
// Access API surface with drop-in objects that call Rust via Tauri's invoke().
// Shape mirrors FSA closely so the gallery code needs no branching.

(function () {
  const isTauri =
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
  if (!isTauri) return; // running as plain HTML: leave real APIs untouched

  const core = (window.__TAURI__ && window.__TAURI__.core) || window.__TAURI_INTERNALS__;
  const invoke = core.invoke.bind(core);
  const convertFileSrc = core.convertFileSrc
    ? core.convertFileSrc.bind(core)
    : ((p) => `http://asset.localhost/${encodeURIComponent(p)}`);
  window.__FG_NATIVE__ = true;
  // Public helper: turn an absolute OS path into a URL <img>/<video> can load
  // directly via Tauri's asset protocol. Bytes never enter the JS heap.
  window.__fgAssetUrl = function (absPath) {
    if (!absPath) return "";
    return convertFileSrc(absPath);
  };

  // Public helper: request a downscaled JPEG thumb of an image, produced by
  // Rust (with on-disk cache). Returns an object-URL that the caller must
  // revoke when done. Bytes flow through IPC once, thumbnails are tiny.
  //
  // Concurrency-limited queue prevents 30k concurrent decodes when the user
  // scrolls a large folder fast. 8 parallel decodes matches typical CPU.
  const THUMB_CONC = 8;
  let thumbActive = 0;
  const thumbQueue = [];
  function drainThumbQueue() {
    while (thumbActive < THUMB_CONC && thumbQueue.length) {
      const job = thumbQueue.shift();
      thumbActive++;
      invoke('fs_thumb', { rootId: job.rootId, rel: job.rel, max: job.max })
        .then((bytes) => {
          const buf = bytes instanceof ArrayBuffer ? bytes
                    : ArrayBuffer.isView(bytes) ? bytes.buffer
                    : new Uint8Array(bytes).buffer;
          const blob = new Blob([buf], { type: 'image/jpeg' });
          job.resolve(URL.createObjectURL(blob));
        })
        .catch((err) => {
          console.error('[fg-shim] fs_thumb failed', job.rel, err);
          job.resolve("");
        })
        .finally(() => { thumbActive--; drainThumbQueue(); });
    }
  }
  // Read only the first N bytes of a file. Returns an ArrayBuffer. Used by
  // the JS prompt extractor so we don't ship the pixel payload of a 300MB PNG
  // just to read a tEXt chunk near the start of the file.
  window.__fgReadHead = async function (rootId, rel, maxBytes) {
    if (!rootId || !rel) return null;
    try {
      const bytes = await invoke('fs_read_head', { rootId, rel, maxBytes });
      const buf = bytes instanceof ArrayBuffer ? bytes
                : ArrayBuffer.isView(bytes) ? bytes.buffer
                : new Uint8Array(bytes).buffer;
      return buf;
    } catch (err) {
      console.error('[fg-shim] fs_read_head failed', rel, err);
      return null;
    }
  };

  // Fast dimension probe — header-only decode in Rust. Much cheaper than
  // handing the entire file to <img> just to read naturalWidth/Height.
  window.__fgDims = async function (rootId, rel) {
    if (!rootId || !rel) return null;
    try {
      const [w, h] = await invoke('fs_dims', { rootId, rel });
      return { w: w || 1, h: h || 1 };
    } catch (_) { return null; }
  };

  window.__fgThumbUrl = function (rootId, rel, max) {
    if (!rootId || !rel) return Promise.resolve("");
    return new Promise((resolve) => {
      thumbQueue.push({ rootId, rel, max: max | 0, resolve });
      drainThumbQueue();
    });
  };
  // If a caller (e.g. after fast scroll) no longer needs a queued thumb,
  // let them cancel by tag. Simple: replace on next call for same tile.
  window.__fgThumbCancel = function () {
    // Not implemented granularly — we rely on tile index guards in the caller.
  };

  // Match the extension filter Fast Gallery already uses (see IMAGE_EXT_RE).
  const IMG_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
  const LOG_RE = /^log\.html?$/i;

  // Per-directory listing cache: Map<`${rootId}:${rel}`, Entry[]>.
  // The browser's FSA walks lazily (one dir at a time). We match that so a
  // 30k-file tree streams into the UI as fast as it does in a browser
  // instead of blocking on one giant recursive walk.
  const dirCache = new Map();
  function dirKey(rootId, rel) { return rootId + ':' + rel; }

  async function listDir(rootId, rel) {
    const k = dirKey(rootId, rel);
    let cached = dirCache.get(k);
    if (!cached) {
      cached = await invoke('fs_list_dir', { rootId, rel });
      dirCache.set(k, cached);
    }
    return cached;
  }
  function invalidateAllDirs(rootId) {
    for (const k of dirCache.keys()) {
      if (k.startsWith(rootId + ':')) dirCache.delete(k);
    }
  }

  function encodeRel(rel) {
    return rel.split('/').map(encodeURIComponent).join('/');
  }

  // ---------- File handle ----------
  class NativeFileHandle {
    constructor({ rootId, rel, name, size, mtimeMs, absPath, parent }) {
      this.kind = 'file';
      this.name = name;
      this.absPath = absPath || '';   // read by the HTML walker
      this._rootId = rootId;
      this._rel = rel;
      this._size = size;
      this._mtimeMs = mtimeMs;
      this._parent = parent; // NativeDirHandle
    }
    async getFile() {
      // Bring bytes over IPC. Rust returns Vec<u8> which Tauri v2 serializes
      // efficiently as a JS ArrayBuffer (not base64). WebView2's fetch() does
      // not see custom URI schemes so we cannot go through a fake URL.
      let bytes;
      try {
        bytes = await invoke('fs_read_bytes', { rootId: this._rootId, rel: this._rel });
      } catch (err) {
        console.error('[fg-shim] fs_read_bytes failed', this._rel, err);
        throw new DOMException('read failed', 'NotFoundError');
      }
      // bytes may be number[] or ArrayBuffer depending on Tauri version.
      const buf = bytes instanceof ArrayBuffer ? bytes
                : ArrayBuffer.isView(bytes) ? bytes.buffer
                : new Uint8Array(bytes).buffer;
      return new File([buf], this.name, { lastModified: this._mtimeMs || 0 });
    }
    async isSameEntry(other) {
      return !!other && other._rel === this._rel && other._rootId === this._rootId;
    }
  }

  // ---------- Directory handle ----------
  class NativeDirHandle {
    constructor({ rootId, rel, name, absPath }) {
      this.kind = 'directory';
      this.name = name;
      this.absPath = absPath || '';
      this._rootId = rootId;
      this._rel = rel; // "" for root
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }

    async *entries() {
      const bucket = await listDir(this._rootId, this._rel || '');
      for (const e of bucket) {
        const child =
          e.kind === 'directory'
            ? new NativeDirHandle({
                rootId: this._rootId,
                rel: e.rel,
                name: e.name,
                absPath: e.abs || '',
              })
            : new NativeFileHandle({
                rootId: this._rootId,
                rel: e.rel,
                name: e.name,
                size: e.size,
                mtimeMs: e.mtimeMs,
                absPath: e.abs || '',
                parent: this,
              });
        yield [e.name, child];
      }
    }

    async *values() {
      for await (const [, v] of this.entries()) yield v;
    }

    async getFileHandle(name) {
      for await (const [n, h] of this.entries()) {
        if (n === name && h.kind === 'file') return h;
      }
      throw new DOMException(`file not found: ${name}`, 'NotFoundError');
    }
    async getDirectoryHandle(name) {
      for await (const [n, h] of this.entries()) {
        if (n === name && h.kind === 'directory') return h;
      }
      throw new DOMException(`dir not found: ${name}`, 'NotFoundError');
    }

    async removeEntry(name) {
      const rel = this._rel ? `${this._rel}/${name}` : name;
      await invoke('fs_delete', { rootId: this._rootId, rel });
      // Bust this dir's cache so re-listing sees the deletion.
      dirCache.delete(dirKey(this._rootId, this._rel || ''));
    }

    async isSameEntry(other) {
      return !!other && other._rel === this._rel && other._rootId === this._rootId;
    }
  }

  // ---------- showDirectoryPicker replacement ----------
  window.showDirectoryPicker = async function () {
    const info = await invoke('fs_open_root', { path: null });
    if (!info) throw new DOMException('picker aborted', 'AbortError');
    invalidateAllDirs(info.id);
    return new NativeDirHandle({ rootId: info.id, rel: '', name: info.name, absPath: info.path });
  };

  // ---------- boot-args helper for the HTML ----------
  // Given an absolute folder path, register it as a root and return a
  // NativeDirHandle. Used by fast-gallery.html when opening via file assoc.
  window.__fgOpenPathAsRoot = async function (rootPath) {
    if (!rootPath) return null;
    const info = await invoke('fs_open_root', { path: rootPath });
    if (!info) return null;
    invalidateAllDirs(info.id);
    return new NativeDirHandle({ rootId: info.id, rel: '', name: info.name, absPath: info.path });
  };

  // Fire an fg-boot-open event once a payload is known. Listeners live in the
  // gallery IIFE and hook resetAndLoadFiles + auto-open.
  function fireBootOpen(payload) {
    if (!payload || !payload.root) return;
    window.__FG_INITIAL_ARGS__ = payload;
    try {
      window.dispatchEvent(new CustomEvent('fg-boot-open', { detail: payload }));
    } catch (_) {}
  }

  // Cold-boot: main.rs may already have set __FG_INITIAL_ARGS__ via eval.
  if (window.__FG_INITIAL_ARGS__) {
    // small defer so listeners have a chance to register
    setTimeout(() => fireBootOpen(window.__FG_INITIAL_ARGS__), 0);
  }
  // Second-instance forwarding: Rust emits fg://open-args with {file, root}.
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('fg://open-args', (e) => {
      fireBootOpen(e && e.payload);
    });
  } else if (core && core.event) {
    // v2 path
    try {
      core.event.listen('fg://open-args', (e) => fireBootOpen(e && e.payload));
    } catch (_) {}
  }

  // ---------- File System Access "save file" — used by ZIP export ----------
  // fast-gallery.html calls showSaveFilePicker(). We fall back to save dialog
  // via tauri-plugin-dialog when M2 adds save support; for now, decline so the
  // gallery uses its existing anchor-download fallback path.
  // (No override — undefined stays undefined.)

  // Also expose a helper for reveal-in-Explorer used by later milestones.
  window.__fgReveal = async function (handle) {
    if (!handle || !handle._rootId) return;
    return invoke('fs_reveal', { rootId: handle._rootId, rel: handle._rel || '' });
  };

  // fast-gallery.html persists the last picked FSA handle in IndexedDB
  // (db: "fast_gallery", store: "handles", key: "last"). Those stored objects
  // are opaque browser handles from a prior session — they don't map to any
  // native root here. Clear just that entry on cold start so the "Reopen last
  // folder" banner never tries to iterate a stale handle. Favorites (separate
  // store in the same db) are preserved.
  try {
    const openReq = indexedDB.open('fast_gallery', 1);
    openReq.onsuccess = () => {
      const db = openReq.result;
      try {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').delete('last');
        tx.oncomplete = () => db.close();
      } catch (_) { db.close(); }
    };
  } catch (_) {}

  console.log('[fg-shim] native FSA bridge ready');
})();
