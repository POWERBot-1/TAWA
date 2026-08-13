import { q, id, nowIso } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqOneOf } from '../core/http.js';
import { mustAuth } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { PLANS, PLAN_MATRIX, usageFor } from '../core/entitlements.js';
import { verifyLedgerIntegrity, seedCoa } from '../modules/ledger.js';
import { hashPassword } from '../core/auth.js';
import { ROLE_TEMPLATES, PERMISSIONS } from '../core/rbac.js';

/**
 * Admin Control Plane (§46). Platform operators only — tenant_id is NULL
 * on their sessions. Privileged actions are audited (§58 test 10).
 */
function mustPlatformAdmin(req) {
  const auth = mustAuth(req);
  if (auth.session.tenant_id) throw err.forbidden('Control plane is for platform operators only');
  return auth;
}

export function registerAdmin(router, db) {
  router.get('/api/v1/admin/overview', (req, res) => {
    mustPlatformAdmin(req);
    ok(res, {
      tenants: q.one(db, `SELECT COUNT(*) AS n FROM tenants`).n,
      active_tenants: q.one(db, `SELECT COUNT(*) AS n FROM tenants WHERE status = 'ACTIVE'`).n,
      users: q.one(db, `SELECT COUNT(*) AS n FROM users WHERE tenant_id IS NOT NULL`).n,
      orders_today: q.one(db, `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?`, new Date().toISOString().slice(0, 10)).n,
      payments_today: q.one(db, `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE received_at >= ? AND direction = 'INBOUND'`, new Date().toISOString().slice(0, 10)).s,
      ai_requests_month: q.one(db, `SELECT COALESCE(SUM(count),0) AS s FROM usage_counters WHERE meter = 'ai_requests'`).s,
      messages_month: q.one(db, `SELECT COALESCE(SUM(count),0) AS s FROM usage_counters WHERE meter = 'messages_sent'`).s,
      events: q.one(db, `SELECT COUNT(*) AS n FROM events`).n,
    });
  });

  router.get('/api/v1/admin/tenants', (req, res) => {
    mustPlatformAdmin(req);
    const rows = q.all(db, `SELECT t.*, b.business_name, s.plan_id, s.status AS subscription_status,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS users,
      (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id) AS orders,
      (SELECT COUNT(*) FROM products p WHERE p.tenant_id = t.id) AS products
      FROM tenants t
      LEFT JOIN tenant_branding b ON b.tenant_id = t.id
      LEFT JOIN subscriptions s ON s.tenant_id = t.id
      ORDER BY t.created_at`);
    ok(res, rows);
  });

  /** Suspend / restore tenants (§46, §55). Never destroys data. */
  router.post('/api/v1/admin/tenants/:id/status', async (req, res) => {
    mustPlatformAdmin(req);
    const body = await readBody(req);
    const to = reqOneOf(reqStr(body.status, 'status'), 'status', ['ACTIVE', 'GRACE', 'RESTRICTED', 'SUSPENDED', 'EXPIRED', 'CANCELLED', 'TRIAL']);
    const t = q.one(db, `SELECT * FROM tenants WHERE id = ?`, req.params.id);
    if (!t) throw err.notFound('Tenant not found');
    q.run(db, `UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?`, to, nowIso(), t.id);
    q.run(db, `UPDATE subscriptions SET status = ?, updated_at = ? WHERE tenant_id = ?`,
      to === 'ACTIVE' ? 'ACTIVE' : to, nowIso(), t.id);
    q.run(db, `UPDATE licenses SET state = ?, updated_at = ? WHERE tenant_id = ?`,
      to === 'ACTIVE' ? 'ACTIVE' : to === 'TRIAL' ? 'TRIAL' : ['GRACE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(to) ? to : 'SUSPENDED', nowIso(), t.id);
    audit(db, { tenantId: t.id, actorId: req.auth.user.id, actorName: req.auth.user.name, action: 'admin.tenant.status', resource: 'tenant', resourceId: t.id, metadata: { from: t.status, to } });
    ok(res, { id: t.id, status: to });
  });

  /** Provision a tenant end-to-end (§34 product provisioning chain). */
  router.post('/api/v1/admin/tenants', async (req, res) => {
    mustPlatformAdmin(req);
    const body = await readBody(req);
    const code = reqStr(body.code, 'code', { min: 3, max: 30 }).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(code)) throw err.unprocessable('Tenant code must be lowercase letters, digits, hyphens');
    if (q.one(db, `SELECT id FROM tenants WHERE code = ?`, code)) throw err.conflict(`Tenant code "${code}" already exists`);
    const planId = reqOneOf(body.plan_id || 'FREE', 'plan_id', PLANS.map(p => p.id));
    const name = reqStr(body.name, 'name');
    const result = provisionTenant(db, { code, name, planId, ownerEmail: reqStr(body.owner_email, 'owner_email').toLowerCase(), ownerName: reqStr(body.owner_name, 'owner_name'), ownerPassword: reqStr(body.owner_password, 'owner_password'), industry: optStr(body.industry, 'industry') || 'HARDWARE', branding: body.branding || {} });
    audit(db, { tenantId: result.tenant.id, actorId: req.auth.user.id, actorName: req.auth.user.name, action: 'admin.tenant.provision', resource: 'tenant', resourceId: result.tenant.id, metadata: { plan: planId } });
    created(res, result);
  });

  router.get('/api/v1/admin/audit', (req, res) => {
    mustPlatformAdmin(req);
    const rows = q.all(db, `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 400`);
    ok(res, rows);
  });

  router.get('/api/v1/admin/integrity', (req, res) => {
    mustPlatformAdmin(req);
    const tenants = q.all(db, `SELECT id, code FROM tenants`);
    ok(res, {
      ledger: tenants.map(t => ({ tenant: t.code, ...verifyLedgerIntegrity(db, t.id) })),
      movements_mutation_guard: 'enforced by DB triggers',
      audit_mutation_guard: 'enforced by DB triggers',
    });
  });

  router.get('/api/v1/admin/usage', (req, res) => {
    mustPlatformAdmin(req);
    const tenants = q.all(db, `SELECT id, code, name FROM tenants`);
    ok(res, tenants.map(t => ({ tenant: t.code, meters: usageFor(db, t.id) })));
  });
  void created; void PLAN_MATRIX;
}

/**
 * Tenant provisioning chain (§34):
 * CUSTOMER → IDENTITY → SUBSCRIPTION → ENTITLEMENTS → LICENSE → TENANT →
 * BRANDING → ADMIN.
 */
export function provisionTenant(db, { code, name, planId, ownerEmail, ownerName, ownerPassword, industry = 'HARDWARE', branding = {} }) {
  const tenantId = id('tn');
  const subId = id('sub');
  const now = nowIso();
  q.run(db, `INSERT INTO tenants (id, code, name, industry, status, created_at, updated_at) VALUES (?,?,?,?, 'TRIAL', ?, ?)`,
    tenantId, code, name, industry, now, now);
  q.run(db, `INSERT INTO tenant_branding (tenant_id, business_name, logo_monogram, color_primary, color_accent, white_label, updated_at)
             VALUES (?,?,?,?,?,?,?)`,
    tenantId, branding.business_name || name, (branding.logo_monogram || name[0] || 'T').slice(0, 2).toUpperCase(),
    branding.color_primary || '#F5A524', branding.color_accent || branding.color_primary || '#F5A524', branding.white_label ? 1 : 0, now);
  q.run(db, `INSERT INTO tenant_domains (id, tenant_id, host, kind, is_primary, verified, created_at) VALUES (?,?,?,?,1,1,?)`,
    id('dom'), tenantId, `${code}.tawa.app`, 'SUBDOMAIN', now);
  q.run(db, `INSERT INTO subscriptions (id, tenant_id, plan_id, status, starts_at, trial_ends_at, renews_at, created_at, updated_at)
             VALUES (?,?,?, 'TRIAL', ?, ?, ?, ?, ?)`,
    subId, tenantId, planId, now, new Date(Date.now() + 14 * 86400_000).toISOString(), new Date(Date.now() + 30 * 86400_000).toISOString(), now, now);
  q.run(db, `INSERT INTO licenses (id, tenant_id, subscription_id, state, starts_at, expires_at, created_at, updated_at)
             VALUES (?,?,?, 'TRIAL', ?, ?, ?, ?)`,
    id('lic'), tenantId, subId, now, new Date(Date.now() + 14 * 86400_000).toISOString(), now, now);
  seedCoa(db, tenantId);
  // Roles
  for (const [rname, tpl] of Object.entries(ROLE_TEMPLATES)) {
    if (rname === 'PLATFORM_SUPER_ADMIN') continue;
    const roleId = id('rol');
    q.run(db, `INSERT INTO roles (id, tenant_id, name, description, is_system, created_at) VALUES (?,?,?,?,1,?)`, roleId, tenantId, rname, tpl.description, now);
    for (const perm of tpl.perms) {
      q.run(db, `INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?,?)`, roleId, perm);
    }
  }
  // Defaults: loyalty tiers + basic feature flags
  for (const [name2, min] of [['BRONZE', 0], ['SILVER', 500], ['GOLD', 2000], ['PLATINUM', 8000]]) {
    q.run(db, `INSERT INTO loyalty_tiers (tenant_id, name, min_points) VALUES (?,?,?)`, tenantId, name2, min);
  }
  for (const f of ['ENABLE_POS', 'ENABLE_AI', 'ENABLE_ACCOUNTING', 'ENABLE_DELIVERY']) {
    q.run(db, `INSERT INTO feature_flags (tenant_id, flag, enabled) VALUES (?,?,1)`, tenantId, f);
  }
  const ownerId = id('usr');
  q.run(db, `INSERT INTO users (id, tenant_id, email, name, password_hash, status, created_at, updated_at) VALUES (?,?,?,?,?, 'ACTIVE', ?, ?)`,
    ownerId, tenantId, ownerEmail, ownerName, hashPassword(ownerPassword), now, now);
  const ownerRole = q.one(db, `SELECT id FROM roles WHERE tenant_id = ? AND name = 'OWNER'`, tenantId);
  q.run(db, `INSERT INTO user_roles (user_id, role_id) VALUES (?,?)`, ownerId, ownerRole.id);
  return { tenant: { id: tenantId, code, name }, owner: { id: ownerId, email: ownerEmail }, entitlement_count: (PLAN_MATRIX[planId] || []).length };
}
