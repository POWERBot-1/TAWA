import http from 'node:http';
import crypto from 'node:crypto';
import { Router, send } from './core/http.js';
import { resolveAuth, enforceCsrf } from './core/auth.js';
import { tenancyMiddleware } from './core/tenancy.js';
import { registerIdentity } from './routes/identity.js';
import { registerCatalog } from './routes/catalog.js';
import { registerInventory } from './routes/inventory.js';
import { registerSales } from './routes/sales.js';
import { registerPayments } from './routes/payments.js';
import { registerRelationships } from './routes/relationships.js';
import { registerProcurement } from './routes/procurement.js';
import { registerWorkforce } from './routes/workforce.js';
import { registerLogistics } from './routes/logistics.js';
import { registerMoney } from './routes/money.js';
import { registerComms } from './routes/comms.js';
import { registerIntel } from './routes/intel.js';
import { registerSettings } from './routes/settings.js';
import { registerAdmin } from './routes/admin.js';
import { registerKeys } from './routes/keys.js';
import { registerFileRoutes, serveBrandLogo } from './routes/files.js';
import { q } from './db/connection.js';
import { config } from './config.js';

const buckets = new Map(); // naive sliding-window limiter (sufficient at dev scale)
function rateLimit(req) {
  if (!req.path?.startsWith('/api/')) return;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const key = `${ip}`;
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < config.rateLimit.windowMs);
  if (arr.length >= config.rateLimit.max) {
    const e = new Error('Rate limit exceeded'); e.status = 429; e.code = 'RATE_LIMITED'; throw e;
  }
  arr.push(now); buckets.set(key, arr);
}

export function buildApp(db) {
  const router = new Router();

  router.use((req) => {
    req.id = crypto.randomUUID();
    req.start = Date.now();
  });
  router.use(rateLimit);
  // Security headers for all API responses
  router.use((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });
  router.use(resolveAuthMiddleware(db));
  router.use(csrfMiddleware);
  router.use(tenancyMiddleware(db));

  router.get('/health', (_req, res) => send(res, 200, { status: 'ok', product: 'TAWA', version: config.product.version }));
  router.get('/ready', (_req, res) => {
    try {
      q.one(db, `SELECT 1 AS ok`);
      const tenants = q.one(db, `SELECT COUNT(*) AS n FROM tenants`).n;
      send(res, 200, { status: 'ready', db: 'up', tenants, version: config.product.version });
    } catch (e) {
      send(res, 503, { status: 'not_ready', db: 'down', message: e.message });
    }
  });
  router.get('/api/v1/meta', (_req, res) => send(res, 200, {
    product: 'TAWA', version: config.product.version, api: 'v1',
    platform: { name: 'JATA Qi', mode: 'integrated-seam' },
    modules: ['commerce', 'pos', 'inventory', 'procurement', 'customers', 'suppliers', 'brokers', 'workers', 'payroll', 'payments', 'credit', 'expenses', 'accounting', 'deliveries', 'alerts', 'marketing', 'analytics', 'ai', 'reports', 'white-label'],
  }));

  registerIdentity(router, db);
  registerCatalog(router, db);
  registerInventory(router, db);
  registerSales(router, db);
  registerPayments(router, db);
  registerRelationships(router, db);
  registerProcurement(router, db);
  registerWorkforce(router, db);
  registerLogistics(router, db);
  registerMoney(router, db);
  registerComms(router, db);
  registerIntel(router, db);
  registerSettings(router, db);
  registerAdmin(router, db);
  registerKeys(router, db);
  registerFileRoutes(router, db);
  router.get('/api/v1/public/tenants/:code/logo', (req, res) => serveBrandLogo(db, req, res, req.params.code));

  return http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/') || ['/health', '/ready'].includes(new URL(req.url, 'http://x').pathname)) {
      res.socket.setNoDelay?.(true);
      return router.handle(req, res);
    }
    return serveStatic(req, res);
  });
}

function resolveAuthMiddleware(db) {
  return (req) => {
    const auth = resolveAuth(db, req);
    req.auth = auth || null;
  };
}
function csrfMiddleware(req) {
  if (!req.path?.startsWith('/api/v1/')) return;
  if (req.path.startsWith('/api/v1/webhooks/') || req.path.startsWith('/api/v1/auth/login') || req.path.startsWith('/api/v1/auth/logout')) return;
  enforceCsrf(req.auth, req);
}

/* ---------------- Static file server (no-cache HTML, immutable assets) ---------------- */
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://internal');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('..') || pathname.includes('\0')) { res.writeHead(400); return res.end(); }
  let file = path.join(config.webRoot, pathname);
  if (pathname === '/' || pathname === '') file = path.join(config.webRoot, 'index.html');
  let stat = null;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (stat?.isDirectory()) file = path.join(file, 'index.html');
  if (!stat) {
    // SPA fallback for client-side routes
    if (!path.extname(pathname)) file = path.join(config.webRoot, 'index.html');
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat) { res.writeHead(404); return res.end('Not found'); }
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  };
  headers['Cache-Control'] = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}
