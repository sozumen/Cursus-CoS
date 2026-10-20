/* Builds the app into ./www (what Electron and Capacitor load, and what you can host as a PWA).
   Everything is local: Tailwind is compiled, Lucide and the fonts are copied from node_modules,
   so the finished app needs no internet.

     node scripts/build.mjs            -> www/
     node scripts/build.mjs --single   -> www/ plus dist/cursus-cos.html (one self-contained file)
                                          and dist/cursus-cos.fragment.html (for embedding hosts) */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src'), WWW = path.join(root, 'www'), DIST = path.join(root, 'dist');
const single = process.argv.includes('--single');
const mkdir = p => fs.mkdirSync(p, { recursive: true });
const copy = (from, to) => { mkdir(path.dirname(to)); fs.copyFileSync(from, to); };
const copyDir = (from, to) => { mkdir(to); for (const f of fs.readdirSync(from)) { const a = path.join(from, f), b = path.join(to, f); fs.statSync(a).isDirectory() ? copyDir(a, b) : copy(a, b); } };
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

fs.rmSync(WWW, { recursive: true, force: true });
mkdir(WWW);

// 1. app files
copy(path.join(SRC, 'index.html'), path.join(WWW, 'index.html'));
copy(path.join(SRC, 'manifest.webmanifest'), path.join(WWW, 'manifest.webmanifest'));
copyDir(path.join(SRC, 'js'), path.join(WWW, 'js'));
copyDir(path.join(SRC, 'icons'), path.join(WWW, 'icons'));
copy(path.join(SRC, 'styles', 'app.css'), path.join(WWW, 'styles', 'app.css'));

// 2. Tailwind, compiled (scans index.html and js/ for the classes in use)
execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(root, 'tailwind.config.js'),
  '-i', path.join(SRC, 'styles', 'tailwind.input.css'), '-o', path.join(WWW, 'styles', 'tailwind.css'), '--minify'], { cwd: root, stdio: 'inherit' });

// 3. fonts (latin subset, woff2)
const FONTS = [
  ['Instrument Sans', 'instrument-sans', [400, 500, 600, 700]],
  ['Bricolage Grotesque', 'bricolage-grotesque', [500, 700]],
  ['JetBrains Mono', 'jetbrains-mono', [400, 500]]
];
let fontCss = '';
for (const [family, pkg, weights] of FONTS) {
  for (const w of weights) {
    const file = `${pkg}-latin-${w}-normal.woff2`;
    const from = path.join(root, 'node_modules', '@fontsource', pkg, 'files', file);
    if (!fs.existsSync(from)) throw new Error('Missing font file: ' + from);
    copy(from, path.join(WWW, 'fonts', file));
    fontCss += `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:swap;src:url(../fonts/${file}) format('woff2')}\n`;
  }
}
fs.writeFileSync(path.join(WWW, 'styles', 'fonts.css'), fontCss);

// 4. Lucide icons
copy(path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'), path.join(WWW, 'vendor', 'lucide.min.js'));

copy(path.join(root, 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js'), path.join(WWW, 'vendor', 'socket.io.min.js'));

// 5. service worker (PWA) with the real file list
const files = walk(WWW).map(f => path.relative(WWW, f).split(path.sep).join('/'));
const build = crypto.createHash('sha1').update(files.map(f => f + fs.statSync(path.join(WWW, f)).size).join('|')).digest('hex').slice(0, 10);
fs.writeFileSync(path.join(WWW, 'sw.js'), fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8')
  .replace('__BUILD__', build).replace('__FILES__', JSON.stringify(['./', ...files.filter(f => f !== 'sw.js')])));
console.log(`www/ ready (${files.length + 1} files, build ${build})`);

// 6. optional single-file build
if (single) {
  mkdir(DIST);
  const mime = { woff2: 'font/woff2' };
  const cssOf = href => {
    const p = path.join(WWW, href);
    let css = fs.readFileSync(p, 'utf8');
    return css.replace(/url\((\.\.\/fonts\/[^)]+)\)/g, (m, rel) => {
      const fp = path.join(path.dirname(p), rel);
      return `url(data:${mime.woff2};base64,${fs.readFileSync(fp).toString('base64')})`;
    });
  };
  let html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '')
    .replace(/<link rel="manifest"[^>]*>\n?/, '').replace(/<link rel="icon"[^>]*>\n?/, '')
    .replace(/<link rel="stylesheet" href="([^"]+)">\n?/g, (m, h) => `<style>\n${cssOf(h)}\n</style>\n`)
    .replace(/<script src="([^"]+)"><\/script>\n?/g, (m, h) => `<script>\n${fs.readFileSync(path.join(WWW, h), 'utf8').replace(/<\/script/gi, '<\\/script')}\n</script>\n`)
    .replace('<body>', '<body>\n<script>window.COS_BUILD = "single";</script>');
  fs.writeFileSync(path.join(DIST, 'cursus-cos.html'), html);
  // fragment: for hosts that wrap the page in their own document skeleton
  const frag = html.replace(/<!doctype html>\s*/i, '').replace(/<html[^>]*>\s*/i, '').replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
    .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '').replace(/<\/html>\s*/i, '')
    .replace(/<meta charset="utf-8">\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '');
  fs.writeFileSync(path.join(DIST, 'cursus-cos.fragment.html'), frag);
  console.log(`dist/cursus-cos.html ${(html.length / 1024).toFixed(0)} KB, fragment ${(frag.length / 1024).toFixed(0)} KB`);
}
