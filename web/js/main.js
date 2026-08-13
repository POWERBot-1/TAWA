/**
 * TAWA SPA bootstrap — brand resolution, auth gate, app shell,
 * command palette, global shortcuts, notification centre.
 */
import { api, ApiError } from './api.js';
import { store, applyBrand, esc, fmtMoney, timeAgo } from './store.js';
import { h, iconEl, btn, toast, presentError, modal, closeAllOverlays, field, input, debounce, pill } from './ui.js';
import { initRouter, ROUTES, go, currentRoute } from './router.js';

const app = document.getElementById('app');

// — forward state declarations (used during boot, before later sections parse) —
let shellBootedFor = null;
let renderedRouteId = null;

/* ---------------------------------------------------------------- boot */
(async function boot() {
  store.load();
  window.addEventListener('hashchange', guard);
  await guard();
})();

async function guard() {
  closeAllOverlays();
  const hash = location.hash || '#/dashboard';
  if (hash.startsWith('#/login')) return renderLogin();
  if (!store.session?.token) {
    if (!hash.startsWith('#/login')) location.hash = '#/login';
    return;
  }
  await bootShell();
}

async function bootShell() {
  try {
    const me = await api.get('/api/v1/auth/me');
    store.me = me;
    const brand = await fetchBrand(me.tenant?.code);
    applyBrand(brand);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return store.expire();
    // network hiccup — keep last known session, retry shortly
    setTimeout(bootShell, 3000);
    return;
  }
  if (shellBootedFor === store.user?.id) { return; } // shell persists across routes
  shellBootedFor = store.user?.id;
  renderShell();
}

async function fetchBrand(code) {
  try { return await api.get('/api/v1/brand', code ? { code } : undefined); }
  catch { return null; }
}

/* ---------------------------------------------------------------- login */
async function renderLogin() {
  shellBootedFor = null;
  document.title = 'Sign in · TAWA';
  let tenants = [];
  let brand = null;
  try { tenants = await api.get('/api/v1/public/tenants'); } catch { /* offline demo fallback */ }
  if (!location.hash.startsWith('#/login')) location.hash = '#/login';
  if (tenants.length === 1 && tenants[0].code) { /* single-tenant deploy */ }

  let selected = tenants[0]?.code || null;

  const updateBrand = async () => {
    try { brand = await api.get('/api/v1/brand', selected ? { code: selected } : undefined); applyBrand(brand); }
    catch { /* keep default */ }
    render();
  };

  const render = () => {
    const b = brand?.branding;
    const biz = b?.business_name || 'TAWA';
    const emailEl = input({ type: 'email', placeholder: 'you@business.co.ke', autocomplete: 'username', value: '' });
    const passEl = input({ type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const errEl = h('div', { class: 'err-t', style: { minHeight: '16px', fontSize: '12.5px' } });
    const loginBtn = btn('Sign in', { cls: 'primary lg block', ico: 'arrow-r' });

    const submit = async () => {
      errEl.textContent = '';
      if (!emailEl.value || !passEl.value) { errEl.textContent = 'Enter your email and password.'; return; }
      loginBtn.classList.add('busy'); loginBtn.disabled = true;
      try {
        const res = await api.post('/api/v1/auth/login', { email: emailEl.value.trim(), password: passEl.value, tenant_code: selected });
        store.setSession({ token: res.token, csrf: res.csrf, expires_at: res.expires_at, user: res.user });
        toast.ok(`Welcome back, ${res.user.name.split(' ')[0]}`);
        location.hash = '#/dashboard';
      } catch (e) {
        loginBtn.classList.remove('busy'); loginBtn.disabled = false;
        errEl.textContent = e?.message || 'Invalid credentials';
      }
    };
    loginBtn.addEventListener('click', submit);
    passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    emailEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') passEl.focus(); });

    app.className = '';
    app.replaceChildren(h('div', { class: 'login-wrap' },
      h('div', { class: 'login-hero' },
        h('div', { class: 'grid-art' }),
        h('div', { class: 'hero-brand' },
          h('div', { class: 'brand-mark' }, esc((b?.logo_monogram || 'T').slice(0, 2).toUpperCase())),
          h('div', { class: 'brand-meta' },
            h('div', { class: 'brand-name', style: { fontSize: '17px' } }, esc(biz)),
            h('div', { class: 'brand-tag' }, esc(b?.tagline || 'Hardware Business Operating System')))),
        h('div', { class: 'hero-mid' },
          h('h1', { html: `Sell. Stock. Procure.<br><span class="accent">One platform.</span>` }),
          h('p', {}, 'The operating system for hardware businesses — POS, inventory, procurement, credit, payroll, payments and AI, with bank-grade controls under the hood.'),
          h('div', { class: 'hero-points' },
            [['approve', 'Double-entry ledger on every transaction'],
            ['shield-check', 'Immutable audit trail & role-based access'],
            ['bolt', 'AI copilot — recommends, never executes'],
          ].map(([i, t]) => h('div', { class: 'hero-point' }, iconEl(i, 16, 2.2), t)))),
        h('div', { class: 'hero-foot' },
          h('span', {}, 'TAWA v1.0'), h('span', {}, 'POWERED BY JATA QI'), h('span', {}, 'MULTI-TENANT · WHitelabel'.replace('WHitelabel', 'WHITE-LABEL')))),
      h('div', { class: 'login-panel' },
        h('div', { class: 'login-box' },
          h('div', { class: 'lb-head' },
            h('h2', {}, 'Sign in'),
            h('p', {}, brand ? `to ${esc(biz)} workspace` : 'Pick your workspace, then sign in')),
          tenants.length > 1 ? h('div', { class: 'tenant-picker' },
            h('div', { class: 'hint', style: { marginBottom: '2px' } }, 'WORKSPACE'),
            tenants.map(t => h('button', {
              class: `tenant-opt${selected === t.code ? ' sel' : ''}`,
              onClick: () => { selected = t.code; updateBrand(); },
              style: { '--brand': t.color_primary || 'var(--brand)' },
            },
              h('span', { class: 'brand-mark', style: { background: t.color_primary || 'var(--brand)', width: '30px', height: '30px', fontSize: '12px' } }, esc((t.logo_monogram || t.business_name || t.name || '?').slice(0, 2).toUpperCase())),
              h('span', { class: 'brand-meta' },
                h('div', { class: 'to-name' }, esc(t.business_name || t.name)),
                h('div', { class: 'to-code' }, esc(t.code))),
              selected === t.code ? h('span', { class: 'to-check' }, iconEl('check', 16, 2.6)) : null))) : null,
          field('EMAIL', emailEl),
          field('PASSWORD', passEl),
          errEl,
          loginBtn,
          h('div', { class: 'demo-hint', html: `Demo — Alpha: <code>owner@alpha-hardware.co.ke / Alpha#2026!</code><br>BuildPro: <code>owner@buildpro.co.ke / Build#2026!</code> · Platform: <code>platform@tawa.app / Admin#2026!</code>` })))));
  };
  await updateBrand();
}

/* ---------------------------------------------------------------- shell */
function renderShell() {
  const isAdmin = store.isPlatformAdmin;
  const visible = ROUTES.filter(r => isAdmin ? r.adminOnly : !r.adminOnly);

  const sections = [];
  for (const r of visible) {
    if (!sections.find(s => s.name === r.section)) sections.push({ name: r.section, routes: [] });
    sections.find(s => s.name === r.section).routes.push(r);
  }

  const sidebar = h('aside', { class: 'sidebar' },
    brandLockup(),
    h('div', { class: 'nav-scroll' }, sections.map(sec =>
      h('div', {},
        h('div', { class: 'nav-section' }, h('span', {}, sec.name)),
        sec.routes.map(r => navItem(r))))),
    !isAdmin ? h('div', { class: 'side-foot' },
      h('div', { class: 'plan-chip' }, iconEl('shield', 14),
        h('span', {}, 'PLAN ', h('b', {}, store.me?.plan || '—')),
        h('span', { style: { marginLeft: 'auto' } }))) : null);

  const topnav = h('div', { class: 'topnav' },
    h('button', { class: 'icon-btn menu-btn', onClick: () => shell.classList.toggle('nav-open') }, iconEl('menu', 17)),
    h('div', { class: 't-title' }, h('h1', { id: 'tt' }, 'TAWA'), h('div', { class: 't-sub', id: 'ts' }, '')),
    h('div', { class: 'spacer' }),
    h('button', { class: 'search-trigger', onClick: openPalette },
      iconEl('search', 15), h('span', { class: 'st-label' }, 'Search or jump…'), h('kbd', {}, '⌘K')),
    bellButton(),
    h('div', { class: 'user-chip', id: 'uchip', onClick: userMenu },
      h('span', { class: 'avatar' }, esc((store.user?.name || '?').split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase())),
      h('div', { class: 'u-meta' },
        h('div', { class: 'u-name' }, esc(store.user?.name || '')),
        h('div', { class: 'u-role' }, esc((store.user?.roles || []).join(' · ') || 'ADMIN')))));

  const content = h('div', { class: 'content' }, h('div', { id: 'outlet', class: 'grow' }));

  const main = h('div', { class: 'main' }, topnav, content);
  const navScrim = h('div', { class: 'nav-scrim', onClick: () => shell.classList.remove('nav-open') });
  const shell = h('div', { class: 'shell' }, sidebar, main, navScrim, bottomNav());

  app.className = '';
  app.replaceChildren(shell);

  initRouter(content.querySelector('#outlet'), (route) => {
    const tt = document.getElementById('tt');
    const ts = document.getElementById('ts');
    if (route && tt) {
      tt.textContent = route.title;
      ts.textContent = route.sub || route.section;
      document.title = `${route.title} · ${store.brand?.branding?.business_name || 'TAWA'}`;
    }
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === route?.id));
    document.querySelectorAll('.bn-item').forEach(n => n.classList.toggle('on', n.dataset.route === route?.id));
    shell.classList.remove('nav-open');
  });

  bindShortcuts();

  // unread badge polling (light)
  const poll = async () => {
    if (!store.session) return;
    try {
      const data = await api.get('/api/v1/notifications', { limit: 30 });
      const unread = (data.items || data || []).filter(n => !n.read_at).length;
      const dot = document.getElementById('bell-dot');
      if (dot) dot.style.display = unread ? 'block' : 'none';
      const nb = document.querySelector('.nav-item[data-route="alerts"] .nav-badge');
      if (nb) { nb.textContent = unread; nb.style.display = unread ? 'grid' : 'none'; }
    } catch { /* silent */ }
    setTimeout(poll, 45000);
  };
  poll();
}

function brandLockup() {
  const b = store.brand?.branding;
  const name = store.isPlatformAdmin ? 'TAWA Platform' : (b?.business_name || store.tenant?.name || 'TAWA');
  const mono = (b?.logo_monogram || name || 'T').slice(0, 2).toUpperCase();
  return h('div', { class: 'brand-lockup' },
    h('div', { class: 'brand-mark' }, esc(mono)),
    h('div', { class: 'brand-meta grow', style: { minWidth: 0 } },
      h('div', { class: 'brand-name ellipsis' }, esc(name)),
      h('div', { class: 'brand-tag' }, store.isPlatformAdmin ? 'JATA QI CONTROL PLANE' : (b?.white_label ? 'POWERED WORKSPACE' : 'POWERED BY TAWA'))));
}

function navItem(r) {
  const locked = r.ent && !store.isPlatformAdmin && !store.has(r.ent);
  const noPerm = r.perm && !store.isPlatformAdmin && !store.can(r.perm);
  return h('a', {
    class: `nav-item${locked ? ' locked' : ''}`, href: `#${r.path}`, dataset: { route: r.id },
    title: locked ? `${r.title} — not in current plan` : r.title,
  },
    iconEl(locked ? 'lock' : r.icon, 17),
    h('span', { class: 'nav-label' }, r.title),
    noPerm && !locked ? h('span', { class: 'faint', style: { fontSize: '10px' } }, '') : null,
    r.id === 'alerts' ? h('span', { class: 'nav-badge', style: { display: 'none' } }) : null);
}

function bellButton() {
  return h('button', { class: 'icon-btn', title: 'Notifications', onClick: openNotifications },
    iconEl('bell', 16), h('span', { class: 'dot', id: 'bell-dot', style: { display: 'none' } }));
}

function bottomNav() {
  const picks = [
    ROUTES.find(r => r.id === 'dashboard'),
    ROUTES.find(r => r.id === 'pos'),
    ROUTES.find(r => r.id === 'orders'),
    ROUTES.find(r => r.id === 'ai'),
  ].filter(r => r && !r.adminOnly);
  return h('div', { class: 'bottom-nav' }, h('div', { class: 'bn-row', style: { gridTemplateColumns: `repeat(${store.isPlatformAdmin ? 2 : 5}, 1fr)` } },
    store.isPlatformAdmin
      ? [h('a', { class: 'bn-item', href: '#/platform', dataset: { route: 'platform' } }, iconEl('admin', 19), 'Platform'),
         h('button', { class: 'bn-item', onClick: openPalette }, iconEl('search', 19), 'Search')]
      : [...picks.map(r => h('a', { class: 'bn-item', href: `#${r.path}`, dataset: { route: r.id } }, iconEl(r.icon, 19), r.title.split(' ')[0])),
         h('button', { class: 'bn-item', onClick: openPalette }, iconEl('search', 19), 'Search')]));
}

/* ---------------- user menu ---------------- */
function userMenu() {
  const u = store.user;
  modal({
    title: u.name, sub: u.email, ico: 'user',
    body: h('div', { class: 'stack' },
      h('div', { class: 'row wrap', style: { gap: '6px' } }, (u.roles || []).map(r => h('span', { class: 'badge-soft' }, r.replace(/_/g, ' ')))),
      u.tenant_id ? h('div', { class: 'tiny muted' }, `Workspace: ${store.tenant?.name || ''} · Plan ${store.me?.plan || '—'}`) : h('div', { class: 'tiny muted' }, 'Platform administration account'),
      h('hr', { class: 'divider' }),
      h('button', { class: 'btn', style: { width: '100%' }, onClick: changePasswordModal }, iconEl('key', 15), 'Change password'),
      u.tenant_id ? h('button', { class: 'btn', style: { width: '100%' }, onClick: () => { closeAllOverlays(); go('/settings'); } }, iconEl('settings', 15), 'Workspace settings') : null,
      h('button', { class: 'btn danger', style: { width: '100%' }, onClick: doLogout }, iconEl('logout', 15), 'Sign out')),
  });
}

function changePasswordModal() {
  const cur = input({ type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
  const nw = input({ type: 'password', placeholder: 'New password (12+ chars, mixed)', autocomplete: 'new-password' });
  const doIt = async () => {
    try {
      await api.post('/api/v1/auth/change-password', { current_password: cur.value, new_password: nw.value });
      closeAllOverlays();
      toast.ok('Password changed', 'Other sessions were revoked.');
    } catch (e) { presentError(e, 'Could not change password'); }
  };
  modal({
    title: 'Change password', ico: 'key', width: 'narrow',
    body: h('div', {}, field('CURRENT PASSWORD', cur), field('NEW PASSWORD', nw, { hint: 'Policy: 12+ characters with upper, lower, digit and symbol.' })),
    foot: h('div', { class: 'right' }, btn('Update password', { cls: 'primary', onClick: doIt })),
  });
}

async function doLogout() {
  try { await api.post('/api/v1/auth/logout'); } catch { /* ignore */ }
  store.clear();
  location.hash = '#/login';
}

/* ---------------- notifications drawer ---------------- */
import { drawer } from './ui.js';
async function openNotifications() {
  let data;
  try { data = await api.get('/api/v1/notifications', { limit: 25 }); } catch (e) { return presentError(e); }
  const items = data.items || data || [];
  const body = h('div', { class: 'stack sm' },
    items.length ? items.map(n => h('div', {
      class: `notif-item${n.read_at ? '' : ' unread'}`, style: { borderRadius: '10px', border: '1px solid var(--line)', borderBottom: '1px solid var(--line)' },
      onClick: async () => { try { await api.post(`/api/v1/notifications/${n.id}/read`); } catch { /* noop */ } closeAllOverlays(); if (n.link) go(n.link); },
    },
      h('span', { class: 'notif-ico' }, iconEl(n.severity === 'HIGH' ? 'warning' : 'bell', 15)),
      h('div', { class: 'grow' },
        h('div', { class: 'row between' }, h('span', { class: 'strong', style: { fontSize: '13px' } }, esc(n.title || n.type)), h('span', { class: 'tiny faint' }, timeAgo(n.created_at))),
        h('div', { class: 'tiny muted' }, esc(n.body || ''))))) : h('div', { class: 'faint tiny' }, 'All clear — no notifications.'));
  drawer({ title: 'Notifications', sub: `${items.filter(i => !i.read_at).length} unread`, ico: 'bell', body });
}

/* ---------------- command palette ---------------- */
let paletteOpen = false;
function openPalette() {
  if (paletteOpen) return; paletteOpen = true;
  let selIdx = 0;
  let items = [];
  const inputEl = h('input', { placeholder: 'Search products, customers, orders… or jump to a page', value: '' });
  const listEl = h('div', { class: 'palette-list' }, h('div', { class: 'palette-group' }, 'TYPE TO SEARCH'));

  const bd = h('div', { class: 'palette-backdrop' });
  const close = () => { paletteOpen = false; bd.remove(); document.removeEventListener('keydown', onKey, true); };
  bd.addEventListener('pointerdown', (e) => { if (e.target === bd) close(); });

  const run = (item) => {
    close();
    if (item.action) item.action();
    else if (item.href) go(item.href);
  };

  const paint = () => {
    listEl.replaceChildren();
    let group = null;
    items.forEach((it, i) => {
      if (it.group !== group) { group = it.group; listEl.appendChild(h('div', { class: 'palette-group' }, group)); }
      listEl.appendChild(h('div', {
        class: `palette-item${i === selIdx ? ' sel' : ''}`,
        onClick: () => run(it),
        onMouseenter: () => { selIdx = i; paint(); },
      },
        h('span', { class: 'p-ico', style: { display: 'grid', color: 'var(--text-3)' } }, iconEl(it.ico, 16)),
        h('span', {}, it.label),
        it.sub ? h('span', { class: 'p-sub ellipsis' }, it.sub) : null));
    });
  };

  const navItems = ROUTES
    .filter(r => r.adminOnly ? store.isPlatformAdmin : !store.isPlatformAdmin)
    .filter(r => !r.perm || store.isPlatformAdmin || store.can(r.perm))
    .map(r => ({ group: 'GO TO', label: r.title, sub: r.kbd ? `G ${r.kbd}` : '', ico: r.icon, href: r.path }));

  const search = debounce(async () => {
    const q = inputEl.value.trim();
    if (!q) { items = navItems; selIdx = 0; paint(); return; }
    const lq = q.toLowerCase();
    const navHits = navItems.filter(n => n.label.toLowerCase().includes(lq));
    let results = [];
    try { results = (await api.get('/api/v1/search', { q }))?.results || []; } catch { results = []; }
    const moduleFor = { product: 'products', customer: 'customers', order: 'orders', quote: 'quotes', supplier: 'suppliers', worker: 'workers', broker: 'brokers' };
    const grouped = results.slice(0, 8).map(r => ({
      group: 'RESULTS',
      label: r.title,
      sub: r.sub || '',
      ico: { product: 'products', customer: 'customers', order: 'orders', quote: 'quotes', supplier: 'suppliers', worker: 'workers', broker: 'brokers' }[r.kind] || 'search',
      action: () => go(`/${moduleFor[r.kind] || 'dashboard'}?id=${r.id}`),
    }));
    items = [...grouped, ...navHits];
    selIdx = 0; paint();
  }, 180);

  inputEl.addEventListener('input', search);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); selIdx = Math.min(items.length - 1, selIdx + 1); paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selIdx = Math.max(0, selIdx - 1); paint(); }
    if (e.key === 'Enter') { e.preventDefault(); if (items[selIdx]) run(items[selIdx]); }
  };
  document.addEventListener('keydown', onKey, true);

  bd.appendChild(h('div', { class: 'palette' },
    h('div', { class: 'palette-in' }, iconEl('search', 17), inputEl),
    listEl,
    h('div', { class: 'palette-foot' },
      h('span', {}, h('kbd', {}, '↑↓'), ' navigate'),
      h('span', {}, h('kbd', {}, '↵'), ' open'),
      h('span', {}, h('kbd', {}, 'esc'), ' close'))));
  document.getElementById('overlays').appendChild(bd);
  items = navItems; paint();
  inputEl.focus();
}

/* ---------------- global shortcuts ---------------- */
let shortcutsBound = false;
function bindShortcuts() {
  if (shortcutsBound) return; shortcutsBound = true;
  document.addEventListener('keydown', (e) => {
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'g') { pendingG = true; setTimeout(() => pendingG = false, 900); return; }
    if (pendingG) {
      pendingG = false;
      const r = ROUTES.find(x => x.kbd === e.key.toUpperCase());
      if (r && (!r.perm || store.can(r.perm)) && (!r.ent || store.has(r.ent))) go(r.path);
    }
    if (e.key === '/') { e.preventDefault(); openPalette(); }
  });
}
let pendingG = false;
