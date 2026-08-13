import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

/** Read .env style overrides without any dependency. Never commit secrets. */
function env(key, fallback) {
  return process.env[key] !== undefined && process.env[key] !== '' ? process.env[key] : fallback;
}

const DATA_DIR = env('TAWA_DATA_DIR', path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const config = {
  env: env('TAWA_ENV', 'development'),
  port: Number(env('PORT', 8080)),
  host: env('HOST', '0.0.0.0'),
  dataDir: DATA_DIR,
  dbFile: env('TAWA_DB_FILE', path.join(DATA_DIR, 'tawa.db')),
  webRoot: path.join(ROOT, 'web'),
  uploadsDir: path.join(DATA_DIR, 'uploads'),
  // Session / security
  sessionTtlHours: Number(env('TAWA_SESSION_TTL_HOURS', 12)),
  cookieName: 'tawa_session',
  cookieSecure: env('TAWA_COOKIE_SECURE', 'false') === 'true',
  // Webhook signing secrets — sandbox defaults are explicitly sandbox-only.
  // Production deployments MUST set these via environment / secret manager.
  webhookSecrets: {
    mpesa_sandbox: env('TAWA_MPESAWebhookSecret_KEEPOUT', env('TAWA_WEBHOOK_SECRET_MPESA', 'sandbox-whsec-mpesa-local-dev-only')),
    card_sandbox: env('TAWA_WEBHOOK_SECRET_CARD', 'sandbox-whsec-card-local-dev-only'),
  },
  // Rate limits (requests per window)
  rateLimit: { windowMs: 60_000, max: 600, authMax: 20 },
  // Base currency default for new tenants (multi-currency capable).
  defaultCurrency: 'KES',
  defaultTimezone: 'Africa/Nairobi',
  product: { id: 'tawa', name: 'TAWA', version: '1.0.0', platform: 'jata-qi' },
};
