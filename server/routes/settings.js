import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqOneOf } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { PLANS, PLAN_MATRIX, tenantEntitlements, ENTITLEMENTS, usageFor } from '../core/entitlements.js';
import { providerHealth } from '../adapters/payments.js';
import { MESSAGING_PROVIDERS } from '../adapters/messaging.js';

/** WCAG relative-luminance contrast check — tenants can't pick inaccessible brands (spec §40). */
function contrast(hex1, hex2) {
  const lum = (hex) => {
    const c = String(hex).replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
    const [r, g, b] = [0, 2, 4].map(i => {
      const s = parseInt(c.slice(i, i + 2), 16) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l1 = lum(hex1), l2 = lum(hex2);
  if (l1 === null || l2 === null) return null;
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function registerSettings(router, db) {
  /* ---------------- Branding / white label (§2, §52) ---------------- */
  router.get('/api/v1/settings/branding', (req, res) => {
    mustPerm(req, 'settings.manage');
    ok(res, q.one(db, `SELECT * FROM tenant_branding WHERE tenant_id = ?`, req.tenantId));
  });
  router.put('/api/v1/settings/branding', async (req, res) => {
    mustPerm(req, 'branding.manage');
    const body = await readBody(req);
    const current = q.one(db, `SELECT * FROM tenant_branding WHERE tenant_id = ?`, req.tenantId) || {};
    const next = { ...current, ...filterBranding(body) };
    // Contrast validation (§40): primary/accent vs surface & text must stay readable.
    const warnings = [];
    for (const [a, b, label] of [
      [next.color_text, next.color_surface, 'text vs surface'],
      [next.color_primary, next.color_background, 'primary vs background'],
      [next.color_primary, next.color_surface, 'primary vs surface'],
    ]) {
      const ratio = contrast(a, b);
      if (ratio !== null && ratio < 3.0) warnings.push(`Low contrast (${ratio.toFixed(2)}) for ${label} — choose a more distinct color`);
    }
    const fields = ['business_name', 'tagline', 'logo_monogram', 'theme_mode', 'color_primary', 'color_secondary', 'color_accent',
      'color_background', 'color_surface', 'color_text', 'color_success', 'color_warning', 'color_error', 'font_family',
      'white_label', 'email_from', 'sms_sender', 'phone', 'email', 'address', 'website', 'terms_url', 'privacy_url', 'doc_footer',
      'invoice_prefix', 'receipt_prefix', 'quote_prefix', 'order_prefix', 'po_prefix'];
    const sets = []; const params = [];
    for (const f of fields) if (body[f] !== undefined) {
      sets.push(`${f} = ?`); params.push(f === 'white_label' ? (body[f] ? 1 : 0) : String(body[f] ?? '').slice(0, f === 'doc_footer' ? 500 : 200));
    }
    if (body.socials !== undefined) { sets.push('socials = ?'); params.push(JSON.stringify(body.socials || {})); }
    // Block saving an inaccessible theme BEFORE persisting (hard fail on text/surface contrast)
    const critical = contrast(next.color_text, next.color_surface);
    if (critical !== null && critical < 2.2) throw err.unprocessable('Theme rejected: text/surface contrast is below the accessibility floor', { warnings });
    if (sets.length) {
      sets.push('updated_at = ?'); params.push(nowIso(), req.tenantId);
      q.run(db, `UPDATE tenant_branding SET ${sets.join(', ')} WHERE tenant_id = ?`, ...params);
    }
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'branding.update', resource: 'tenant_branding', resourceId: req.tenantId, metadata: { changed: sets.length - 1, warnings } });
    ok(res, { branding: q.one(db, `SELECT * FROM tenant_branding WHERE tenant_id = ?`, req.tenantId), warnings });
  });

  /* ---------------- Feature flags (§47) ---------------- */
  router.get('/api/v1/settings/flags', (req, res) => {
    mustPerm(req, 'settings.manage');
    ok(res, q.all(db, `SELECT * FROM feature_flags WHERE tenant_id = ?`, req.tenantId));
  });
  router.put('/api/v1/settings/flags', async (req, res) => {
    mustPerm(req, 'settings.manage');
    const body = await readBody(req);
    const allowed = ['ENABLE_POS', 'ENABLE_AI', 'ENABLE_PAYROLL', 'ENABLE_BROKERS', 'ENABLE_AUTO_PAY', 'ENABLE_CREDIT', 'ENABLE_DELIVERY', 'ENABLE_LOYALTY', 'ENABLE_ACCOUNTING', 'ENABLE_MULTI_BRANCH', 'ENABLE_WHATSAPP', 'ENABLE_MOBILE_APP'];
    for (const [flag, enabled] of Object.entries(body.flags || {})) {
      if (!allowed.includes(flag)) throw err.unprocessable(`Unknown flag ${flag}`);
      q.run(db, `INSERT INTO feature_flags (tenant_id, flag, enabled) VALUES (?,?,?)
                 ON CONFLICT(tenant_id, flag) DO UPDATE SET enabled = excluded.enabled`, req.tenantId, flag, enabled ? 1 : 0);
    }
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'flags.update', metadata: body });
    ok(res, q.all(db, `SELECT * FROM feature_flags WHERE tenant_id = ?`, req.tenantId));
  });

  /* ---------------- Subscription & entitlement matrix (§53-55) ---------------- */
  router.get('/api/v1/billing/subscription', (req, res) => {
    mustPerm(req, 'settings.manage');
    const sub = q.one(db, `SELECT * FROM subscriptions WHERE tenant_id = ?`, req.tenantId);
    const license = q.one(db, `SELECT id, state, starts_at, expires_at, product_version FROM licenses WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`, req.tenantId);
    const ent = tenantEntitlements(db, req.tenantId);
    ok(res, {
      subscription: sub, license,
      plan: sub?.plan_id || null,
      entitlements: [...ent.set],
      usage: usageFor(db, req.tenantId),
      plans: PLANS.map(p => ({ ...p, entitlement_count: PLAN_MATRIX[p.id].length })),
    });
  });
  router.get('/api/v1/billing/matrix', (req, res) => {
    mustPerm(req, 'settings.manage');
    ok(res, {
      plans: PLANS.map(p => p.id),
      entitlements: ENTITLEMENTS.map(([code, label, module]) => ({
        code, label, module,
        grants: Object.fromEntries(PLANS.map(p => [p.id, PLAN_MATRIX[p.id].includes(code)])),
      })),
    });
  });

  /** Plan change: access elevation with safe downgrade (§54). Entitlements recompute server-side. */
  router.post('/api/v1/billing/change-plan', async (req, res) => {
    mustPerm(req, 'billing.manage');
    const body = await readBody(req);
    const planId = reqOneOf(reqStr(body.plan_id, 'plan_id'), 'plan_id', PLANS.map(p => p.id));
    const sub = q.one(db, `SELECT * FROM subscriptions WHERE tenant_id = ?`, req.tenantId);
    if (!sub) throw err.conflict('Tenant has no subscription');
    if (sub.plan_id === planId) return ok(res, { subscription: sub, unchanged: true });
    const oldPlan = PLANS.find(p => p.id === sub.plan_id);
    const newPlan = PLANS.find(p => p.id === planId);
    const downgrade = newPlan.sort < oldPlan.sort;
    // Downgrade safety (§54): never delete data; warn about over-limit resources.
    const warnings = [];
    if (downgrade) {
      const users = q.one(db, `SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND status = 'ACTIVE'`, req.tenantId).n;
      const branches = q.one(db, `SELECT COUNT(*) AS n FROM branches WHERE tenant_id = ? AND is_active = 1`, req.tenantId).n;
      const products = q.one(db, `SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND is_active = 1`, req.tenantId).n;
      if (users > newPlan.seats) warnings.push(`${users} active users exceed ${newPlan.name} seat limit (${newPlan.seats}) — existing users keep access; new invites will be blocked`);
      if (branches > newPlan.branch_limit) warnings.push(`${branches} branches exceed ${newPlan.name} limit (${newPlan.branch_limit}) — data preserved`);
      if (products > newPlan.product_limit) warnings.push(`${products} products exceed ${newPlan.name} limit (${newPlan.product_limit}) — data preserved`);
    }
    tx(db, () => {
      q.run(db, `UPDATE subscriptions SET plan_id = ?, updated_at = ? WHERE tenant_id = ?`, planId, nowIso(), req.tenantId);
      q.run(db, `UPDATE licenses SET updated_at = ? WHERE tenant_id = ? AND state IN ('ACTIVE','TRIAL')`, nowIso(), req.tenantId);
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'billing.change_plan', resource: 'subscription', resourceId: sub.id, metadata: { from: sub.plan_id, to: planId, downgrade, warnings } });
    const refreshed = tenantEntitlements(db, req.tenantId);
    ok(res, { subscription: q.one(db, `SELECT * FROM subscriptions WHERE tenant_id = ?`, req.tenantId), entitlements: [...refreshed.set], warnings, downgrade });
  });

  /* ---------------- Integrations status (§62 adapters) ---------------- */
  router.get('/api/v1/integrations', (req, res) => {
    mustPerm(req, 'integrations.manage');
    ok(res, {
      payments: providerHealth(),
      messaging: Object.entries(MESSAGING_PROVIDERS).map(([code, p]) => ({ code, kind: p.kind, name: p.name, ...p.healthCheck() })),
      note: 'Providers marked "sandbox" are simulated adapters. Production requires configured credentials + verified webhooks.',
    });
  });

  /* ---------------- Audit (§39) — append-only ---------------- */
  router.get('/api/v1/audit', (req, res) => {
    mustPerm(req, 'audit.view');
    const rows = q.all(db, `SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 300`, req.tenantId);
    ok(res, rows);
  });

  /* ---------------- Tenant profile ---------------- */
  router.get('/api/v1/settings/tenant', (req, res) => {
    const t = q.one(db, `SELECT id, code, name, legal_name, industry, status, currency, timezone, country, tax_regime FROM tenants WHERE id = ?`, req.tenantId);
    const domains = q.all(db, `SELECT host, kind, is_primary, verified FROM tenant_domains WHERE tenant_id = ?`, req.tenantId);
    ok(res, { ...t, domains });
  });
  router.patch('/api/v1/settings/tenant', async (req, res) => {
    mustPerm(req, 'settings.manage');
    const body = await readBody(req);
    const sets = []; const params = [];
    for (const f of ['name', 'legal_name', 'currency', 'timezone', 'country', 'tax_regime']) {
      if (body[f] !== undefined) { sets.push(`${f} = ?`); params.push(String(body[f]).slice(0, 120)); }
    }
    if (sets.length) { sets.push('updated_at = ?'); params.push(nowIso(), req.tenantId); q.run(db, `UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, ...params); }
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'tenant.update', metadata: body });
    ok(res, q.one(db, `SELECT * FROM tenants WHERE id = ?`, req.tenantId));
  });

  router.post('/api/v1/settings/domains', async (req, res) => {
    mustPerm(req, 'settings.manage');
    const body = await readBody(req);
    const host = reqStr(body.host, 'host').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (q.one(db, `SELECT id FROM tenant_domains WHERE host = ?`, host)) throw err.conflict('Domain already claimed');
    q.run(db, `INSERT INTO tenant_domains (id, tenant_id, host, kind, verified, created_at) VALUES (?,?,?,?,0,?)`,
      id('dom'), req.tenantId, host, reqOneOf(body.kind || 'CUSTOM', 'kind', ['SUBDOMAIN', 'CUSTOM', 'STOREFRONT', 'API']), nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'domain.add', metadata: { host } });
    created(res, { host, verification: 'pending — configure DNS then verify' });
  });
  void created;
}

function filterBranding(body) {
  const fields = ['business_name', 'color_primary', 'color_surface', 'color_text', 'color_background'];
  const out = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}
