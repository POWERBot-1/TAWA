import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, q, id, nowIso } from '../server/db/connection.js';
import { runMigrations } from '../server/db/migrate.js';
import { buildApp } from '../server/app.js';
import { provisionTenant } from '../server/routes/admin.js';
import { hashPassword } from '../server/core/auth.js';
import { PERMISSIONS } from '../server/core/rbac.js';
import { PLANS, PLAN_MATRIX, ENTITLEMENTS } from '../server/core/entitlements.js';
import { postMovement } from '../server/modules/inventory.js';

let counter = 0;

/** Fresh DB + listening server for a test. */
export async function makeStack() {
  const file = path.join(os.tmpdir(), `tawa-test-${process.pid}-${counter++}-${crypto.randomBytes(4).toString('hex')}.db`);
  const db = openDb(file);
  runMigrations(db);
  seedGlobals(db);
  const server = buildApp(db);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, base,
    async close() { await new Promise(r => server.close(r)); try { fs.unlinkSync(file); } catch {} },
  };
}

export function seedGlobals(db) {
  for (const [code, name] of [['piece', 'Piece'], ['bag', 'Bag'], ['sheet', 'Sheet'], ['length', 'Length']]) {
    q.run(db, `INSERT OR IGNORE INTO units (id, code, name) VALUES (?,?,?)`, id('un'), code, name);
  }
  for (const p of PLANS) q.run(db, `INSERT OR IGNORE INTO plans (id, name, description, seat_limit, branch_limit, product_limit, monthly_price_minor, sort) VALUES (?,?,?,?,?,?,?,?)`, p.id, p.name, p.description, p.seats, p.branches, p.products, p.price * 100, p.sort);
  for (const [code, label, module] of ENTITLEMENTS) q.run(db, `INSERT OR IGNORE INTO entitlements (code, label, module) VALUES (?,?,?)`, code, label, module);
  for (const [plan, list] of Object.entries(PLAN_MATRIX)) for (const e of list) q.run(db, `INSERT OR IGNORE INTO plan_entitlements (plan_id, entitlement) VALUES (?,?)`, plan, e);
  for (const p of PERMISSIONS) q.run(db, `INSERT OR IGNORE INTO permissions (code, label, grp) VALUES (?,?,?)`, p, p, p.split('.')[0]);
}

export function makeTenant(db, { code, plan = 'BUSINESS', domain = null } = {}) {
  const { tenant, owner } = provisionTenant(db, {
    code, name: `${code.toUpperCase()} Test Co.`, planId: plan,
    ownerEmail: `owner@${code}.test`, ownerName: 'Test Owner', ownerPassword: 'Owner#Test1',
    branding: { business_name: `${code.toUpperCase()} TEST`, logo_monogram: 'TT' },
  });
  q.run(db, `UPDATE tenants SET status = 'ACTIVE' WHERE id = ?`, tenant.id);
  q.run(db, `UPDATE subscriptions SET status = 'ACTIVE' WHERE tenant_id = ?`, tenant.id);
  if (domain) q.run(db, `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verified, created_at) VALUES (?,?,?, 'CUSTOM', 1, 1, ?)`, id('dom'), tenant.id, domain, nowIso());
  return { tenant, owner, ownerEmail: `owner@${code}.test`, ownerPassword: 'Owner#Test1' };
}

export function makeUser(db, tenantId, email, role, password = 'Test#Pass1') {
  const uid = id('usr');
  q.run(db, `INSERT INTO users (id, tenant_id, email, name, password_hash, status, created_at, updated_at) VALUES (?,?,?,?,?, 'ACTIVE', ?, ?)`,
    uid, tenantId, email, `${role} User`, hashPassword(password), nowIso(), nowIso());
  const r = q.one(db, `SELECT id FROM roles WHERE tenant_id = ? AND name = ?`, tenantId, role);
  q.run(db, `INSERT INTO user_roles (user_id, role_id) VALUES (?,?)`, uid, r.id);
  return { id: uid, email, password };
}

/** Minimal trading fixture: warehouse + product with stock + customer. */
export function makeFixture(db, tenantId, { stock = 100, costPrice = 50000, retailPrice = 75000 } = {}) {
  const now = nowIso();
  const wh = id('wh');
  q.run(db, `INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?,?, 'MAIN', 'Main WH', ?)`, wh, tenantId, now);
  const prod = id('prd');
  q.run(db, `INSERT INTO products (id, tenant_id, sku, name, unit, cost_price, price_retail, price_min, tax_category, reorder_point, status, is_active, created_at, updated_at)
             VALUES (?,?,?,?, 'bag', ?,?,?, 'VAT16', 10, 'ACTIVE', 1, ?, ?)`,
    prod, tenantId, 'CEM-1', 'Test Cement 50kg', costPrice, retailPrice, costPrice, now, now);
  const prod2 = id('prd');
  q.run(db, `INSERT INTO products (id, tenant_id, sku, name, unit, cost_price, price_retail, price_min, tax_category, status, is_active, created_at, updated_at)
             VALUES (?,?,?,?, 'sheet', ?, 900000, 800000, 'VAT16', 'ACTIVE', 1, ?, ?)`,
    prod2, tenantId, 'SH-1', 'Test Sheet 2m', 700000, now, now);
  postMovement(db, { tenantId, productId: prod, warehouseId: wh, type: 'RECEIVE', qty: stock, reason: 'fixture' });
  postMovement(db, { tenantId, productId: prod2, warehouseId: wh, type: 'RECEIVE', qty: stock, reason: 'fixture' });
  const cust = id('cus');
  q.run(db, `INSERT INTO customers (id, tenant_id, code, name, phone, type, segment, marketing_opt_in, notify_prefs, created_at, updated_at)
             VALUES (?,?, 'C-FX1', 'Fixture Customer', '+254700123456', 'RETAIL', 'RETAIL', 1, '{}', ?, ?)`, cust, tenantId, now, now);
  return { warehouse: wh, product: prod, product2: prod2, customer: cust };
}

export async function login(base, email, password, headers = {}) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.data) throw new Error(`login failed for ${email}: ${JSON.stringify(json)}`);
  return { token: json.data.token, csrf: json.data.csrf, user: json.data.user };
}

/** API call helper. Bearer auth (CSRF path skipped for bearer). */
export async function api(base, token, method, path, body, headers = {}) {
  const canBody = !['GET', 'HEAD'].includes(method);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body !== undefined && canBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined && canBody ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

export function signWebhook(secret, rawBody, ts = Date.now()) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return { sig, ts };
}
