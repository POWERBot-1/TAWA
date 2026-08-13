/**
 * TAWA UI kit — hyperscript, overlays, toasts, tables, charts (pure SVG).
 */
import { icon, iconEl } from './icons.js';
import { fmtMoney, fmtNum, fmtDate, fmtDT, timeAgo, esc, store } from './store.js';

export { fmtMoney, fmtNum, fmtDate, fmtDT, timeAgo, esc, icon, iconEl };

/* ---------------- hyperscript ---------------- */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}
export const frag = (...kids) => { const f = document.createDocumentFragment(); append(f, kids); return f; };
export const txt = (s) => document.createTextNode(s ?? '');

/* ---------------- debounce ---------------- */
export function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------- status pills ---------------- */
const STATUS_TONE = {
  // orders & quotes
  DRAFT: 'neutral', REVIEW: 'warn', SENT: 'info', VIEWED: 'info', ACCEPTED: 'ok', REJECTED: 'danger', EXPIRED: 'neutral', CANCELLED: 'neutral',
  CONVERTED: 'brand', CONFIRMED: 'info', COMPLETED: 'ok', PAID: 'ok', UNPAID: 'warn', PARTIAL: 'warn', PARTIALLY_PAID: 'warn', PARTIALLY_FULFILLED: 'warn', PARTIALLY_RECEIVED: 'info',
  QUOTE: 'neutral',
  // payments
  CREATED: 'neutral', REQUIRES_ACTION: 'warn', PROCESSING: 'info', VERIFIED: 'ok', SETTLED: 'ok', FAILED: 'danger', REVERSED: 'danger', REFUNDED: 'warn', PENDING: 'warn',
  // inventory / procurement
  PENDING_APPROVAL: 'warn', APPROVED: 'ok', OPEN: 'warn', RECEIVING: 'info', RECEIVED: 'ok', ISSUED: 'info', CLOSED: 'ok',
  // deliveries
  PICKING: 'info', PACKED: 'info', READY: 'info', ASSIGNED: 'info', DISPATCHED: 'brand', IN_TRANSIT: 'brand', DELIVERED: 'ok', RETURNED: 'danger',
  // workforce
  ACTIVE: 'ok', SUSPENDED: 'neutral', LOCKED: 'danger', TERMINATED: 'neutral', ON_LEAVE: 'warn',
  CALCULATED: 'info', REVIEWED: 'info', EXECUTED: 'ok', EXECUTING: 'warn',
  TODO: 'neutral', DOING: 'info', VERIFY: 'warn', DONE: 'ok', BLOCKED: 'danger',
  // money
  SUBMITTED: 'info', PAID_OUT: 'ok', OVERDUE: 'danger',
  // marketing
  SCHEDULED: 'info', RUNNING: 'brand', RUNNING_LOW: 'warn', ENDED: 'neutral',
  // misc
  SUCCESS: 'ok', ENABLED: 'ok', DISABLED: 'neutral', READ: 'neutral', UNREAD: 'brand', SANDBOX: 'warn', LIVE: 'ok',
  HIGH: 'danger', MEDIUM: 'warn', LOW: 'info', URGENT: 'danger', CRITICAL: 'danger', NORMAL: 'info',
  NEW: 'brand', CONTACTED: 'info', WON: 'ok', LOST: 'danger',
};
export function pill(status, { raw } = {}) {
  const s = String(status ?? '—');
  const tone = STATUS_TONE[s] || 'neutral';
  const label = raw ? s : s.replace(/_/g, ' ');
  return h('span', { class: `pill ${tone}` }, h('span', { class: 'pdot' }), label);
}

/* ---------------- page scaffolding ---------------- */
export function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', { class: 'ph-t' }, title), sub ? h('div', { class: 'ph-sub' }, sub) : null),
    actions.length ? h('div', { class: 'ph-actions' }, actions) : null);
}

export function card({ title, sub, right, flush, body, foot, cls = '' }) {
  return h('div', { class: `card ${cls}` },
    title || right ? h('div', { class: 'card-h' },
      h('div', { class: 'grow' }, h('h3', {}, title), sub ? h('div', { class: 'h-sub' }, sub) : null),
      right ? h('div', { class: 'h-right' }, right) : null) : null,
    h('div', { class: `card-b${flush ? ' flush' : ''}` }, body),
    foot ? h('div', { class: 'card-f' }, foot) : null);
}

export function kpi({ label, value, foot, ico, strip = 'brand', onClick }) {
  return h('div', { class: `card kpi ${strip}-strip${onClick ? ' clickable' : ''}`, onClick, style: onClick ? { cursor: 'pointer' } : null },
    h('div', { class: 'k-label' }, ico ? iconEl(ico, 13, 2) : null, label),
    h('div', { class: 'k-value num' }, value ?? '—'),
    foot ? h('div', { class: 'k-foot' }, foot) : null);
}
export function delta(v, suffix = '%') {
  if (v === null || v === undefined || Number.isNaN(+v)) return null;
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const ic = v > 0 ? 'trend' : v < 0 ? 'trend-down' : 'minus';
  return h('span', { class: `delta ${cls}` }, iconEl(ic, 11, 2.4), `${v > 0 ? '+' : ''}${(+v).toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`);
}

/* ---------------- table ---------------- */
/**
 * cols: [{ key, label, align, width, render(row), sortKey }]
 */
export function table(cols, rows, { onRow, emptyMsg, emptyTitle, ico = 'inbox', pageSize = 0, foot } = {}) {
  if (!rows?.length) return emptyState(emptyTitle || 'Nothing here yet', emptyMsg || 'Records will appear here once created.', ico);
  const t = h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.align === 'r' ? 'r' : c.align === 'c' ? 'c' : '', style: c.width ? { width: c.width } : null }, c.label)))),
    h('tbody', {}, rows.map((r, i) =>
      h('tr', { class: onRow ? 'clickable' : '', onClick: onRow ? () => onRow(r, i) : null },
        cols.map(c => h('td', { class: c.align === 'r' ? 'r' : c.align === 'c' ? 'c' : 'num' in c && c.num ? 'num' : '' },
          c.render ? c.render(r, i) : (r[c.key] ?? '—')))))),
  );
  const wrap = h('div', { class: 'tbl-wrap' }, t);
  if (foot) return frag(wrap, h('div', { class: 'tbl-foot' }, foot));
  return wrap;
}

export function emptyState(title, msg, ico = 'inbox', action = null) {
  return h('div', { class: 'empty' },
    h('div', { class: 'e-ico' }, iconEl(ico, 24)),
    h('div', { class: 'e-title' }, title),
    h('div', { class: 'e-msg' }, msg),
    action || null);
}

export function skeleton(rows = 4, height = 40) {
  return h('div', { class: 'stack sm' },
    Array.from({ length: rows }, () => h('div', { class: 'skel', style: { height: height + 'px' } })));
}

/* ---------------- forms ---------------- */
export function field(label, input, { hint, error } = {}) {
  return h('div', { class: 'field' },
    label ? h('label', {}, label) : null,
    input,
    hint ? h('div', { class: 'hint' }, hint) : null,
    error ? h('div', { class: 'err-t' }, error) : null);
}
export function input(attrs = {}) { return h('input', { class: 'input', ...attrs }); }
export function select(options, attrs = {}) {
  return h('select', { class: 'select', ...attrs },
    options.map(o => h('option', { value: o.value ?? o, selected: (attrs.value ?? '') === (o.value ?? o) }, o.label ?? o)));
}
export function textarea(attrs = {}) { return h('textarea', { class: 'textarea', ...attrs }); }
export function btn(label, { cls = '', ico: i, onClick, type, size, busy } = {}) {
  return h('button', { class: `btn${size ? ' ' + size : ''}${cls ? ' ' + cls : ''}${busy ? ' busy' : ''}`, onClick, type: type || 'button', disabled: busy ? true : null },
    i ? iconEl(busy ? 'refresh' : i, 15, 2.2) : null, label);
}
export function iconBtn(i, title, onClick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title, onClick }, iconEl(i, 16));
}
export function tabs(list, current, onPick) {
  return h('div', { class: 'tabs' }, list.map(t =>
    h('button', { class: t.id === current ? 'on' : '', onClick: () => onPick(t.id) },
      t.label, t.count !== undefined ? h('span', { class: 'cnt' }, String(t.count)) : null)));
}
export function segmented(list, current, onPick) {
  return h('div', { class: 'segmented' }, list.map(o =>
    h('button', { class: (o.value ?? o) === current ? 'on' : '', onClick: () => onPick(o.value ?? o) }, o.label ?? o)));
}
export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
}
function searchBox(placeholder, onInput, attrs = {}) {
  const wrap = h('div', { class: 'input-group', style: { maxWidth: '300px', flex: '1' } },
    h('span', { class: 'ig-ico' }, iconEl('search', 15)),
    h('input', { class: 'input', type: 'search', placeholder, onInput: (e) => onInput(e.target.value), ...attrs }));
  return wrap;
}
export const searchField = searchBox;

/* ---------------- overlays ---------------- */
const overlays = () => document.getElementById('overlays');
const stack = [];

export function closeTop() { const top = stack.pop(); if (top) top.remove(); }
export function closeAllOverlays() { while (stack.length) closeTop(); }

function mountOverlay(el, { dismissable = true } = {}) {
  const bd = el;
  overlays().appendChild(bd);
  stack.push(bd);
  const close = () => { const i = stack.indexOf(bd); if (i >= 0) { stack.splice(i, 1); bd.remove(); } };
  if (dismissable) bd.addEventListener('pointerdown', (e) => { if (e.target === bd) close(); });
  const onKey = (e) => { if (e.key === 'Escape' && stack[stack.length - 1] === bd) close(); };
  document.addEventListener('keydown', onKey);
  const obs = new MutationObserver(() => { if (!document.contains(bd)) { document.removeEventListener('keydown', onKey); obs.disconnect(); } });
  obs.observe(overlays(), { childList: true });
  return close;
}

export function modal({ title, sub, body, foot, width = '', ico: i, onClose }) {
  const bd = h('div', { class: 'modal-backdrop' });
  const close = mountOverlay(bd);
  const m = h('div', { class: `modal ${width}` },
    h('div', { class: 'modal-h' },
      i ? h('span', { style: { color: 'var(--brand)', display: 'grid' } }, iconEl(i, 20)) : null,
      h('div', { class: 'grow' }, h('h2', {}, title), sub ? h('div', { class: 'h-sub' }, sub) : null),
      h('button', { class: 'icon-btn x', onClick: () => close() }, iconEl('x', 15))),
    h('div', { class: 'modal-b' }, body),
    foot ? h('div', { class: 'modal-f' }, foot) : null);
  bd.appendChild(m);
  if (onClose) { const orig = close; }
  return close;
}

export function drawer({ title, sub, body, foot, ico: i }) {
  const bd = h('div', { class: 'drawer-backdrop' });
  const close = mountOverlay(bd);
  const d = h('div', { class: 'drawer' },
    h('div', { class: 'modal-h' },
      i ? h('span', { style: { color: 'var(--brand)', display: 'grid' } }, iconEl(i, 20)) : null,
      h('div', { class: 'grow' }, h('h2', {}, title), sub ? h('div', { class: 'h-sub' }, sub) : null),
      h('button', { class: 'icon-btn x', onClick: () => close() }, iconEl('x', 15))),
    h('div', { class: 'modal-b' }, body),
    foot ? h('div', { class: 'modal-f' }, foot) : null);
  bd.appendChild(d);
  return close;
}

export function confirmBox({ title, message, confirmLabel = 'Confirm', danger = false, ico = 'warning' }) {
  return new Promise((resolve) => {
    const bd = h('div', { class: 'modal-backdrop' });
    const close = mountOverlay(bd);
    const done = (v) => { close(); resolve(v); };
    const m = h('div', { class: 'modal narrow' },
      h('div', { class: 'modal-h' },
        h('span', { style: { color: danger ? 'var(--danger)' : 'var(--brand)', display: 'grid' } }, iconEl(ico, 20)),
        h('div', { class: 'grow' }, h('h2', {}, title)),
        h('button', { class: 'icon-btn x', onClick: () => done(false) }, iconEl('x', 15))),
      h('div', { class: 'modal-b' }, h('p', { style: { margin: 0, color: 'var(--text-2)', fontSize: 'var(--fs-13)' } }, message)),
      h('div', { class: 'modal-f' }, h('div', { class: 'right' },
        btn('Cancel', { cls: 'ghost', onClick: () => done(false) }),
        btn(confirmLabel, { cls: danger ? 'danger' : 'primary', onClick: () => done(true) }))));
    bd.appendChild(m);
  });
}

/* ---------------- toasts ---------------- */
let toastStackEl = null;
export function toast(kind, title, msg = '', timeout = 4200) {
  if (!toastStackEl) {
    toastStackEl = h('div', { class: 'toast-stack' });
    document.body.appendChild(toastStackEl);
  }
  const icons = { ok: 'approve', err: 'warning', warn: 'warning', info: 'info' };
  const t = h('div', { class: `toast ${kind}`, role: 'status' },
    h('span', { class: 't-ico' }, iconEl(icons[kind] || 'info', 17, 2.2)),
    h('div', { class: 't-body' }, h('div', { class: 't-title' }, title), msg ? h('div', { class: 't-msg' }, msg) : null),
    h('button', { class: 'icon-btn', style: { width: '24px', height: '24px', border: 'none', background: 'none' }, onClick: () => t.remove() }, iconEl('x', 12)));
  toastStackEl.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity 300ms'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, timeout);
}
toast.ok = (t, m) => toast('ok', t, m);
toast.err = (t, m) => toast('err', t, m);
toast.warn = (t, m) => toast('warn', t, m);
toast.info = (t, m) => toast('info', t, m);

/** Standard error presenter from ApiError. */
export function presentError(e, fallback = 'Something went wrong') {
  if (e?.status === 402) return toast.warn('Subscription gate', e.message || 'This module is not in your current plan.');
  if (e?.status === 403) return toast.err('Not permitted', e.message || 'Your role cannot perform this action.');
  if (e?.code === 'INSUFFICIENT_STOCK') return toast.err('Insufficient stock', e.message);
  if (e?.status === 409) return toast.err('Conflict', e.message);
  if (e?.status === 422) return toast.err('Check the form', e.message);
  toast.err(fallback, e?.message || String(e));
}

/* ---------------- charts (pure SVG, no gradients) ---------------- */
export function spark(values, { w = 260, hgt = 56, color = 'var(--brand)', dots = false } = {}) {
  if (!values?.length) return h('div', { class: 'faint tiny' }, 'No data');
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = w / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${(hgt - 4 - ((v - min) / span) * (hgt - 8)).toFixed(1)}`);
  const area = `M0,${hgt} L${pts.join(' L')} L${w},${hgt} Z`;
  const svg = `<svg width="100%" height="${hgt}" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" opacity="0.08"></path>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></polyline>
    ${dots ? pts.map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2" fill="${color}"></circle>`).join('') : ''}
  </svg>`;
  const el = h('div', { html: svg });
  return el;
}

export function vbars(items, { w = 520, hgt = 140, color = 'var(--brand)', labelEvery = 1 } = {}) {
  if (!items?.length) return h('div', { class: 'faint tiny' }, 'No data');
  const max = Math.max(...items.map(i => i.value), 1);
  const bw = Math.min(34, (w / items.length) - 6);
  const gap = (w - items.length * bw) / Math.max(items.length - 1, 1);
  let x = 0;
  const parts = [];
  for (let i = 0; i < items.length; i++) {
    const bh = Math.max(2, (items[i].value / max) * (hgt - 24));
    const y = hgt - 18 - bh;
    const hl = items[i].hl ? 'var(--brand)' : 'var(--surface-3)';
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="3" fill="${hl === 'var(--surface-3)' ? 'var(--line-strong)' : color}"></rect>`);
    if (i % labelEvery === 0) parts.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${hgt - 4}" font-size="8.5" fill="var(--text-4)" text-anchor="middle" font-family="var(--mono)">${esc(items[i].label)}</text>`);
    x += bw + gap;
  }
  return h('div', { class: 'chart-scroll', style: { overflowX: 'auto' }, html: `<svg width="100%" height="${hgt}" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="xMidYMid meet" style="min-width:${Math.min(w, 420)}px">${parts.join('')}</svg>` });
}

export function barList(rows, { max: forcedMax, valueFmt = fmtNum, toneColor = 'var(--brand)' } = {}) {
  const m = forcedMax ?? Math.max(...rows.map(r => r.value), 1);
  return h('div', { class: 'stack', style: { gap: '2px' } }, rows.map(r =>
    h('div', { class: 'bar-row' },
      h('div', { class: 'b-label ellipsis', title: r.label }, r.label),
      h('div', { class: 'b-val num' }, valueFmt(r.value)),
      h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${r.tone || ''}`, style: { width: `${Math.max(2, (r.value / m) * 100)}%`, background: r.color || toneColor } })))));
}

/* ---------------- misc helpers ---------------- */
export function money(minor, opts) { return fmtMoney(minor, opts); }
export function stat(label, value, sub) {
  return h('div', { class: 'stack xs' },
    h('div', { class: 'tiny faint', style: { textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 } }, label),
    h('div', { class: 'strong num', style: { fontSize: 'var(--fs-18)' } }, value ?? '—'),
    sub ? h('div', { class: 'tiny muted' }, sub) : null);
}
export function lockScreen(feature, plan = 'PROFESSIONAL') {
  return h('div', { class: 'card' }, h('div', { class: 'lock-card' },
    h('div', { class: 'lk-ico' }, iconEl('lock', 26)),
    h('h2', {}, `${feature} is not in your plan`),
    h('p', {}, `Upgrade to ${plan} or higher to unlock this module. Usage and entitlements are enforced on the server.`),
    h('div', { class: 'row' }, btn('View plans & upgrade', { cls: 'primary', ico: 'trend', onClick: () => { location.hash = '#/settings/subscription'; } }))));
}
export function timeline(items) {
  return h('div', { class: 'timeline' }, items.map(it =>
    h('div', { class: `tl-item ${it.tone || ''}` },
      h('div', { class: 'tl-t' }, it.title),
      it.meta ? h('div', { class: 'tl-m' }, it.meta) : null)));
}
export function copyText(text, label = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast.ok(label, text)).catch(() => toast.err('Copy failed'));
}
export const idempotencyKey = () => (crypto.randomUUID ? crypto.randomUUID() : `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
export const statusTone = (s) => STATUS_TONE[s] || 'neutral';

/** Safe currency formatter for table cells */
export const mcell = (v) => h('span', { class: 'num strong' }, fmtMoney(v));
