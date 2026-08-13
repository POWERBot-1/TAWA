import { err } from './http.js';
import { q } from '../db/connection.js';
import { mustAuth } from './auth.js';
import { requireEntitlement } from './entitlements.js';

/** Path → entitlement mapping, enforced server-side for every tenant API call. */
const ENTITLEMENT_GATES = [
  ['/api/v1/pos', 'TAWA.POS'],
  ['/api/v1/quotes', 'TAWA.QUOTES'],
  ['/api/v1/inventory/transfer', 'TAWA.ADVANCED_INVENTORY'],
  ['/api/v1/procurement', 'TAWA.PROCUREMENT'],
  ['/api/v1/suppliers', 'TAWA.SUPPLIERS'],
  ['/api/v1/brokers', 'TAWA.BROKERS'],
  ['/api/v1/commissions', 'TAWA.BROKERS'],
  ['/api/v1/leads', 'TAWA.BROKERS'],
  ['/api/v1/workers', 'TAWA.WORKFORCE'],
  ['/api/v1/payroll', 'TAWA.PAYROLL'],
  ['/api/v1/credit', 'TAWA.CREDIT'],
  ['/api/v1/accounting', 'TAWA.ACCOUNTING'],
  ['/api/v1/expenses', 'TAWA.EXPENSES'],
  ['/api/v1/deliveries', 'TAWA.DELIVERY'],
  ['/api/v1/marketing/promotions', 'TAWA.PROMOTIONS'],
  ['/api/v1/marketing', 'TAWA.MARKETING'],
  ['/api/v1/automation', 'TAWA.AUTOMATION'],
  ['/api/v1/autopay', 'TAWA.AUTOPAY'],
  ['/api/v1/ai', 'TAWA.AI'],
  ['/api/v1/analytics', 'TAWA.ANALYTICS'],
  ['/api/v1/settings/branding', 'TAWA.WHITE_LABEL'],
];

/**
 * Tenant context (§3 multi-tenancy).
 * Identity is derived from the authenticated session — NEVER from a
 * client-supplied tenant_id. Fails closed when ambiguous.
 */
export function resolveTenant(db, req) {
  const auth = req.auth;
  if (!auth) return null;
  if (!auth.session.tenant_id) return null; // platform operator: no tenant context
  const tenant = q.one(db, `SELECT * FROM tenants WHERE id = ?`, auth.session.tenant_id);
  if (!tenant) return null;
  return tenant;
}

export function tenantStatusGate(tenant) {
  // §55 grace & suspension: deterministic states, data preserved.
  if (tenant.status === 'SUSPENDED') throw err.tenantRestricted('This workspace is suspended. Contact your billing administrator.');
  if (tenant.status === 'EXPIRED' || tenant.status === 'CANCELLED') throw err.tenantRestricted('This subscription has expired.');
  // TRIAL / ACTIVE / GRACE / RESTRICTED proceed; write-blocking for RESTRICTED handled per-request.
}

/** Attach req.tenant for /api/v1/* calls; platform routes pass through. */
export function tenancyMiddleware(db) {
  return (req) => {
    if (!req.path.startsWith('/api/v1/')) return;
    if (req.path.startsWith('/api/v1/admin/')) return;   // control plane handles its own gate
    // Deliberately public, non-sensitive surfaces (explicit allowlist — everything else fails closed):
    // auth (login/session), brand (login-page theming), webhooks (provider callbacks, HMAC-verified),
    // public (storefront/brand directory), meta (product/module descriptor — no tenant data).
    if (req.path.startsWith('/api/v1/auth/') || req.path.startsWith('/api/v1/brand') || req.path.startsWith('/api/v1/webhooks/') || req.path.startsWith('/api/v1/public/') || req.path === '/api/v1/meta') return;
    const auth = mustAuth(req);
    if (!auth.session.tenant_id) throw err.forbidden('Platform operators cannot access tenant APIs. Use the control plane.');
    const tenant = resolveTenant(db, req);
    if (!tenant) throw err.forbidden('No tenant context');
    tenantStatusGate(tenant);
    req.tenant = tenant;
    req.tenantId = tenant.id;
    // RESTRICTED tenants may read but not write (§55).
    if (tenant.status === 'RESTRICTED' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        && !req.path.startsWith('/api/v1/billing')) {
      throw err.tenantRestricted('Workspace is in restricted mode: read-only until billing is resolved.');
    }
    // Entitlement gate (spec §13): the UI never decides; the server does.
    const gate = ENTITLEMENT_GATES.find(([prefix]) => req.path.startsWith(prefix));
    if (gate) requireEntitlement(db, req, gate[1]);
  };
}

/** Resolve tenant by host for storefront/branding (public, non-trusting). */
export function tenantByHost(db, host) {
  if (!host) return null;
  const clean = String(host).toLowerCase().split(':')[0];
  const direct = q.one(db, `SELECT t.* FROM tenant_domains d JOIN tenants t ON t.id = d.tenant_id WHERE d.host = ?`, clean);
  if (direct) return direct;
  const sub = clean.split('.')[0];
  if (sub && sub !== clean) {
    const byCode = q.one(db, `SELECT * FROM tenants WHERE code = ?`, sub);
    if (byCode) return byCode;
  }
  return null;
}
