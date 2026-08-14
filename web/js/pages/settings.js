/** Settings — workspace, users & roles, branding (white-label), flags, subscription, integrations, domains, audit. */
import { api } from '../api.js';
import { store, applyBrand, contrastRatio } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, modal, field, input, select, kv, iconEl, emptyState, confirmBox } from '../ui.js';
import { go } from '../router.js';

const SECTIONS = [
  { id: 'workspace', label: 'Workspace', icon: 'branches' },
  { id: 'users', label: 'Users & roles', icon: 'user', perm: 'users.manage' },
  { id: 'branding', label: 'Branding & white-label', icon: 'palette', perm: 'branding.manage', ent: 'TAWA.WHITE_LABEL' },
  { id: 'flags', label: 'Feature flags', icon: 'flag', perm: 'settings.manage' },
  { id: 'subscription', label: 'Subscription & plans', icon: 'shield', perm: 'settings.manage' },
  { id: 'payments', label: 'Payment providers', icon: 'wallet', perm: 'settings.manage' },
  { id: 'onboarding', label: 'Onboarding', icon: 'gauge', perm: 'settings.manage' },
  { id: 'data', label: 'Data & API', icon: 'database', perm: 'exports.view' },
  { id: 'integrations', label: 'Integrations', icon: 'plug', perm: 'integrations.manage' },
  { id: 'audit', label: 'Audit trail', icon: 'history', perm: 'audit.view' },
];

export async function render(el, ctx) {
  const section = (ctx.path.match(/^\/settings\/(\w+)/) || [, 'workspace'])[1];
  const nav = h('div', { class: 'settings-nav' });
  const pane = h('div', { class: 'stack' });

  function paintNav() {
    nav.replaceChildren(SECTIONS.filter(s => !s.perm || store.can(s.perm)).map(s =>
      h('button', { class: s.id === section ? 'on' : '', onClick: () => go(`/settings/${s.id}`) },
        iconEl(s.ent && !store.has(s.ent) ? 'lock' : s.icon, 15), s.label)));
  }

  async function paintPane() {
    pane.replaceChildren(h('div', { class: 'skel', style: { height: '300px', borderRadius: '12px' } }));
    try {
      const view = {
        workspace: workspaceView, users: usersView, branding: brandingView, flags: flagsView,
        subscription: subscriptionView, integrations: integrationsView, audit: auditView,
        payments: paymentsView, onboarding: onboardingView, data: dataView,
      }[section] || workspaceView;
      pane.replaceChildren(await view());
    } catch (e) {
      pane.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-b' }, emptyState('Unavailable', e?.message || 'Could not load this section.', 'warning'))));
    }
  }


  /* ---------------- payment providers (§32) ---------------- */
  async function paymentsView() {
    const rows = (await api.get('/api/v1/settings/payment-config')).data;
    return h('div', { class: 'stack' },
      card({
        title: 'Payment providers', sub: 'Per-business provider configuration. Secrets are stored server-side and never shown here.',
        body: h('div', { class: 'stack sm' }, rows.map(p => h('div', { class: 'row between', style: { padding: '10px 0', borderBottom: '1px solid var(--line)' } },
          h('div', {},
            h('div', { class: 't-main' }, p.label || p.provider),
            h('div', { class: 't-sub' }, `${p.environment}${p.mode ? ' · mode ' + p.mode : ''}${p.credentials_ref ? ' · key ' + p.credentials_ref : ''}`)),
          h('div', { class: 'row', style: { gap: '8px' } },
            pill(Number(p.enabled) ? 'ENABLED' : 'DISABLED'),
            btn(Number(p.enabled) ? 'Disable' : 'Enable', { size: 'sm', onClick: async () => {
              await api.put(`/api/v1/settings/payment-config/${p.provider}`, { enabled: !Number(p.enabled) });
              toast.ok('Provider updated', `${p.provider} ${Number(p.enabled) ? 'disabled — every payment flow now fails closed for it' : 'enabled'}`);
              paintPane();
            } }),
            btn('Test', { size: 'sm', ghost: true, ico: 'gauge', onClick: async () => {
              const r = await api.post(`/api/v1/settings/payment-config/${p.provider}/test`, {});
              toast.ok(`${p.provider}: ${r.data.status}`, `${r.data.environment} adapter — ${r.data.note || 'ok'}`);
            } }))))),
      }),
    );
  }

  /* ---------------- onboarding (§21) ---------------- */
  async function onboardingView() {
    const o = (await api.get('/api/v1/onboarding')).data;
    const steps = [
      ['Business profile', o.business_profile], ['Branch created', o.branches > 0], ['Warehouse created', o.warehouses > 0],
      ['Team invited', o.users > 1], ['First product', o.products > 0], ['Payment provider configured', o.payment_config],
    ];
    const done = steps.filter(x => x[1]).length;
    const tax = h('select', { class: 'select' }, ['INCLUSIVE', 'EXCLUSIVE'].map(v => h('option', { value: v, selected: (o.config?.tax_mode || 'INCLUSIVE') === v }, v)));
    const footer = h('input', { class: 'input', value: o.config?.receipt_footer || '' });
    const cur = h('input', { class: 'input', value: o.config?.default_currency || 'KES', maxlength: 3 });
    return h('div', { class: 'stack' },
      card({
        title: `Setup progress — ${done}/${steps.length}`, ico: 'gauge',
        sub: o.done ? 'Onboarding complete. You can revisit any step.' : 'Complete these to get fully operational.',
        body: h('div', { class: 'stack sm' }, steps.map(([label, ok2]) =>
          h('div', { class: 'row between', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
            h('span', {}, label), pill(ok2 ? 'DONE' : 'PENDING')))),
      }),
      card({
        title: 'Business rules', ico: 'settings',
        body: h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '12px' } },
          field('TAX MODE', tax), field('DEFAULT CURRENCY', cur), field('RECEIPT FOOTER', footer)),
        foot: h('div', { class: 'row end', style: { gap: '8px', width: '100%' } },
          btn('Save rules', { cls: 'primary', onClick: async () => {
            await api.put('/api/v1/onboarding', { config: { tax_mode: tax.value, default_currency: cur.value.toUpperCase(), receipt_footer: footer.value } });
            toast.ok('Saved', 'Business rules updated'); paintPane();
          } }),
          o.done ? null : btn('Mark onboarding complete', { ghost: true, onClick: async () => {
            await api.put('/api/v1/onboarding', { done: true }); toast.ok('Onboarding complete'); paintPane();
          } })),
      }),
    );
  }

  /* ---------------- data & api (§45/§46/§66) ---------------- */
  async function dataView() {
    const canKeys = store.can('apikeys.view') && store.has('TAWA.API');
    const canManageKeys = store.can('apikeys.manage') && store.has('TAWA.API');
    let keys = [];
    if (store.can('apikeys.view')) {
      try { keys = (await api.get('/api/v1/api-keys')).data; } catch { keys = null; }
    }
    const download = async (path, name) => {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${store.session?.token}` } });
      if (!res.ok) { toast.err('Download failed', `HTTP ${res.status}`); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    const keyCard = !store.can('apikeys.view') ? null :
      (!store.has('TAWA.API') || keys === null)
        ? card({ title: 'API access', ico: 'key', body: emptyState('API access locked', 'Programmatic API access requires the PROFESSIONAL plan or higher.', 'lock', btn('View plans', { cls: 'primary', onClick: () => go('/settings/subscription') })) })
        : card({
            title: 'API keys', ico: 'key',
            sub: 'Scoped, revocable credentials for integrations. Keys are shown once at creation.',
            body: keys.length ? table([
              { label: 'Name', render: r => h('span', { class: 't-main' }, r.name) },
              { label: 'Scopes', render: r => h('span', { class: 'mono tiny' }, r.scopes) },
              { label: 'Last used', render: r => h('span', { class: 'tiny muted' }, r.last_used_at ? fmtDT(r.last_used_at) : 'never') },
              { label: 'Status', render: r => pill(r.revoked_at ? 'REVOKED' : 'ACTIVE') },
              { label: '', align: 'r', render: r => r.revoked_at ? null : canManageKeys ? btn('Revoke', { size: 'sm', ghost: true, onClick: async () => {
                  if (!(await confirmBox('Revoke key?', `Integrations using "${r.name}" lose access immediately.`, 'Revoke'))) return;
                  await api.post(`/api/v1/api-keys/${r.id}/revoke`); toast.ok('Key revoked'); paintPane();
                } }) : null },
            ], keys) : h('div', { class: 'faint tiny' }, 'No keys yet.'),
            foot: canManageKeys ? h('div', { class: 'row end', style: { width: '100%' } }, btn('Create key', { cls: 'primary', ico: 'plus', onClick: () => keyModal() })) : null,
          });

    function keyModal() {
      const name = h('input', { class: 'input', placeholder: 'e.g. ERP integration' });
      const scopeBoxes = ['read', 'write', 'reports', 'webhooks'].map(sc =>
        h('label', { class: 'row', style: { gap: '6px' } }, h('input', { type: 'checkbox', value: sc, checked: sc === 'read' }), sc));
      const days = h('input', { class: 'input', type: 'number', min: 1, max: 365, placeholder: 'Expiry (days, optional)' });
      const submit = btn('Create key', { cls: 'primary', onClick: async () => {
        const scopes = scopeBoxes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value);
        if (!name.value.trim() || !scopes.length) return toast.err('Missing', 'Name and at least one scope required');
        try {
          const r = await api.post('/api/v1/api-keys', { name: name.value.trim(), scopes, expires_in_days: days.value ? Number(days.value) : undefined });
          document.getElementById('overlays').replaceChildren();
          modal({ title: 'Store this key now', ico: 'key', body: h('div', {},
            h('p', { class: 'faint' }, 'It is never shown again.'),
            h('div', { class: 'mono', style: { wordBreak: 'break-all', padding: '10px', background: 'var(--surface2)', borderRadius: '8px' } }, r.data.key),
            h('div', { class: 'row end' }, btn('Copy', { size: 'sm', onClick: async () => { await navigator.clipboard.writeText(r.data.key); toast.ok('Copied'); } }))) });
          paintPane();
        } catch (e) { toast.err('Create failed', e.message); }
      } });
      modal({ title: 'Create API key', ico: 'key', body: h('div', {}, field('NAME', name), field('SCOPES', h('div', { class: 'stack sm' }, scopeBoxes)), field('EXPIRY (DAYS)', days)), foot: h('div', { class: 'right' }, submit) });
    }

    return h('div', { class: 'stack' },
      keyCard,
      card({
        title: 'Data export & backup', ico: 'download',
        sub: 'Your business data, your property. Exports never include other businesses and never include stored provider secrets.',
        body: h('div', { class: 'row wrap', style: { gap: '10px' } },
          btn('Download data export (JSON)', { ico: 'download', onClick: () => download('/api/v1/settings/export', `tawa-export.json`) }),
          store.can('settings.manage') ? btn('Download backup pack (JSON)', { ghost: true, ico: 'database', onClick: () => download('/api/v1/settings/backup', `tawa-backup.json`) }) : null),
      }),
    );
  }

  /* ---------------- workspace ---------------- */
  async function workspaceView() {
    const t = await api.get('/api/v1/settings/tenant');
    return h('div', { class: 'stack' },
      card({
        title: 'Workspace profile', sub: `Tenant code ${t.code}`,
        body: kv([
          ['Business', t.name],
          ['Legal name', t.legal_name || '—'],
          ['Industry', t.industry || '—'],
          ['Status', t.status],
          ['Currency', t.currency],
          ['Timezone', t.timezone],
          ['Country', t.country || '—'],
          ['Tax regime', t.tax_regime || '—'],
        ]),
      }),
      card({
        title: 'Domains', sub: 'Hostnames that resolve to this workspace (subdomain, storefront, API)',
        body: await domainsList(),
        foot: store.can('settings.manage') ? h('div', { class: 'row end', style: { width: '100%' } }, btn('Add domain', { size: 'sm', ico: 'globe', onClick: domainModal })) : null,
      }));
  }

  async function domainsList() {
    let domains = [];
    try { domains = (await api.get('/api/v1/settings/tenant')).domains || []; } catch { /* below */ }
    return domains.length
      ? h('div', { class: 'stack sm' }, domains.map(d => h('div', { class: 'row between' }, h('span', { class: 'mono' }, d.host), h('span', { class: 'badge-soft' }, `${d.kind} · ${d.verified ? 'verified' : 'pending'}`))))
      : h('div', { class: 'faint tiny' }, 'No custom domains yet — serving on the shared platform host.');
  }

  function domainModal() {
    const host = input({ placeholder: 'pos.alpha-hardware.co.ke' });
    const submit = btn('Claim domain', { cls: 'primary', ico: 'globe' });
    submit.addEventListener('click', async () => {
      try { await api.post('/api/v1/settings/domains', { host: host.value.trim(), kind: 'CUSTOM' }); toast.ok('Domain claimed', 'DNS verification pending'); document.getElementById('overlays').replaceChildren(); paintPane(); }
      catch (e) { presentError(e); }
    });
    modal({ title: 'Add domain', ico: 'globe', width: 'narrow', body: field('HOSTNAME', host, { hint: 'Requests with this Host header resolve straight to your brand.' }), foot: h('div', { class: 'right' }, submit) });
  }

  /* ---------------- users & roles ---------------- */
  async function usersView() {
    const [users, rolesInfo] = await Promise.all([api.get('/api/v1/users'), api.get('/api/v1/roles')]);
    return h('div', { class: 'stack' },
      h('div', { class: 'row end' }, btn('Invite user', { cls: 'primary', ico: 'plus', onClick: () => userModal(rolesInfo) })),
      card({
        title: `Users (${users.length})`, flush: true,
        body: table([
          { label: 'User', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, r.email)) },
          { label: 'Roles', render: r => h('div', { class: 'row wrap', style: { gap: '4px' } }, (r.roles || []).map(x => h('span', { class: 'badge-soft tiny' }, x.replace(/_/g, ' ')))) },
          { label: 'Status', render: r => pill(r.status) },
          { label: 'Last login', render: r => h('span', { class: 'tiny muted' }, r.last_login_at ? fmtDT(r.last_login_at) : 'never') },
          { label: '', align: 'r', width: '1%', render: r => r.id !== store.user?.id ? btn(r.status === 'ACTIVE' ? 'Suspend' : 'Reactivate', { size: 'sm', cls: r.status === 'ACTIVE' ? 'danger' : '', onClick: async () => {
              try {
                await api.patch(`/api/v1/users/${r.id}`, { status: r.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' });
                toast.ok(`${r.name} ${r.status === 'ACTIVE' ? 'suspended — sessions revoked' : 'reactivated'}`);
                paintPane();
              } catch (e) { presentError(e); }
            } }) : h('span', { class: 'tiny faint' }, 'you') },
        ], users),
      }),
      card({
        title: 'Role templates', sub: 'Permissions bundled per role — server-enforced on every request',
        flush: true,
        body: table([
          { label: 'Role', render: r => h('span', { class: 'mono badge-soft' }, r.name) },
          { label: 'Permissions', align: 'r', render: r => h('span', { class: 'num' }, fmtNum((r.permissions || []).length)) },
        ], rolesInfo.roles || []),
      }));
  }

  function userModal(rolesInfo) {
    const name = input({ placeholder: 'Full name' });
    const email = input({ type: 'email', placeholder: 'name@business.co.ke' });
    const pass = input({ type: 'password', placeholder: '12+ chars, mixed' });
    const roleSel = h('select', { class: 'select', multiple: true, style: { height: '120px' } },
      (rolesInfo.templates || rolesInfo.roles.map(r => r.name)).map(r => h('option', { value: r }, r.replace(/_/g, ' '))));
    const submit = btn('Create user', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      const roles = [...roleSel.selectedOptions].map(o => o.value);
      if (!name.value.trim() || !email.value.trim() || !pass.value) return toast.warn('All fields required');
      if (!roles.length) return toast.warn('Pick at least one role');
      try {
        await api.post('/api/v1/users', { name: name.value.trim(), email: email.value.trim(), password: pass.value, roles });
        toast.ok('User created', email.value.trim());
        document.getElementById('overlays').replaceChildren();
        paintPane();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'Invite user', ico: 'user', width: 'narrow',
      body: h('div', {}, field('NAME', name), field('EMAIL', email), field('TEMP PASSWORD', pass), field('ROLES (CTRL/⌘ for multiple)', roleSel)),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  /* ---------------- branding ---------------- */
  async function brandingView() {
    let b;
    try { b = await api.get('/api/v1/settings/branding'); } catch (e) {
      return h('div', { class: 'card' }, h('div', { class: 'card-b' }, emptyState('Branding locked', 'White-label requires STARTER plan or higher.', 'lock', btn('View plans', { cls: 'primary', onClick: () => go('/settings/subscription') }))));
    }
    const fieldsState = {
      business_name: input({ value: b.business_name || '' }),
      tagline: input({ value: b.tagline || '' }),
      logo_monogram: input({ value: b.logo_monogram || '', maxLength: 3 }),
      color_primary: b.color_primary || '#F0A824',
      color_success: b.color_success || '#3DDC84',
      color_warning: b.color_warning || '#FFB020',
      color_error: b.color_error || '#F4503C',
      phone: input({ value: b.phone || '' }),
      email: input({ value: b.email || '' }),
      address: input({ value: b.address || '' }),
      invoice_prefix: input({ value: b.invoice_prefix || 'INV' }),
      receipt_prefix: input({ value: b.receipt_prefix || 'RCP' }),
    };
    const whiteLabel = h('input', { type: 'checkbox', checked: !!b.white_label });
    const docFooter = input({ value: b.doc_footer || '' });

    const colorField = (label, key) => {
      const sw = h('span', { class: 'swatch', style: { background: fieldsState[key] } },
        h('input', { type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(fieldsState[key]) ? fieldsState[key] : '#F0A824', onInput: (e) => { fieldsState[key] = e.target.value; sw.style.background = e.target.value; hexIn.value = e.target.value.toUpperCase(); paintPreview(); paintMeter(); } }));
      const hexIn = input({ value: fieldsState[key], class: 'input mono', style: { width: '110px', height: '42px', textTransform: 'uppercase' }, onInput: (e) => { const v = e.target.value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(v)) { fieldsState[key] = v; sw.style.background = v; paintPreview(); paintMeter(); } } });
      return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'swatch-row' }, sw, hexIn));
    };

    const meterEl = h('div', {});
    const previewEl = h('div', {});

    function paintPreview() {
      const c = fieldsState.color_primary;
      previewEl.replaceChildren(h('div', { class: 'preview-frame' },
        h('div', { class: 'preview-bar' }, h('span', { class: 'pb-dot' }), h('span', { class: 'pb-dot' }), h('span', { class: 'pb-dot' }), h('span', { class: 'tiny faint', style: { marginLeft: '8px' } }, 'live white-label preview')),
        h('div', { class: 'preview-body' },
          h('div', { class: 'row' },
            h('span', { class: 'brand-mark', style: { background: c } }, (fieldsState.logo_monogram.value || 'T').slice(0, 2).toUpperCase()),
            h('div', {}, h('div', { class: 'brand-name' }, fieldsState.business_name.value || 'Your Business'), h('div', { class: 'brand-tag' }, fieldsState.tagline.value || 'Tagline'))),
          h('div', { class: 'row wrap' },
            h('span', { class: 'pill brand', style: { '--brand': c, '--brand-soft': `${c}21`, '--brand-line': `${c}61` } }, h('span', { class: 'pdot' }), 'BRAND PILL'),
            h('button', { class: 'btn primary', style: { '--brand': c, '--brand-ink': contrastRatio('#141312', c) >= contrastRatio('#F5F7FA', c) ? '#141312' : '#F5F7FA' } }, 'Primary action'),
            h('span', { class: 'pill ok' }, h('span', { class: 'pdot' }), 'PAID')))));
    }
    function paintMeter() {
      const c = fieldsState.color_primary;
      const vsBg = contrastRatio(c, '#0C0F13');
      const vsSurface = contrastRatio(c, '#12161D');
      const ratio = Math.min(vsBg, vsSurface);
      const segs = [0, 1, 2, 3, 4].map(i => {
        const on = ratio >= 2.2 + i * 0.6;
        return h('span', { class: `cm-seg${on ? ' on' : ''}${ratio < 3 ? ' warn' : ''}${ratio < 2.2 ? ' bad' : ''}` });
      });
      meterEl.replaceChildren(
        h('div', { class: 'row between' }, h('span', { class: 'tiny muted' }, 'Primary vs surfaces contrast'), h('span', { class: 'mono tiny strong', style: { color: ratio < 2.2 ? 'var(--danger)' : ratio < 3 ? 'var(--warn)' : 'var(--ok)' } }, ratio.toFixed(2))),
        h('div', { class: 'contrast-meter' }, segs),
        ratio < 3 ? h('div', { class: 'tiny', style: { color: ratio < 2.2 ? 'var(--danger)' : 'var(--warn)' } },
          ratio < 2.2 ? 'Below the WCAG accessibility floor — the server will REJECT this theme (422).' : 'Below recommended contrast (3.0) — the server will save with warnings.') : null);
    }
    paintPreview(); paintMeter();

    const saveBtn = btn('Save branding', { cls: 'primary', ico: 'approve' });
    saveBtn.addEventListener('click', async () => {
      try {
        const res = await api.put('/api/v1/settings/branding', {
          business_name: fieldsState.business_name.value.trim() || undefined,
          tagline: fieldsState.tagline.value.trim() || undefined,
          logo_monogram: fieldsState.logo_monogram.value.trim().toUpperCase() || undefined,
          color_primary: fieldsState.color_primary,
          color_success: fieldsState.color_success,
          color_warning: fieldsState.color_warning,
          color_error: fieldsState.color_error,
          phone: fieldsState.phone.value.trim() || undefined,
          email: fieldsState.email.value.trim() || undefined,
          address: fieldsState.address.value.trim() || undefined,
          invoice_prefix: fieldsState.invoice_prefix.value.trim() || undefined,
          receipt_prefix: fieldsState.receipt_prefix.value.trim() || undefined,
          doc_footer: docFooter.value.trim() || undefined,
          white_label: whiteLabel.checked,
        });
        if (res.warnings?.length) res.warnings.forEach(w => toast.warn('Contrast warning', w));
        toast.ok('Branding saved', 'Applied to this workspace immediately.');
        const fresh = await api.get('/api/v1/brand', { code: store.tenant?.code });
        applyBrand(fresh);
        shellRefreshBrand();
      } catch (e) { presentError(e, 'Theme rejected'); }
    });

    return h('div', { class: 'grid c32' },
      h('div', { class: 'stack' },
        card({
          title: 'Identity', body: h('div', {},
            field('BUSINESS NAME', fieldsState.business_name),
            field('TAGLINE', fieldsState.tagline),
            field('LOGO MONOGRAM (1–3 CHARS)', fieldsState.logo_monogram),
            h('div', { class: 'form-row' }, field('PUBLIC PHONE', fieldsState.phone), field('PUBLIC EMAIL', fieldsState.email)),
            field('ADDRESS (ON DOCUMENTS)', fieldsState.address)),
        }),
        card({
          title: 'Documents', body: h('div', {},
            h('div', { class: 'form-row' }, field('INVOICE PREFIX', fieldsState.invoice_prefix), field('RECEIPT PREFIX', fieldsState.receipt_prefix)),
            field('FOOTER NOTE', fieldsState.doc_footer === undefined ? docFooter : docFooter)),
        })),
      h('div', { class: 'stack' },
        card({ title: 'Brand colors', body: h('div', {},
          colorField('PRIMARY — buttons, accents', 'color_primary'),
          h('div', { class: 'form-row' },
            colorField('SUCCESS', 'color_success'), colorField('WARNING', 'color_warning')),
          colorField('ERROR', 'color_error'),
          h('hr', { class: 'divider' }), meterEl) }),
        card({ title: 'Preview', body: previewEl }),
        card({
          title: 'White-label mode',
          body: h('div', { class: 'stack sm' },
            h('label', { class: 'checkbox' }, whiteLabel, 'Hide TAWA branding on customer surfaces (documents, receipts)'),
            h('p', { class: 'tiny faint', style: { margin: 0 } }, 'Theme changes apply instantly to the workspace UI, invoices, receipts, quotes and delivery notes.')),
          foot: h('div', { class: 'row end', style: { width: '100%' } }, saveBtn),
        })));
  }

  function shellRefreshBrand() {
    const lk = document.querySelector('.brand-lockup');
    if (lk && store.brand?.branding) {
      const nameEl = lk.querySelector('.brand-name');
      const markEl = lk.querySelector('.brand-mark');
      if (nameEl) nameEl.textContent = store.brand.branding.business_name || store.tenant?.name || '';
      if (markEl) markEl.textContent = (store.brand.branding.logo_monogram || 'T').slice(0, 2).toUpperCase();
    }
  }

  /* ---------------- flags ---------------- */
  async function flagsView() {
    const flags = await api.get('/api/v1/settings/flags');
    return card({
      title: 'Feature flags', sub: 'Workspace-level switches (server still enforces entitlements regardless)',
      flush: true,
      body: table([
        { label: 'Flag', render: r => h('span', { class: 'mono badge-soft' }, r.flag) },
        { label: 'State', render: r => pill(r.enabled ? 'ENABLED' : 'DISABLED') },
        { label: '', align: 'r', width: '1%', render: r => (() => {
            const sw = h('span', { class: `switch${r.enabled ? ' on' : ''}`, onClick: async () => {
              try { await api.put('/api/v1/settings/flags', { flags: { [r.flag]: !r.enabled } }); paintPane(); } catch (e) { presentError(e); }
            } });
            return sw;
          })() },
      ], flags, { emptyTitle: 'No flags', ico: 'flag' }),
    });
  }

  /* ---------------- subscription ---------------- */
  async function subscriptionView() {
    const [sub, matrix] = await Promise.all([api.get('/api/v1/billing/subscription'), api.get('/api/v1/billing/matrix')]);
    const plans = matrix.plans || [];
    const usage = store.me?.usage || [];
    return h('div', { class: 'stack' },
      card({
        title: 'Current plan', sub: sub.license ? `License ${sub.license.state} · expires ${fmtDate(sub.license.expires_at)}` : '',
        body: h('div', { class: 'row wrap', style: { alignItems: 'center' } },
          h('span', { class: 'pill brand', style: { height: '26px', fontSize: '12px' } }, h('span', { class: 'pdot' }), sub.plan),
          h('span', { class: 'tiny muted' }, `Renews ${fmtDate(sub.subscription?.renews_at)}`),
          h('span', { class: 'tiny muted' }, `· Trial ends ${fmtDate(sub.subscription?.trial_ends_at)}`),
          store.can('billing.manage') ? h('div', { class: 'row', style: { marginLeft: 'auto', gap: '6px' } },
            plans.filter(p => p !== sub.plan).map(p => btn(p, { size: 'sm', onClick: async () => {
              const okC = await confirmBox({ title: `Change plan to ${p}?`, message: 'Entitlements recompute immediately. Downgrades never delete data — over-limit usage is flagged, not erased.', confirmLabel: `Switch to ${p}` });
              if (!okC) return;
              try {
                const res = await api.post('/api/v1/billing/change-plan', { plan_id: p });
                (res.warnings || []).forEach(w => toast.warn('Downgrade notice', w));
                toast.ok(`Plan changed to ${p}`, 'Server restarted enforcement with the new matrix.');
                store.me = await api.get('/api/v1/auth/me');
                paintPane();
              } catch (e) { presentError(e); }
            } }))) : null),
      }),
      usage.length ? card({
        title: 'Usage this period', flush: true,
        body: table([
          { label: 'Metric', render: r => h('span', { class: 'mono badge-soft' }, r.metric || r.key) },
          { label: 'Count', align: 'r', render: r => h('span', { class: 'num strong' }, fmtNum(r.count ?? r.value ?? 0)) },
        ], usage),
      }) : null,
      card({
        title: 'Entitlement matrix', sub: 'What each plan unlocks — enforced server-side with 402 gates',
        flush: true,
        body: h('div', { class: 'matrix-wrap' }, (() => {
          const ents = matrix.entitlements || [];
          const modules = [...new Set(ents.map(e => e.module))];
          return h('table', { class: 'matrix' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Entitlement'), plans.map(p => h('th', { style: p === sub.plan ? { color: 'var(--brand)' } : null }, p)))),
            h('tbody', {}, modules.flatMap(m => [
              h('tr', { class: 'm-cat' }, h('td', { colSpan: plans.length + 1 }, m || 'General')),
              ...ents.filter(e => e.module === m).map(e => h('tr', { class: e.grants?.[sub.plan] ? 'hl' : '' },
                h('td', {}, h('div', {}, h('div', { class: 'strong', style: { fontSize: '12px' } }, e.label), h('div', { class: 'tiny faint mono' }, e.code))),
                plans.map(p => h('td', { class: e.grants?.[p] ? 'yes' : 'no' }, e.grants?.[p] ? '✓' : '—')))),
            ])));
        })()),
      }));
  }

  /* ---------------- integrations ---------------- */
  async function integrationsView() {
    const ig = await api.get('/api/v1/integrations');
    const grp = (title, list) => card({
      title, flush: true,
      body: table([
        { label: 'Provider', render: r => h('div', {}, h('div', { class: 't-main' }, r.label || r.name), h('div', { class: 't-sub mono' }, r.code)) },
        { label: 'Environment', render: r => r.environment === 'sandbox' ? h('span', { class: 'sandbox-tag' }, 'SANDBOX') : h('span', { class: 'badge-soft' }, r.environment || 'production-capable') },
        { label: 'Methods', render: r => h('span', { class: 'tiny mono' }, (r.methods || [r.kind]).filter(Boolean).join(' · ')) },
        { label: 'Status', render: r => pill(r.status || 'ONLINE') },
      ], list),
    });
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('info', 15),
        h('span', {}, 'Honesty bar: M-Pesa/Card/SMS adapters here are clearly-marked SANDBOX implementations behind the production provider interface — swap in Daraja/Twilio credentials at deploy time without code changes.')),
      grp('Payments', ig.payments || []),
      grp('Messaging', ig.messaging || []));
  }

  /* ---------------- audit ---------------- */
  async function auditView() {
    const rows = await api.get('/api/v1/audit');
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('shield-check', 15), h('span', {}, 'Append-only. UPDATE and DELETE are rejected by database triggers. IPs and actors recorded with every action.')),
      card({
        title: `Audit trail (${rows.length} latest)`, flush: true,
        body: table([
          { label: 'When', render: r => h('span', { class: 'tiny muted mono' }, fmtDT(r.created_at)) },
          { label: 'Actor', render: r => h('span', { class: 'tiny' }, r.actor_name || 'system') },
          { label: 'Action', render: r => h('span', { class: 'mono badge-soft tiny' }, r.action) },
          { label: 'Resource', render: r => h('span', { class: 'tiny mono muted' }, r.resource ? `${r.resource}${r.resource_id ? ' ' + String(r.resource_id).slice(0, 12) + '…' : ''}` : '—') },
          { label: 'Result', render: r => pill(r.result === 'SUCCESS' ? 'ok' : 'danger', { raw: true }) },
          { label: 'IP', render: r => h('span', { class: 'tiny mono faint' }, r.ip || '—') },
        ], rows, { emptyTitle: 'No audit events', ico: 'history' }),
      }));
  }

  el.replaceChildren(pageHead('Settings', 'Workspace control centre'), h('div', { class: 'settings-grid' }, nav, pane));
  paintNav();
  await paintPane();
}
