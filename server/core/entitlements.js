import { err } from './http.js';
import { q } from '../db/connection.js';

/**
 * Entitlement engine (§13 of evolution spec).
 * Every gated feature checks entitlements SERVER-SIDE. The UI never decides.
 * The JATA Qi entitlement service remains authoritative in production;
 * this module is TAWA's binding + local cache of the subscription matrix.
 */

export const ENTITLEMENTS = [
  ['TAWA.POS', 'Point of sale', 'Commerce'],
  ['TAWA.STOREFRONT', 'Storefront', 'Commerce'],
  ['TAWA.QUOTES', 'Quotations', 'Commerce'],
  ['TAWA.INVENTORY', 'Inventory', 'Inventory'],
  ['TAWA.ADVANCED_INVENTORY', 'Advanced inventory & multi-warehouse', 'Inventory'],
  ['TAWA.PROCUREMENT', 'Procurement', 'Inventory'],
  ['TAWA.SUPPLIERS', 'Supplier management', 'Relationships'],
  ['TAWA.CUSTOMERS', 'Customer CRM', 'Relationships'],
  ['TAWA.BROKERS', 'Broker network', 'Relationships'],
  ['TAWA.WORKFORCE', 'Workforce & tasks', 'Relationships'],
  ['TAWA.PAYROLL', 'Payroll', 'Money'],
  ['TAWA.PAYMENTS', 'Payments', 'Money'],
  ['TAWA.AUTOPAY', 'Auto-Pay', 'Money'],
  ['TAWA.CREDIT', 'Customer credit', 'Money'],
  ['TAWA.ACCOUNTING', 'Accounting & ledger', 'Money'],
  ['TAWA.ADVANCED_ACCOUNTING', 'Advanced accounting', 'Money'],
  ['TAWA.EXPENSES', 'Expenses', 'Money'],
  ['TAWA.DELIVERY', 'Delivery management', 'Logistics'],
  ['TAWA.DELIVERY_AI', 'Delivery AI', 'Logistics'],
  ['TAWA.OTP_DELIVERY', 'OTP proof of delivery', 'Logistics'],
  ['TAWA.MARKETING', 'Marketing', 'Marketing'],
  ['TAWA.PROMOTIONS', 'Promotions engine', 'Marketing'],
  ['TAWA.ADVANCED_SMS', 'Advanced SMS messaging', 'Communication'],
  ['TAWA.SMS', 'SMS notifications', 'Communication'],
  ['TAWA.ALERTS', 'Alerts', 'Communication'],
  ['TAWA.ANALYTICS', 'Analytics', 'Intelligence'],
  ['TAWA.AI', 'AI copilot & insights', 'Intelligence'],
  ['TAWA.ADVANCED_AI', 'Advanced AI forecasting', 'Intelligence'],
  ['TAWA.MARKETING_AI', 'AI marketing', 'Intelligence'],
  ['TAWA.AUTOMATION', 'Automation engine', 'Automation'],
  ['TAWA.MULTI_BRANCH', 'Multi-branch', 'Administration'],
  ['TAWA.API', 'API access', 'Administration'],
  ['TAWA.WHITE_LABEL', 'White label', 'White Label'],
  ['TAWA.ADVANCED_AUDIT', 'Advanced audit', 'Administration'],
  ['TAWA.ENTERPRISE_SECURITY', 'Enterprise security (SSO/ABAC/PAM)', 'Administration'],
  ['TAWA.REPORTS', 'Standard reports', 'Intelligence'],
  ['TAWA.ADVANCED_REPORTS', 'Advanced reports', 'Intelligence'],
  ['TAWA.CUSTOMER_COMMUNICATION', 'Customer communication', 'Communication'],
  ['TAWA.PERFORMANCE', 'Worker performance', 'Relationships'],
  ['TAWA.LOYALTY', 'Loyalty engine', 'Marketing'],
];

const YES = 1;
/** Subscription → entitlement matrix (§53). Configuration-driven, stored in DB by seeder. */
export const PLAN_MATRIX = {
  FREE: [
    'TAWA.POS', 'TAWA.INVENTORY', 'TAWA.CUSTOMERS', 'TAWA.SUPPLIERS', 'TAWA.PAYMENTS',
    'TAWA.ALERTS', 'TAWA.REPORTS', 'TAWA.QUOTES', 'TAWA.EXPENSES',
  ],
  STARTER: [
    'TAWA.POS', 'TAWA.INVENTORY', 'TAWA.CUSTOMERS', 'TAWA.SUPPLIERS', 'TAWA.PAYMENTS',
    'TAWA.ALERTS', 'TAWA.REPORTS', 'TAWA.QUOTES', 'TAWA.EXPENSES', 'TAWA.PROCUREMENT',
    'TAWA.DELIVERY', 'TAWA.SMS', 'TAWA.ANALYTICS', 'TAWA.AI', 'TAWA.WHITE_LABEL',
    'TAWA.PROMOTIONS', 'TAWA.CUSTOMER_COMMUNICATION', 'TAWA.ACCOUNTING',
  ],
  PROFESSIONAL: [
    'TAWA.POS', 'TAWA.INVENTORY', 'TAWA.ADVANCED_INVENTORY', 'TAWA.CUSTOMERS', 'TAWA.SUPPLIERS',
    'TAWA.PAYMENTS', 'TAWA.ALERTS', 'TAWA.REPORTS', 'TAWA.ADVANCED_REPORTS', 'TAWA.QUOTES', 'TAWA.EXPENSES',
    'TAWA.PROCUREMENT', 'TAWA.DELIVERY', 'TAWA.SMS', 'TAWA.ADVANCED_SMS', 'TAWA.ANALYTICS', 'TAWA.AI', 'TAWA.ADVANCED_AI',
    'TAWA.WHITE_LABEL', 'TAWA.PROMOTIONS', 'TAWA.MARKETING', 'TAWA.MARKETING_AI', 'TAWA.CUSTOMER_COMMUNICATION',
    'TAWA.BROKERS', 'TAWA.WORKFORCE', 'TAWA.PERFORMANCE', 'TAWA.PAYROLL', 'TAWA.CREDIT',
    'TAWA.AUTOMATION', 'TAWA.LOYALTY', 'TAWA.MULTI_BRANCH', 'TAWA.API', 'TAWA.ACCOUNTING',
    'TAWA.OTP_DELIVERY', 'TAWA.STOREFRONT',
  ],
  BUSINESS: [
    'TAWA.POS', 'TAWA.INVENTORY', 'TAWA.ADVANCED_INVENTORY', 'TAWA.CUSTOMERS', 'TAWA.SUPPLIERS',
    'TAWA.PAYMENTS', 'TAWA.AUTOPAY', 'TAWA.ALERTS', 'TAWA.REPORTS', 'TAWA.ADVANCED_REPORTS', 'TAWA.QUOTES', 'TAWA.EXPENSES',
    'TAWA.PROCUREMENT', 'TAWA.DELIVERY', 'TAWA.DELIVERY_AI', 'TAWA.SMS', 'TAWA.ADVANCED_SMS', 'TAWA.ANALYTICS',
    'TAWA.AI', 'TAWA.ADVANCED_AI', 'TAWA.WHITE_LABEL', 'TAWA.PROMOTIONS', 'TAWA.MARKETING', 'TAWA.MARKETING_AI',
    'TAWA.CUSTOMER_COMMUNICATION', 'TAWA.BROKERS', 'TAWA.WORKFORCE', 'TAWA.PERFORMANCE', 'TAWA.PAYROLL', 'TAWA.CREDIT',
    'TAWA.AUTOMATION', 'TAWA.LOYALTY', 'TAWA.MULTI_BRANCH', 'TAWA.API', 'TAWA.ACCOUNTING', 'TAWA.ADVANCED_ACCOUNTING',
    'TAWA.OTP_DELIVERY', 'TAWA.ADVANCED_AUDIT', 'TAWA.STOREFRONT',
  ],
  ENTERPRISE: ENTITLEMENTS.map(([code]) => code),
  GOV_EDU: ENTITLEMENTS.map(([code]) => code),
};

export const PLANS = [
  { id: 'FREE', name: 'Free', description: 'Discover TAWA with essential tools', seats: 2, branches: 1, products: 50, price: 0, sort: 0 },
  { id: 'STARTER', name: 'Starter', description: 'Small hardware businesses', seats: 5, branches: 1, products: 500, price: 2500, sort: 1 },
  { id: 'PROFESSIONAL', name: 'Professional', description: 'Growing hardware businesses', seats: 15, branches: 3, products: 5000, price: 7500, sort: 2 },
  { id: 'BUSINESS', name: 'Business', description: 'Established multi-branch merchants', seats: 50, branches: 10, products: 50000, price: 20000, sort: 3 },
  { id: 'ENTERPRISE', name: 'Enterprise', description: 'Chains & organizations — SSO, ABAC/ReBAC, PAM', seats: 500, branches: 100, products: 500000, price: 0, sort: 4 },
  { id: 'GOV_EDU', name: 'Government / Education', description: 'Governed deployments with policy modules', seats: 1000, branches: 500, products: 1000000, price: 0, sort: 5 },
];

export function tenantEntitlements(db, tenantId) {
  const sub = q.one(db, `SELECT * FROM subscriptions WHERE tenant_id = ?`, tenantId);
  if (!sub) return { plan: null, set: new Set() };
  const rows = q.all(db, `SELECT entitlement FROM plan_entitlements WHERE plan_id = ?`, sub.plan_id);
  return { plan: sub.plan_id, status: sub.status, set: new Set(rows.map(r => r.entitlement)) };
}

/** Hard server-side gate. Expired/suspended subscriptions lose gated features (§58 test 8). */
export function requireEntitlement(db, req, code) {
  const tenant = req.tenant;
  if (!tenant) throw err.forbidden('No tenant context');
  if (['SUSPENDED', 'EXPIRED', 'CANCELLED'].includes(tenant.status)) {
    throw err.tenantRestricted('Subscription inactive — gated features unavailable.');
  }
  const { set } = tenantEntitlements(db, tenant.id);
  if (!set.has(code)) {
    throw err.planUpgrade(`Feature "${code}" is not included in the current plan. Upgrade to unlock it.`);
  }
  return true;
}

/** Convenience middleware factory for route gating. */
export function gate(db, code) {
  return (req) => requireEntitlement(db, req, code);
}

/** Plan capacity limits (§18): enforced server-side at create time. */
export function enforcePlanLimit(db, tenantId, resource) {
  const sub = q.one(db, `SELECT plan_id FROM subscriptions WHERE tenant_id = ?`, tenantId);
  const plan = PLANS.find(p => p.id === (sub?.plan_id || 'FREE')) || PLANS[0];
  const limits = { users: plan.seats, branches: plan.branches, products: plan.products };
  const max = limits[resource];
  if (!max || max < 0) return; // unlimited
  const table = { users: 'users', branches: 'branches', products: 'products' }[resource];
  const cur = q.one(db, `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, tenantId).n;
  if (cur >= max) {
    throw err.forbidden(`Plan limit reached: ${resource} (${cur}/${max} on ${plan.id}). Upgrade to add more.`, { code: 'PLAN_LIMIT_REACHED' });
  }
}

/** Usage metering seam (§14). Server-side counters only. */
export function meter(db, tenantId, meterName, n = 1) {
  const period = new Date().toISOString().slice(0, 7);
  q.run(db,
    `INSERT INTO usage_counters (tenant_id, meter, period, count) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id, meter, period) DO UPDATE SET count = count + excluded.count`,
    tenantId, meterName, period, n);
  void YES;
}

export function usageFor(db, tenantId, period = new Date().toISOString().slice(0, 7)) {
  return q.all(db, `SELECT meter, count FROM usage_counters WHERE tenant_id = ? AND period = ?`, tenantId, period);
}
