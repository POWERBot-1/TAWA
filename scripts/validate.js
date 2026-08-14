#!/usr/bin/env node
/**
 * TAWA build validator.
 *
 * Verifies the deliverable without requiring any external tooling:
 *   1. Every JavaScript file parses (node --check semantics, in-process).
 *   2. Required project files exist (Dockerfile, compose, README, …).
 *   3. Migrations apply cleanly to a throwaway database (and are enumerable).
 *   4. The full app boots and serves /health, /ready, /api/v1/meta and the SPA.
 *   5. A real seeded login works, RBAC gates respond, and a sandbox POS sale
 *      settles end-to-end (idempotent → smoke of inventory + ledger + payments).
 *   6. Web assets referenced by index.html are actually served.
 *
 * Usage: node scripts/validate.js [--skip-api]
 * Exit code 0 = PASS, 1 = FAIL. Prints a checklist summary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, why) => results.push({ name, pass: false, why });
const SKIP_API = process.argv.includes('--skip-api');

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git', 'data', 'out'].includes(e.name)) walk(p, ext, out); }
    else if (ext.some(x => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// ── 1. Syntax ────────────────────────────────────────────────────────────────
{
  const files = walk(ROOT, ['.js']);
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${path.relative(ROOT, f)}: ${r.stderr.split('\n')[0]}`);
  }
  bad.length ? fail('JS syntax (all files)', bad.join(' | ')) : ok(`JS syntax — ${files.length} files parse`);
}

// ── 2. Required files ────────────────────────────────────────────────────────
{
  const required = ['package.json', 'README.md', 'ARCHITECTURE.md', 'Dockerfile', 'docker-compose.yml',
    '.env.example', '.dockerignore', 'server/index.js', 'server/app.js', 'web/index.html',
    'web/css/tokens.css', 'web/css/app.css', 'web/js/main.js', 'tests/acceptance.test.js',
    'tests/invariants.test.js', 'tests/helpers.js', 'product.manifest.json'];
  const missing = required.filter(f => !fs.existsSync(path.join(ROOT, f)));
  missing.length ? fail('required files', `missing: ${missing.join(', ')}`) : ok(`required files — ${required.length} present`);
}

// ── 3. Migrations ────────────────────────────────────────────────────────────
let dbFile = null;
const { openDb } = await import('../server/db/connection.js');
const { runMigrations } = await import('../server/db/migrate.js');
{
  try {
    dbFile = path.join(os.tmpdir(), `tawa-validate-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
    const db = openDb(dbFile);
    const applied = runMigrations(db);
    const again = runMigrations(db); // must be idempotent
    const q = (await import('../server/db/connection.js')).q;
    const tables = q.one(db, `SELECT COUNT(*) n FROM sqlite_master WHERE type='table'`).n;
    db.close();
    if (applied.length >= 6 && again.length === 0 && tables > 30) ok(`migrations — ${applied.length} applied, idempotent, ${tables} tables`);
    else fail('migrations', `applied=${applied.length} re-run=${again.length} tables=${tables}`);
  } catch (e) { fail('migrations', e.message); }
}

// ── 4–6. Live API smoke (boots a throwaway instance) ─────────────────────────
if (!SKIP_API) {
  const { buildApp } = await import('../server/app.js');
  const { seedIfEmpty } = await import('../server/seed/seed.js');
  let server = null;
  try {
    const db = openDb(dbFile);
    const r = seedIfEmpty(db);
    if (!r.seeded) throw new Error('seed did not provision demo tenants');
    server = buildApp(db);
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p, tok) => (await fetch(base + p, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {}));
    const post = async (p, body, tok) => (await fetch(base + p, {
      method: 'POST', body: JSON.stringify(body ?? {}),
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    }));

    // health / ready / meta
    const h = await (await get('/health')).json();
    const rd = await (await get('/ready')).json();
    const meta = await (await get('/api/v1/meta')).json();
    (h.status === 'ok' && rd.status === 'ready' && rd.tenants === 3 && meta.modules?.length >= 15)
      ? ok(`health/ready/meta — ${rd.tenants} demo tenants, ${meta.modules.length} modules`)
      : fail('health/ready/meta', JSON.stringify({ h, rd, mods: meta.modules?.length }));

    // SPA + static assets referenced by index.html
    const index = await (await get('/')).text();
    const refs = [...index.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map(m => m[1]).filter(u => !u.startsWith('//'));
    const badRefs = [];
    for (const u of new Set(refs)) { const r = await get(u); if (r.status !== 200) badRefs.push(`${u}:${r.status}`); await r.arrayBuffer(); }
    badRefs.length ? fail('web assets', badRefs.join(', ')) : ok(`web assets — SPA + ${new Set(refs).size} referenced files served`);

    // Login (both demo tenants + platform admin), RBAC denial, POS sale
    const login = async (tenant_code, email, password) => {
      const r = await post('/api/v1/auth/login', { tenant_code, email, password });
      const j = await r.json();
      if (!j.data?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(j)}`);
      return j.data.token;
    };
    const tokA = await login('alpha', 'owner@alpha-hardware.co.ke', 'Alpha#2026!');
    const tokB = await login('buildpro', 'owner@buildpro.co.ke', 'Build#2026!');
    await login(null, 'platform@tawa.app', 'Admin#2026!');

    // RBAC: cashier must not reach admin routes
    const tokCashier = await login('alpha', 'cashier@alpha-hardware.co.ke', 'Alpha#2026!');
    const denied = await get('/api/v1/admin/tenants', tokCashier);
    denied.status === 403 ? ok('RBAC — cashier blocked from control plane (403)') : fail('RBAC', `expected 403 got ${denied.status}`);

    // Tenant isolation: B cannot read A's products
    const pa = await (await get('/api/v1/products?limit=1', tokA)).json();
    const probe = await get(`/api/v1/products/${pa.data[0].id}`, tokB);
    (probe.status === 404 || probe.status === 403) ? ok('tenancy — cross-tenant object read denied') : fail('tenancy', `expected 404/403 got ${probe.status}`);

    // POS sale, edition-neutral
    const prod = pa.data[0];
    const key = `validate-${Date.now()}`;
    const sale = await post('/api/v1/pos/sale', { idempotency_key: key, method: 'CASH', items: [{ product_id: prod.id, qty: 1 }] }, tokA);
    const saleJ = await sale.json();
    if (sale.status !== 201 || !saleJ.data?.order || !saleJ.data?.payment) throw new Error(`POS sale failed: ${JSON.stringify(saleJ)}`);
    // Idempotent replay must return the same order
    const replay = await post('/api/v1/pos/sale', { idempotency_key: key, method: 'CASH', items: [{ product_id: prod.id, qty: 1 }] }, tokA);
    const replayJ = await replay.json();
    replayJ.data?.order?.id === saleJ.data.order.id
      ? ok(`POS smoke — sale ${saleJ.data.order.number} settled + idempotent replay`)
      : fail('POS idempotency', 'replay returned a different order');
  } catch (e) {
    fail('live API smoke', e.message);
  } finally {
    if (server) await new Promise(r => server.close(r));
  }
}
if (dbFile) { for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch {} } }

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\nTAWA validate\n─────────────');
let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `\n      ${r.why}`}`);
  if (!r.pass) failed++;
}
console.log(`─────────────\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
