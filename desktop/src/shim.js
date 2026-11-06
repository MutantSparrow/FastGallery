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
  window.__fgPresent = async function () {
    const win = window.__TAURI__?.window?.getCurrentWindow();
    if (!win) return;
    await win.show();
    await win.unminimize();
    await win.setFocus();
  };
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
  // Output size says nothing about source decode memory. Run one heavy decode
  // at a time; viewer requests jump ahead of queued background thumbnails.
  const THUMB_CONC = 1;
  let thumbActive = 0;
  let completedDecodes = 0, lastDecodeMs = 0;
  const thumbQueue = [];
  function drainThumbQueue() {
    while (thumbActive < THUMB_CONC && thumbQueue.length) {
      const job = thumbQueue.shift();
      if (job.signal?.aborted) { job.resolve(""); continue; }
      thumbActive++;
      job.started = true;
      const startedAt = Date.now();
      invoke(job.command, job.args)
        .then((bytes) => {
          if (job.signal?.aborted) { job.resolve(""); return; }
          const buf = bytes instanceof ArrayBuffer ? bytes
                    : ArrayBuffer.isView(bytes) ? bytes.buffer
                    : new Uint8Array(bytes).buffer;
          const blob = new Blob([buf], { type: job.mime });
          job.resolve(URL.createObjectURL(blob));
        })
        .catch(() => {
          job.resolve("");
        })
        .finally(() => {
          completedDecodes++; lastDecodeMs = Date.now() - startedAt;
          job.signal?.removeEventListener('abort', job.onAbort);
          thumbActive--; drainThumbQueue();
        });
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

  function queueImage(command, args, mime, options = {}) {
    if (options.signal?.aborted) return Promise.resolve("");
    return new Promise((resolve) => {
      const job = { command, args, mime, resolve, signal:options.signal, started:false };
      job.onAbort = () => {
        if (!job.started) {
          const index = thumbQueue.indexOf(job);
          if (index >= 0) thumbQueue.splice(index, 1);
          job.signal.removeEventListener('abort', job.onAbort);
          resolve("");
        }
      };
      job.signal?.addEventListener('abort', job.onAbort, { once:true });
      if (options.priority) thumbQueue.unshift(job);
      else thumbQueue.push(job);
      drainThumbQueue();
    });
  }
  window.__fgThumbUrl = function (rootId, rel, max, options) {
    if (!rootId || !rel) return Promise.resolve("");
    return queueImage('fs_thumb', { rootId, rel, max:max | 0 }, 'image/jpeg', options);
  };
  window.__fgPreviewUrl = function (rootId, rel, maxEdge, maxPixels, options = {}) {
    if (!rootId || !rel) return Promise.resolve("");
    return queueImage('fs_preview', { rootId, rel, maxEdge, maxPixels }, 'image/png', { ...options, priority:true });
  };
  // Numeric diagnostics only: never expose filenames/paths in performance data.
  window.__fgDecodeStats = () => ({ active:thumbActive, queued:thumbQueue.length, completed:completedDecodes, lastDecodeMs });

  // Match the extension filter Fast Gallery already uses (see IMAGE_EXT_RE).
  const IMG_RE = /\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|pdf)$/i;
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

  // ---------- Filesystem watch ----------
  // Start / stop a recursive watch on a root. Rust emits fg://fs-change with
  // { rootId } (debounced). We invalidate the dir listing cache for that root
  // and dispatch a DOM event the gallery listens for.
  window.__fgWatchStart = async function (rootId) {
    if (!rootId) return;
    try { await invoke('fs_watch_start', { rootId }); }
    catch (err) { console.error('[fg-shim] fs_watch_start failed', err); }
  };
  window.__fgWatchStop = async function (rootId) {
    if (!rootId) return;
    try { await invoke('fs_watch_stop', { rootId }); }
    catch (_) {}
  };
  function handleFsChange(payload) {
    const rid = payload && payload.rootId;
    if (!rid) return;
    invalidateAllDirs(rid);
    try {
      window.dispatchEvent(new CustomEvent('fg-fs-change', { detail: { rootId: rid } }));
    } catch (_) {}
  }
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('fg://fs-change', (e) => handleFsChange(e && e.payload));
  } else if (core && core.event) {
    try { core.event.listen('fg://fs-change', (e) => handleFsChange(e && e.payload)); } catch (_) {}
  }

  // The gallery owns IndexedDB initialization. A second opener here used to
  // create an empty v1 database before the gallery could create its stores.

  console.log('[fg-shim] native FSA bridge ready');
})();
