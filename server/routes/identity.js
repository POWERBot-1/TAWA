import { q, id, nowIso } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqOneOf } from '../core/http.js';
import { verifyPassword, hashPassword, createSession, revokeSession, clearSessionCookie, clientIp, mustAuth, mustPerm, checkPasswordPolicy } from '../core/auth.js';
import { tenantByHost } from '../core/tenancy.js';
import { audit } from '../core/audit.js';
import { ROLE_TEMPLATES } from '../core/rbac.js';
import { tenantEntitlements, usageFor } from '../core/entitlements.js';
import { config } from '../config.js';

const failedAttempts = new Map(); // lightweight login throttling

export function registerIdentity(router, db) {
  /** Public brand resolution for login/theme — non-sensitive fields only. */
  router.get('/api/v1/brand', (req, res) => {
    const host = req.query.host || req.headers['x-tenant-host'] || req.headers.host;
    let tenant = tenantByHost(db, host);
    if (!tenant && req.query.code) tenant = q.one(db, `SELECT * FROM tenants WHERE code = ?`, String(req.query.code));
    if (!tenant) tenant = q.one(db, `SELECT * FROM tenants WHERE status IN ('ACTIVE','TRIAL') ORDER BY created_at LIMIT 1`);
    if (!tenant) return err.notFound('No tenant configured'), undefined;
    const b = q.one(db, `SELECT * FROM tenant_branding WHERE tenant_id = ?`, tenant.id);
    const sub = tenantEntitlements(db, tenant.id);
    ok(res, {
      tenant: { code: tenant.code, name: tenant.name, industry: tenant.industry, currency: tenant.currency, country: tenant.country, status: tenant.status },
      branding: b ? {
        business_name: b.business_name, tagline: b.tagline, logo_monogram: b.logo_monogram, logo_url: b.logo_url,
        theme_mode: b.theme_mode, color_primary: b.color_primary, color_secondary: b.color_secondary,
        color_accent: b.color_accent, color_background: b.color_background, color_surface: b.color_surface,
        color_text: b.color_text, color_success: b.color_success, color_warning: b.color_warning, color_error: b.color_error,
        font_family: b.font_family, white_label: !!b.white_label, invoice_prefix: b.invoice_prefix,
      } : null,
      plan: sub.plan,
      product: { name: 'TAWA', tagline: 'Run Your Hardware Business', version: config.product.version },
    });
  });

  /** Public tenant directory for the login switcher (demo bootstrap surface). */
  router.get('/api/v1/public/tenants', (req, res) => {
    const tenants = q.all(db, `SELECT t.code, t.name, b.business_name, b.logo_monogram, b.color_primary, b.color_accent, b.theme_mode, t.status
      FROM tenants t LEFT JOIN tenant_branding b ON b.tenant_id = t.id WHERE t.status IN ('ACTIVE','TRIAL','GRACE','RESTRICTED') ORDER BY t.created_at`);
    ok(res, tenants);
  });

  router.post('/api/v1/auth/login', rateLimitLogin, async (req, res) => {
    const body = await readBody(req);
    const email = reqStr(body.email, 'email').toLowerCase();
    // Optional tenant code pins login to a tenant — still server-verified.
    let user = q.one(db, `SELECT * FROM users WHERE lower(email) = ?`, email);
    if (body.tenant_code && user) {
      const t = q.one(db, `SELECT id FROM tenants WHERE code = ?`, String(body.tenant_code));
      if (!t || (user.tenant_id && user.tenant_id !== t.id)) user = null;
    }
    const fail = (why) => {
      audit(db, { tenantId: user?.tenant_id ?? null, action: 'auth.login', result: 'FAILED', reason: why, metadata: { email }, ip: clientIp(req) });
      throw err.unauthorized('Invalid credentials');
    };
    if (!user) fail('no_such_user');
    if (user.status !== 'ACTIVE') fail('account_' + user.status.toLowerCase());
    if (!verifyPassword(reqStr(body.password, 'password'), user.password_hash)) {
      const n = (failedAttempts.get(user.id) || 0) + 1;
      failedAttempts.set(user.id, n);
      if (n >= 8) q.run(db, `UPDATE users SET status = 'LOCKED' WHERE id = ?`, user.id);
      fail(n >= 8 ? 'locked_after_failures' : 'bad_password');
    }
    failedAttempts.delete(user.id);
    const { token, csrf, expires_at } = createSession(db, user, req, res);
    q.run(db, `UPDATE users SET last_login_at = ? WHERE id = ?`, nowIso(), user.id);
    audit(db, { tenantId: user.tenant_id, actorId: user.id, actorName: user.name, action: 'auth.login', ip: clientIp(req) });
    ok(res, { token, csrf, expires_at, user: publicUser(db, user) });
  });

  function rateLimitLogin(req) {
    const ip = clientIp(req) || 'unknown';
    const key = `login:${ip}`;
    const now = Date.now();
    const recs = (failedAttempts.get(key) || []).filter(t => now - t < config.rateLimit.windowMs);
    if (recs.length >= config.rateLimit.authMax) throw err.tooMany();
    recs.push(now); failedAttempts.set(key, recs);
  }

  router.post('/api/v1/auth/logout', (req, res) => {
    resolveAndAudit(db, req, 'auth.logout');
    clearSessionCookie(res);
    if (req.auth) revokeSession(db, req.auth.tokenHash);
    ok(res, { logged_out: true });
  });

  router.get('/api/v1/auth/me', (req, res) => {
    const auth = mustAuth(req);
    ok(res, {
      user: publicUser(db, q.one(db, `SELECT * FROM users WHERE id = ?`, auth.user.id)),
      csrf: auth.session.csrf,
      perms: [...auth.perms].sort(),
      tenant: auth.session.tenant_id ? q.one(db, `SELECT id, code, name, status, currency, timezone FROM tenants WHERE id = ?`, auth.session.tenant_id) : null,
      entitlements: auth.session.tenant_id ? [...tenantEntitlements(db, auth.session.tenant_id).set] : [],
      usage: auth.session.tenant_id ? usageFor(db, auth.session.tenant_id) : [],
    });
  });

  router.post('/api/v1/auth/change-password', async (req, res) => {
    const auth = mustAuth(req);
    const body = await readBody(req);
    if (!verifyPassword(reqStr(body.current_password, 'current_password'), auth.user.password_hash)) {
      throw err.forbidden('Current password incorrect');
    }
    const issues = checkPasswordPolicy(reqStr(body.new_password, 'new_password'));
    if (issues.length) throw err.unprocessable(`Password needs ${issues.join(', ')}`);
    q.run(db, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, hashPassword(body.new_password), nowIso(), auth.user.id);
    q.run(db, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ?`, nowIso(), auth.user.id, auth.session.id);
    audit(db, { tenantId: req.tenantId ?? auth.user.tenant_id, actorId: auth.user.id, action: 'auth.password_change', ip: clientIp(req) });
    ok(res, { changed: true, other_sessions_revoked: true });
  });

  /* ---------------- Users & Roles (tenant admin) ---------------- */
  router.get('/api/v1/users', (req, res) => {
    mustPerm(req, 'users.manage');
    const rows = q.all(db, `SELECT u.id, u.email, u.name, u.phone, u.status, u.last_login_at, u.created_at,
      (SELECT json_group_array(r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles
      FROM users u WHERE u.tenant_id = ? ORDER BY u.name`, req.tenantId);
    ok(res, rows.map(r => ({ ...r, roles: JSON.parse(r.roles || '[]') })));
  });

  router.post('/api/v1/users', async (req, res) => {
    mustPerm(req, 'users.manage');
    const body = await readBody(req);
    const email = reqStr(body.email, 'email').toLowerCase();
    if (q.one(db, `SELECT id FROM users WHERE lower(email) = ?`, email)) throw err.conflict('Email already in use');
    const issues = checkPasswordPolicy(reqStr(body.password, 'password'));
    if (issues.length) throw err.unprocessable(`Password needs ${issues.join(', ')}`);
    const roleNames = Array.isArray(body.roles) && body.roles.length ? body.roles : ['GENERAL_WORKER'];
    const userId = id('usr');
    q.run(db, `INSERT INTO users (id, tenant_id, email, phone, name, password_hash, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?)`,
      userId, req.tenantId, email, optStr(body.phone, 'phone'), reqStr(body.name, 'name'), hashPassword(body.password), nowIso(), nowIso());
    for (const rn of roleNames) {
      const role = q.one(db, `SELECT id FROM roles WHERE tenant_id = ? AND name = ?`, req.tenantId, rn);
      if (role) q.run(db, `INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)`, userId, role.id);
    }
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'users.create', resource: 'user', resourceId: userId, metadata: { email, roles: roleNames } });
    created(res, { id: userId });
  });

  router.patch('/api/v1/users/:id', async (req, res) => {
    mustPerm(req, 'users.manage');
    const target = q.one(db, `SELECT * FROM users WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!target) throw err.notFound('User not found');
    const body = await readBody(req);
    if (body.status) {
      reqOneOf(body.status, 'status', ['ACTIVE', 'SUSPENDED', 'LOCKED']);
      q.run(db, `UPDATE users SET status = ?, updated_at = ? WHERE id = ?`, body.status, nowIso(), target.id);
      if (body.status !== 'ACTIVE') q.run(db, `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, nowIso(), target.id);
    }
    if (Array.isArray(body.roles)) {
      q.run(db, `DELETE FROM user_roles WHERE user_id = ?`, target.id);
      for (const rn of body.roles) {
        const role = q.one(db, `SELECT id FROM roles WHERE tenant_id = ? AND name = ?`, req.tenantId, rn);
        if (role) q.run(db, `INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)`, target.id, role.id);
      }
    }
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'users.update', resource: 'user', resourceId: target.id, metadata: { ...body, roles: body.roles } });
    ok(res, { updated: true });
  });

  router.get('/api/v1/roles', (req, res) => {
    mustPerm(req, 'users.manage');
    const roles = q.all(db, `SELECT * FROM roles WHERE tenant_id = ? ORDER BY name`, req.tenantId)
      .map(r => ({ ...r, permissions: q.all(db, `SELECT permission FROM role_permissions WHERE role_id = ?`, r.id).map(p => p.permission) }));
    ok(res, { roles, templates: Object.keys(ROLE_TEMPLATES) });
  });
}

function resolveAndAudit(db, req, action) {
  if (req.auth) audit(db, { tenantId: req.auth.user.tenant_id, actorId: req.auth.user.id, action, ip: clientIp(req) });
}

function publicUser(db, user) {
  const roles = q.all(db, `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`, user.id).map(r => r.name);
  return { id: user.id, email: user.email, name: user.name, phone: user.phone, status: user.status, roles, tenant_id: user.tenant_id, last_login_at: user.last_login_at };
}
