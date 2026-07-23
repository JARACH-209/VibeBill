/**
 * Build a standalone vibebill binary with Node's Single Executable
 * Applications (SEA): tsc output -> one CJS bundle -> SEA blob -> injected
 * into a copy of the running node binary. Run on the TARGET platform (CI
 * builds each OS natively); artifacts land in build/sea/.
 *
 * Dependency note (spec §14.3.6): esbuild and postject are devDependencies
 * used ONLY by this release pipeline, never at runtime. SEA requires a single
 * CommonJS entry file, which tsc alone cannot produce from the ESM source
 * tree (D15 in docs/decisions.md). The npm package remains tsc-only.
 *
 *   node scripts/build-sea.mjs          # expects `npm run build` done
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSync } from 'esbuild';
import { inject } from 'postject';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build', 'sea');
const entry = path.join(root, 'dist', 'src', 'cli', 'index.js');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd: root, ...opts });

if (!existsSync(entry)) {
  console.error('dist not found — run `npm run build` first');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const prices = readFileSync(path.join(root, 'prices', 'prices.json'), 'utf8');
JSON.parse(prices); // fail fast on a corrupt table rather than baking it in

// 1. Bundle to a single CJS file. import.meta.url is rewritten to a shim
//    declared in the banner; the banner also embeds version + price table
//    (a SEA binary has no package.json or prices.json on disk).
const banner = [
  `globalThis.__vibebillVersion = ${JSON.stringify(pkg.version)};`,
  `globalThis.__vibebillBundledPrices = ${prices};`,
  `const __VIBEBILL_IMU__ = require('node:url').pathToFileURL(__filename).href;`,
].join('\n');
const bundle = path.join(outDir, 'bundle.cjs');
buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: bundle,
  define: { 'import.meta.url': '__VIBEBILL_IMU__' },
  banner: { js: banner },
  logLevel: 'warning',
});

// 2. SEA blob.
const seaConfig = path.join(outDir, 'sea-config.json');
const blob = path.join(outDir, 'sea-prep.blob');
writeFileSync(
  seaConfig,
  JSON.stringify(
    { main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false },
    null,
    2,
  ),
);
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. Inject into a copy of a FULL-FAT node binary. Package-manager builds
//    (e.g. Homebrew) ship a tiny stub linking libnode.dylib — the SEA fuse
//    lives in the library, so injection needs the official static build.
//    CI's setup-node provides one; locally we download the matching release.
function resolveTargetNode() {
  const override = process.env['SEA_NODE_BINARY'];
  if (override !== undefined && override !== '') return override;
  const fullFat = statSync(process.execPath).size > 20 * 1024 * 1024;
  if (fullFat) return process.execPath;
  if (process.platform === 'win32') {
    console.error('shared-library node detected; set SEA_NODE_BINARY to an official node.exe');
    process.exit(1);
  }
  const ver = process.version;
  const base = `node-${ver}-${process.platform}-${process.arch}`;
  const cacheDir = path.join(outDir, 'node-dist');
  const nodePath = path.join(cacheDir, base, 'bin', 'node');
  if (!existsSync(nodePath)) {
    mkdirSync(cacheDir, { recursive: true });
    const url = `https://nodejs.org/dist/${ver}/${base}.tar.gz`;
    console.log(`fetching official node build for SEA base: ${url}`);
    const tarPath = path.join(cacheDir, `${base}.tar.gz`);
    execFileSync('curl', ['-fsSL', url, '-o', tarPath], { stdio: 'inherit' });
    execFileSync('tar', ['-xzf', tarPath, '-C', cacheDir], { stdio: 'inherit' });
  }
  return nodePath;
}

const platTag = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform] ?? process.platform;
const ext = process.platform === 'win32' ? '.exe' : '';
const binName = `vibebill-${platTag}-${process.arch}${ext}`;
const binPath = path.join(outDir, binName);
copyFileSync(resolveTargetNode(), binPath);
chmodSync(binPath, 0o755);

if (process.platform === 'darwin') {
  run('codesign', ['--remove-signature', binPath]);
}
await inject(binPath, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (process.platform === 'darwin') {
  run('codesign', ['-s', '-', binPath]); // ad-hoc signature so macOS will execute it
}

// 4. Smoke: the binary must report the packaged version.
const reported = execFileSync(binPath, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== pkg.version) {
  console.error(`smoke failed: binary reports ${JSON.stringify(reported)}, expected ${pkg.version}`);
  process.exit(1);
}
console.log(`built ${path.relative(root, binPath)} (${reported}, node ${process.version})`);
