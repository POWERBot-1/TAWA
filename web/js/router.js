/**
 * Hash router with lazy page modules, permission & entitlement gating.
 */
import { store } from './store.js';
import { h, lockScreen, emptyState, btn, pageHead, iconEl } from './ui.js';

/** Route registry — also drives the sidebar & command palette. */
export const ROUTES = [
  { id: 'dashboard', path: '/dashboard', title: 'Dashboard', icon: 'dashboard', section: 'Overview', perm: 'analytics.view', ent: null, module: 'dashboard', sub: 'Business pulse' },
  { id: 'pos', path: '/pos', title: 'Point of Sale', icon: 'pos', section: 'Sell', perm: 'pos.use', ent: 'TAWA.POS', module: 'pos', kbd: 'P', sub: 'Fast checkout' },
  { id: 'orders', path: '/orders', title: 'Orders', icon: 'orders', section: 'Sell', perm: 'orders.view', ent: null, module: 'orders', kbd: 'O' },
  { id: 'quotes', path: '/quotes', title: 'Quotations', icon: 'quotes', section: 'Sell', perm: 'quotes.view', ent: 'TAWA.QUOTES', module: 'quotes', kbd: 'Q' },
  { id: 'products', path: '/products', title: 'Products', icon: 'products', section: 'Catalogue', perm: 'catalog.view', ent: null, module: 'products' },
  { id: 'inventory', path: '/inventory', title: 'Inventory', icon: 'inventory', section: 'Catalogue', perm: 'inventory.view', ent: 'TAWA.INVENTORY', module: 'inventory', kbd: 'I' },
  { id: 'procurement', path: '/procurement', title: 'Procurement', icon: 'procurement', section: 'Catalogue', perm: 'procurement.view', ent: 'TAWA.PROCUREMENT', module: 'procurement' },
  { id: 'customers', path: '/customers', title: 'Customers', icon: 'customers', section: 'People', perm: 'customers.view', ent: 'TAWA.CUSTOMERS', module: 'customers', kbd: 'C' },
  { id: 'credit', path: '/credit', title: 'Credit', icon: 'credit', section: 'People', perm: 'credit.view', ent: 'TAWA.CREDIT', module: 'credit' },
  { id: 'suppliers', path: '/suppliers', title: 'Suppliers', icon: 'suppliers', section: 'People', perm: 'suppliers.view', ent: 'TAWA.SUPPLIERS', module: 'suppliers' },
  { id: 'brokers', path: '/brokers', title: 'Brokers & Leads', icon: 'brokers', section: 'People', perm: 'brokers.view', ent: 'TAWA.BROKERS', module: 'brokers' },
  { id: 'workers', path: '/workers', title: 'Workforce', icon: 'workers', section: 'People', perm: 'workers.view', ent: 'TAWA.WORKFORCE', module: 'workforce' },
  { id: 'payments', path: '/payments', title: 'Payments', icon: 'payments', section: 'Money', perm: 'payments.view', ent: 'TAWA.PAYMENTS', module: 'payments' },
  { id: 'expenses', path: '/expenses', title: 'Expenses', icon: 'expenses', section: 'Money', perm: 'expenses.view', ent: 'TAWA.EXPENSES', module: 'expenses' },
  { id: 'payroll', path: '/payroll', title: 'Payroll', icon: 'payroll', section: 'Money', perm: 'payroll.view', ent: 'TAWA.PAYROLL', module: 'payroll' },
  { id: 'accounting', path: '/accounting', title: 'Accounting', icon: 'ledger', section: 'Money', perm: 'accounting.view', ent: 'TAWA.ACCOUNTING', module: 'accounting' },
  { id: 'deliveries', path: '/deliveries', title: 'Deliveries', icon: 'truck', section: 'Logistics', perm: 'deliveries.view', ent: 'TAWA.DELIVERY', module: 'deliveries', kbd: 'D' },
  { id: 'marketing', path: '/marketing', title: 'Marketing', icon: 'marketing', section: 'Growth', perm: 'marketing.view', ent: 'TAWA.MARKETING', module: 'marketing' },
  { id: 'alerts', path: '/alerts', title: 'Alerts & Inbox', icon: 'bell', section: 'Growth', perm: 'alerts.view', ent: 'TAWA.ALERTS', module: 'alerts' },
  { id: 'automation', path: '/automation', title: 'Automation', icon: 'automation', section: 'Growth', perm: 'alerts.manage', ent: 'TAWA.AUTOMATION', module: 'automation' },
  { id: 'analytics', path: '/analytics', title: 'Analytics', icon: 'analytics', section: 'Intelligence', perm: 'analytics.view', ent: 'TAWA.ANALYTICS', module: 'analytics' },
  { id: 'ai', path: '/ai', title: 'AI Copilot', icon: 'ai', section: 'Intelligence', perm: 'ai.view', ent: 'TAWA.AI', module: 'ai', kbd: 'A' },
  { id: 'reports', path: '/reports', title: 'Reports', icon: 'reports', section: 'Intelligence', perm: 'reports.view', ent: 'TAWA.REPORTS', module: 'reports', kbd: 'R' },
  { id: 'branches', path: '/branches', title: 'Branches', icon: 'branches', section: 'System', perm: 'branches.manage', ent: 'TAWA.MULTI_BRANCH', module: 'branches' },
  { id: 'settings', path: '/settings', title: 'Settings', icon: 'settings', section: 'System', perm: null, ent: null, module: 'settings', match: /^\/settings/ },
  { id: 'platform', path: '/platform', title: 'Platform Control', icon: 'admin', section: 'System', perm: null, ent: null, module: 'admin', adminOnly: true },
];

const cache = new Map();
let outlet = null;
let currentCleanup = null;

export function initRouter(outletEl, onNavigate) {
  outlet = outletEl;
  window.addEventListener('hashchange', () => navigate(onNavigate));
  return navigate(onNavigate);
}

export function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  const [path] = hash.split('?');
  const route = ROUTES.find(r => r.match ? r.match.test(path) : r.path === path)
    || ROUTES.find(r => path.startsWith(r.path + '/'))
    || null;
  return { route, hash, path };
}

async function navigate(onNavigate) {
  const { route, path } = currentRoute();
  if (!outlet) return;
  if (currentCleanup) { try { currentCleanup(); } catch { /* noop */ } currentCleanup = null; }

  if (!route) {
    outlet.replaceChildren(emptyFor('Page not found', 'This screen does not exist. Use the sidebar or ⌘K to navigate.', 'warning'));
    onNavigate?.(null);
    return;
  }
  // Role gate (UX mirror of server RBAC)
  if (route.adminOnly && !store.isPlatformAdmin && !store.me) { /* fallthrough to login from main */ }
  if (route.adminOnly && store.me && !store.isPlatformAdmin) {
    outlet.replaceChildren(emptyFor('Platform administrators only', 'This control plane is restricted to the JATA Qi platform team.', 'shield'));
    onNavigate?.(route);
    return;
  }
  onNavigate?.(route);

  // Entitlement gate (UX mirror — server enforces 402 regardless)
  if (route.ent && store.me && !store.isPlatformAdmin && !store.has(route.ent)) {
    outlet.replaceChildren(h('div', { class: 'page' }, pageHead(route.title, 'Module locked'), lockScreen(route.title, planFor(route.ent))));
    return;
  }
  if (route.perm && store.me && !store.isPlatformAdmin && !store.can(route.perm)) {
    outlet.replaceChildren(emptyFor('No access with your role', `Your roles (${(store.user?.roles || []).join(', ') || 'none'}) do not grant “${route.perm}”. Ask your administrator.`, 'lock'));
    return;
  }

  outlet.replaceChildren();
  const holder = h('div', { class: 'page' });
  holder.appendChild(h('div', { class: 'stack' },
    h('div', { class: 'skel', style: { height: '46px', borderRadius: '12px' } }),
    h('div', { class: 'grid c4' }, [0, 1, 2, 3].map(() => h('div', { class: 'skel', style: { height: '110px', borderRadius: '12px' } }))),
    h('div', { class: 'skel', style: { height: '320px', borderRadius: '12px' } })));
  outlet.appendChild(holder);

  try {
    if (!cache.has(route.module)) cache.set(route.module, await import(`./pages/${route.module}.js`));
    const mod = cache.get(route.module);
    const ctx = { path, route };
    const result = await mod.render(holder, ctx);
    if (typeof result === 'function') currentCleanup = result;
    outlet.scrollTop = 0;
  } catch (e) {
    console.error(e);
    holder.replaceChildren(emptyFor('Failed to load', e?.message || 'Could not render this page.', 'warning',
      btn('Retry', { cls: 'primary', ico: 'refresh', onClick: () => navigate(onNavigate) })));
  }
}

function emptyFor(title, msg, ico, action) {
  return h('div', { class: 'page' }, pageHead('Restricted'), h('div', { class: 'card' }, emptyState(title, msg, ico, action)));
}

/** Map entitlement → recommended plan for upgrade CTAs. */
export function planFor(ent) {
  const map = {
    'TAWA.PROCUREMENT': 'STARTER', 'TAWA.DELIVERY': 'STARTER', 'TAWA.SMS': 'STARTER', 'TAWA.ANALYTICS': 'STARTER',
    'TAWA.AI': 'STARTER', 'TAWA.WHITE_LABEL': 'STARTER', 'TAWA.PROMOTIONS': 'STARTER', 'TAWA.ACCOUNTING': 'STARTER',
  };
  return map[ent] || 'PROFESSIONAL';
}

export function go(path) { location.hash = '#' + path; }
