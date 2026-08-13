/**
 * RBAC (§4, §22). Canonical permission catalog + system role templates.
 * Architecture prepared for ABAC/ReBAC: permission checks funnel through
 * hasPerm()/mustPerm() so attribute/relationship predicates can be layered on.
 */

export const PERMISSIONS = [
  // catalog & products
  'catalog.view', 'catalog.manage',
  // inventory
  'inventory.view', 'inventory.receive', 'inventory.adjust', 'inventory.transfer', 'inventory.count',
  // sales & pos
  'sales.view', 'sales.create', 'sales.discount', 'pos.use', 'pos.refund',
  // quotes
  'quotes.view', 'quotes.create', 'quotes.approve', 'quotes.send',
  // orders
  'orders.view', 'orders.create', 'orders.cancel', 'orders.fulfil',
  // customers & credit
  'customers.view', 'customers.manage', 'customers.export',
  'credit.view', 'credit.grant', 'credit.override', 'credit.approve',
  // suppliers & procurement
  'suppliers.view', 'suppliers.manage',
  'procurement.view', 'procurement.create', 'procurement.approve', 'procurement.receive',
  // payments
  'payments.view', 'payments.create', 'payments.verify', 'payments.refund', 'payments.payout',
  // expenses
  'expenses.view', 'expenses.submit', 'expenses.approve', 'expenses.pay',
  // workers & payroll
  'workers.view', 'workers.manage', 'tasks.view', 'tasks.assign', 'tasks.verify',
  'payroll.view', 'payroll.calculate', 'payroll.review', 'payroll.approve', 'payroll.execute',
  // brokers
  'brokers.view', 'brokers.manage', 'brokers.commission.approve', 'brokers.commission.pay',
  // deliveries
  'deliveries.view', 'deliveries.manage', 'deliveries.drive',
  // money & accounting
  'accounting.view', 'accounting.post', 'reports.view', 'reports.export',
  // analytics & ai
  'analytics.view', 'ai.view', 'ai.use',
  // marketing
  'marketing.view', 'marketing.manage', 'marketing.approve',
  // alerts & automation
  'alerts.view', 'alerts.manage', 'automation.manage',
  // admin
  'users.manage', 'roles.manage', 'branches.manage', 'settings.manage', 'branding.manage',
  'audit.view', 'integrations.manage', 'billing.manage',
];

const ALL = [...PERMISSIONS];

function minus(perms, remove) { return perms.filter(p => !remove.includes(p)); }

/** System role templates (§4). Tenant roles instantiate from these. */
export const ROLE_TEMPLATES = {
  OWNER: { description: 'Tenant owner — full tenant authority', perms: ALL },
  ADMIN: { description: 'Tenant administrator', perms: minus(ALL, ['billing.manage']) },
  BRANCH_MANAGER: {
    description: 'Branch manager',
    perms: minus(ALL, ['billing.manage', 'integrations.manage', 'roles.manage', 'branding.manage', 'users.manage', 'automation.manage', 'audit.view', 'accounting.post', 'payroll.execute']),
  },
  STORE_MANAGER: {
    description: 'Store manager',
    perms: minus(ALL, ['billing.manage', 'integrations.manage', 'roles.manage', 'branding.manage', 'users.manage', 'automation.manage', 'audit.view', 'accounting.post', 'payroll.execute', 'payroll.approve', 'payments.payout', 'credit.override', 'settings.manage', 'branches.manage']),
  },
  SALESPERSON: {
    description: 'Salesperson',
    perms: ['catalog.view', 'inventory.view', 'sales.view', 'sales.create', 'quotes.view', 'quotes.create', 'quotes.send', 'orders.view', 'orders.create', 'customers.view', 'customers.manage', 'deliveries.view', 'ai.view', 'ai.use', 'alerts.view', 'reports.view'],
  },
  CASHIER: {
    description: 'Cashier — may sell, may NOT approve refunds or payroll',
    perms: ['catalog.view', 'inventory.view', 'pos.use', 'sales.view', 'sales.create', 'orders.view', 'customers.view', 'payments.view', 'payments.create', 'payments.verify', 'alerts.view'],
  },
  STOREKEEPER: {
    description: 'Storekeeper — may adjust stock, may NOT approve payments',
    perms: ['catalog.view', 'inventory.view', 'inventory.receive', 'inventory.adjust', 'inventory.transfer', 'inventory.count', 'orders.view', 'orders.fulfil', 'deliveries.view', 'tasks.view', 'procurement.view', 'procurement.create', 'procurement.receive', 'alerts.view'],
  },
  PROCUREMENT_OFFICER: {
    description: 'Procurement officer',
    perms: ['catalog.view', 'inventory.view', 'suppliers.view', 'suppliers.manage', 'procurement.view', 'procurement.create', 'procurement.receive', 'reports.view', 'alerts.view'],
  },
  ACCOUNTANT: {
    description: 'Accountant',
    perms: ['accounting.view', 'accounting.post', 'reports.view', 'reports.export', 'payments.view', 'expenses.view', 'expenses.submit', 'credit.view', 'payroll.view', 'alerts.view'],
  },
  FINANCE_MANAGER: {
    description: 'Finance manager — approves payments; cannot change platform security policy',
    perms: ['accounting.view', 'reports.view', 'reports.export', 'payments.view', 'payments.create', 'payments.verify', 'payments.refund', 'payments.payout', 'expenses.view', 'expenses.submit', 'expenses.approve', 'expenses.pay', 'credit.view', 'credit.grant', 'credit.approve', 'credit.override', 'payroll.view', 'payroll.review', 'payroll.approve', 'payroll.execute', 'suppliers.view', 'procurement.view', 'procurement.create', 'brokers.view', 'brokers.commission.approve', 'brokers.commission.pay', 'alerts.view'],
  },
  HR_MANAGER: {
    description: 'HR manager',
    perms: ['workers.view', 'workers.manage', 'tasks.view', 'tasks.assign', 'tasks.verify', 'payroll.view', 'payroll.calculate', 'payroll.review', 'reports.view', 'alerts.view'],
  },
  DRIVER: {
    description: 'Driver',
    perms: ['deliveries.view', 'deliveries.drive', 'tasks.view', 'alerts.view'],
  },
  DELIVERY_WORKER: {
    description: 'Delivery worker',
    perms: ['deliveries.view', 'deliveries.drive', 'tasks.view', 'alerts.view'],
  },
  GENERAL_WORKER: {
    description: 'General worker',
    perms: ['tasks.view', 'alerts.view'],
  },
  BROKER: {
    description: 'Broker / agent',
    perms: ['customers.view', 'quotes.view', 'orders.view', 'brokers.view', 'alerts.view'],
  },
  SUPPLIER: {
    description: 'Supplier contact',
    perms: ['procurement.view', 'alerts.view'],
  },
  CUSTOMER: {
    description: 'Customer portal user',
    perms: ['orders.view', 'quotes.view', 'payments.view', 'alerts.view'],
  },
  AUDITOR: {
    description: 'Read-only auditor',
    perms: ['audit.view', 'accounting.view', 'reports.view', 'reports.export', 'payments.view', 'orders.view', 'sales.view', 'inventory.view', 'payroll.view', 'customers.view', 'suppliers.view', 'brokers.view', 'workers.view', 'deliveries.view', 'alerts.view', 'analytics.view'],
  },
  PLATFORM_SUPER_ADMIN: {
    description: 'JATA Qi platform operator (control plane)',
    perms: ALL,
  },
};

export function roleTemplatesFor(seed) {
  return Object.entries(ROLE_TEMPLATES).filter(([name]) => name !== 'PLATFORM_SUPER_ADMIN' || seed);
}
