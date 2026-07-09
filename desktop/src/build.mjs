// Compose desktop/dist/index.html from fast-gallery.html + shim.js.
// No bundler — Fast Gallery is one file; we just splice a <script> tag in.

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here     = dirname(fileURLToPath(import.meta.url));
const desktop  = resolve(here, '..');
const repo     = resolve(desktop, '..');
const distDir  = resolve(desktop, 'dist');
const srcHtml  = resolve(repo, 'fast-gallery.html');
const srcShim  = resolve(desktop, 'src', 'shim.js');
const outHtml  = resolve(distDir, 'index.html');
const outShim  = resolve(distDir, 'shim.js');

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

const html = readFileSync(srcHtml, 'utf8');

// Inject the shim tag right before </head> so it runs before the gallery IIFE.
// Also inject a small script that exposes __TAURI__-guarded __FG_INITIAL_ARGS__.
const inject = `<script src="./shim.js"></script>`;
let out;
if (/<\/head>/i.test(html)) {
  out = html.replace(/<\/head>/i, `${inject}\n</head>`);
} else {
  // last-resort: prepend
  out = inject + '\n' + html;
}

writeFileSync(outHtml, out, 'utf8');
copyFileSync(srcShim, outShim);

console.log(`built  ${outHtml}  (${out.length.toLocaleString()} chars)`);
console.log(`copied ${outShim}`);
