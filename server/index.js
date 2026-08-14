import { getDb } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { seedIfEmpty } from './seed/seed.js';
import { buildApp } from './app.js';
import { config } from './config.js';

const db = getDb();
const applied = runMigrations(db);
if (applied.length) console.log(`[tawa] applied ${applied.length} migration(s): ${applied.join(', ')}`);

if (process.argv.includes('--seed')) {
  const r = seedIfEmpty(db);
  if (r.seeded) console.log('[tawa] demo data seeded (ALPHA HARDWARE + BUILDPRO SUPPLIES + KILIMANI BUILDERS + platform admin)');
}

const server = buildApp(db);
server.listen(config.port, config.host, () => {
  console.log(`[tawa] TAWA ${config.product.version} listening on http://${config.host}:${config.port}`);
  console.log(`[tawa] health: /health  ready: /ready  api: /api/v1`);
});

process.on('SIGTERM', () => { console.log('[tawa] shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('[tawa] shutting down'); server.close(() => process.exit(0)); });
