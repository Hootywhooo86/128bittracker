// Builds mobile/www (what Capacitor packages into the APK) from the shared
// web app in ../public plus the on-device engine in ../src.
import { build } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(root);
const www = join(root, 'www');

await rm(www, { recursive: true, force: true });
await mkdir(join(www, 'fonts'), { recursive: true });

// The web build talks HTTP; swap in the on-device transport.
const swapTransport = {
  name: 'swap-transport',
  setup(b) {
    b.onResolve({ filter: /^\.\/transport\.js$/ }, (args) =>
      args.importer.startsWith(join(repo, 'public')) ? { path: join(root, 'src', 'transport.js') } : undefined,
    );
  },
};

await build({
  entryPoints: [join(root, 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
  sourcemap: true,
  outfile: join(www, 'app.js'),
  plugins: [swapTransport],
  logLevel: 'warning',
});

// Offline fonts instead of Google Fonts.
await cp(join(root, 'assets', 'fonts'), join(www, 'fonts'), { recursive: true });
const css = await readFile(join(repo, 'public', 'app.css'), 'utf8');
await writeFile(join(www, 'app.css'), `@import url('/fonts/fonts.css');\n${css}`);

let html = await readFile(join(repo, 'public', 'index.html'), 'utf8');
html = html
  .replace(/\s*<link rel="preconnect"[^>]*>/g, '')
  .replace(/\s*<link href="https:\/\/fonts\.googleapis\.com[^>]*>/g, '')
  .replace('CONNECT</button>', 'SYNC</button>')
  .replace('<span class="ico">🔌</span>', '<span class="ico">🔄</span>');
await writeFile(join(www, 'index.html'), html);

await cp(join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm-browser.wasm'), join(www, 'sql-wasm-browser.wasm'));
console.log('www built →', www);
