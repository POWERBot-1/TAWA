#!/usr/bin/env node
/**
 * TAWA release packager.
 *
 * Produces a reproducible source distribution:
 *   out/tawa-<version>-<yyyymmdd>.tar.gz   — the deliverable archive
 *   out/CHECKSUMS.txt                      — sha256 of the archive
 *   out/manifest.json                      — release manifest (contents, hashes)
 *
 * Excludes: .git, data/ (runtime SQLite), uploads, node_modules, out/, logs,
 * .env files. Runs `scripts/validate.js` first unless --skip-validate.
 *
 * Usage: node scripts/package.js [--skip-validate]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_VALIDATE = process.argv.includes('--skip-validate');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const EXCLUDE_DIRS = new Set(['.git', 'data', 'out', 'node_modules']);
const EXCLUDE_FILES = /(\.log$|^\.env(\..+)?$)/;

function collect(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, base, out);
    else if (!EXCLUDE_FILES.test(e.name)) out.push(path.relative(base, p));
  }
  return out;
}

if (!SKIP_VALIDATE) {
  const v = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate.js')], { stdio: 'inherit' });
  if (v.status !== 0) { console.error('[package] validation failed — aborting'); process.exit(1); }
}

const files = collect(ROOT);
const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const name = `tawa-${pkg.version}-${stamp}`;
const outDir = path.join(ROOT, 'out');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const tar = `${name}.tar.gz`;
const r = spawnSync('tar', ['-czf', path.join(outDir, tar), '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-C', ROOT, ...files], { encoding: 'utf8' });
if (r.status !== 0) { console.error('[package] tar failed:', r.stderr); process.exit(1); }

const bytes = fs.readFileSync(path.join(outDir, tar));
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(outDir, 'CHECKSUMS.txt'), `${sha}  ${tar}\n`);

const manifest = {
  product: 'TAWA',
  tagline: 'Run Your Hardware Business.',
  version: pkg.version,
  packaged_at: new Date().toISOString(),
  archive: tar,
  sha256: sha,
  files: files.length,
  bytes: bytes.length,
  includes: { runtime: ['server/', 'web/'], migrations: 'server/db/migrations/', tests: 'tests/', deploy: ['Dockerfile', 'docker-compose.yml', '.env.example'], docs: ['README.md', 'ARCHITECTURE.md', 'docs/API.md'] },
  runtime: { node: '>=22.5', dependencies: 0, database: 'embedded sqlite (node:sqlite, WAL)' },
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`[package] ${tar}  (${files.length} files, ${(bytes.length / 1024).toFixed(1)} KiB)`);
console.log(`[package] sha256 ${sha}`);
console.log(`[package] manifest → out/manifest.json`);
