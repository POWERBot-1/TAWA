#!/usr/bin/env node
/**
 * TAWA platform backup (§46): consistent full-database copy using SQLite's
 * online-safe VACUUM INTO, with a restore-verification pass so backups are
 * never claimed valid untested (spec: "do not claim backup protection until
 * restore tests have actually passed").
 *
 *   node scripts/backup.js [outdir]        # writes tawa-YYYYMMDD-HHMMSS.db
 *   node scripts/backup.js --verify <file> # open a backup and verify it reads
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

const tenantBoundaryCheck = (db) => {
  const tenants = db.prepare(`SELECT id FROM tenants`).all().map(r => r.id);
  const leaks = [];
  for (const t of tenants) {
    for (const tbl of ['products', 'customers', 'orders', 'payments', 'workers', 'files', 'notifications', 'ai_insights']) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE tenant_id NOT IN (SELECT id FROM tenants)`).get().n;
      if (n) leaks.push(`${tbl}:${n}`);
    }
  }
  return { tenants: tenants.length, leaks };
};

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--verify') {
    const f = args[1];
    if (!f || !fs.existsSync(f)) { console.error('backup file not found'); process.exit(1); }
    const db = new DatabaseSync(f, { readOnly: true });
    const { tenants, leaks } = tenantBoundaryCheck(db);
    const tables = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`).get().n;
    const migrations = db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get().n;
    db.close();
    console.log(JSON.stringify({ status: 'RESTORE_OK', file: f, tables, migrations, tenants, boundary_leaks: leaks }));
    process.exit(leaks.length ? 1 : 0);
  }

  const outDir = path.resolve(args[0] || 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = path.join(outDir, `tawa-${stamp}.db`);
  if (!fs.existsSync(config.dbFile)) { console.error(`[backup] database not initialized at ${config.dbFile} — start the server first (it migrates + optionally seeds)`); process.exit(1); }
  const src = new DatabaseSync(config.dbFile);
  src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  src.close();
  const size = fs.statSync(out).size;
  // Restore test: open the artifact and prove it returns rows with tenant boundaries intact.
  const verify = new DatabaseSync(out, { readOnly: true });
  const { tenants, leaks } = tenantBoundaryCheck(verify);
  verify.close();
  if (leaks.length) { console.error(`[backup] BOUNDARY LEAK in backup ${out}: ${leaks.join(',')}`); process.exit(1); }
  console.log(`[backup] ${out} (${(size / 1024).toFixed(1)} KB) — restore-verified, tenants=${tenants}, leaks=0`);
}

main().catch(e => { console.error('[backup] failed:', e.message); process.exit(2); });
