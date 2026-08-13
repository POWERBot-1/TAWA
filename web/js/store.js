/**
 * Session & brand store. Tenant identity is server-derived; the client only
 * mirrors it for UX gating. All enforcement happens server-side.
 */
const LS_KEY = 'tawa.session.v1';

export const store = {
  session: null,        // { token, csrf, expires_at, user }
  me: null,             // /auth/me payload
  brand: null,          // /api/v1/brand payload
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) fn(); },

  load() {
    try { this.session = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { this.session = null; }
    if (this.session && this.session.expires_at && new Date(this.session.expires_at) < new Date()) this.session = null;
  },
  save() {
    if (this.session) localStorage.setItem(LS_KEY, JSON.stringify(this.session));
    else localStorage.removeItem(LS_KEY);
  },
  setSession(s) { this.session = s; this.save(); this.emit(); },
  clear() { this.session = null; this.me = null; this.save(); this.emit(); },
  expire() { this.clear(); if (!location.hash.startsWith('#/login')) location.hash = '#/login'; },

  get user() { return this.me?.user || this.session?.user || null; },
  get tenant() { return this.me?.tenant || null; },
  get csrf() { return this.me?.csrf || this.session?.csrf || null; },
  get perms() { return new Set(this.me?.perms || []); },
  get entitlements() { return new Set(this.me?.entitlements || []); },
  get plan() { return this.me?.plan || this.brand?.plan || 'FREE'; },
  get isPlatformAdmin() { return !!this.user && !this.user.tenant_id; },

  can(...perms) { const p = this.perms; return perms.some(x => p.has(x)); },
  canAll(...perms) { const p = this.perms; return perms.every(x => p.has(x)); },
  has(ent) { return this.isPlatformAdmin || this.entitlements.has(ent); },

  currency() { return this.tenant?.currency || this.brand?.tenant?.currency || 'KES'; },
};

/* ---------------- brand → CSS variables (white-label engine) ---------------- */

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function relLum({ r, g, b }) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrastRatio(fg, bg = '#FFFFFF') {
  const a = hexToRgb(fg), b = hexToRgb(bg);
  if (!a || !b) return 21;
  const l1 = relLum(a) + 0.05, l2 = relLum(b) + 0.05;
  return Math.max(l1, l2) / Math.min(l1, l2);
}
/** Pick legible ink for a brand fill: near-black or near-white, best contrast wins. */
export function inkOn(bg) {
  return contrastRatio('#141312', bg) >= contrastRatio('#F5F7FA', bg) ? '#141312' : '#F5F7FA';
}
const rgba = ({ r, g, b }, a) => `rgba(${r}, ${g}, ${b}, ${a})`;

export function applyBrand(brand) {
  store.brand = brand;
  const b = brand?.branding || {};
  const root = document.documentElement;
  const primary = b.color_primary || '#F0A824';
  root.style.setProperty('--brand', primary);
  root.style.setProperty('--brand-ink', b.color_text && contrastRatio(b.color_text, primary) >= 4.5 ? b.color_text : inkOn(primary));
  const rgb = hexToRgb(primary);
  if (rgb) {
    root.style.setProperty('--brand-soft', rgba(rgb, 0.13));
    root.style.setProperty('--brand-line', rgba(rgb, 0.38));
  }
  if (b.color_success) root.style.setProperty('--ok', b.color_success);
  if (b.color_warning) root.style.setProperty('--warn', b.color_warning);
  if (b.color_error) root.style.setProperty('--danger', b.color_error);

  const name = b.business_name || brand?.tenant?.name || 'TAWA';
  document.title = brand?.branding?.white_label ? name : `${name} · TAWA`;

  // Dynamic favicon: brand-colored monogram
  const mono = (b.logo_monogram || name || 'T').slice(0, 1).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${primary}"/><text x="32" y="43" font-family="Arial, sans-serif" font-size="30" font-weight="800" text-anchor="middle" fill="${inkOn(primary)}">${mono}</text></svg>`;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** Format minor units as major currency string. */
export function fmtMoney(minor, { currency, dash = false } = {}) {
  if (minor === null || minor === undefined || Number.isNaN(Number(minor))) return dash ? '—' : `${currencySymbol(currency)}0.00`;
  const cur = currency || store.currency();
  const major = Number(minor) / 100;
  const s = major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cur} ${s}`;
}
export function currencySymbol() { return store.currency(); }
export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDT(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
export function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
