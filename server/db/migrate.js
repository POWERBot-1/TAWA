import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Migration runner. Every schema change is a numbered migration file.
 * Never modify schema outside migrations (§51).
 */
export function runMigrations(db = getDb()) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  )`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  const out = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
      out.push(f);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${err.message}`);
    }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  const applied = runMigrations(getDb());
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema up to date.');
}
