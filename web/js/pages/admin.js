/** Platform Control Plane — JATA Qi admin: tenants, status, integrity, usage. Row-level isolation applies to tenants, not here. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, modal, field, input, select, tabs, kv, iconEl, confirmBox } from '../ui.js';

export async function render(el) {
  const state = { tab: 'overview' };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function load() {
    if (state.tab === 'overview') return api.get('/api/v1/admin/overview');
    if (state.tab === 'tenants') return api.get('/api/v1/admin/tenants');
    if (state.tab === 'audit') return api.get('/api/v1/admin/audit');
    if (state.tab === 'integrity') return api.get('/api/v1/admin/integrity');
    if (state.tab === 'usage') return api.get('/api/v1/admin/usage');
  }

  async function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'overview', label: 'Overview' },
      { id: 'tenants', label: 'Tenants' },
      { id: 'usage', label: 'Usage & metering' },
      { id: 'integrity', label: 'Platform integrity' },
      { id: 'audit', label: 'Global audit' },
    ], state.tab, (t) => { state.tab = t; paint(); }));
    bodyEl.replaceChildren(h('div', { class: 'skel', style: { height: '300px', borderRadius: '12px' } }));
    let data;
    try { data = await load(); } catch (e) { presentError(e); return; }
    bodyEl.replaceChildren(view(data));
  }

  function view(data) {
    if (state.tab === 'overview') return overviewView(data);
    if (state.tab === 'tenants') return tenantsView(data);
    if (state.tab === 'usage') return usageView(data);
    if (state.tab === 'integrity') return integrityView(data);
    return auditView(data);
  }

  function overviewView(d) {
    const stats = [
      ['Tenants', d.tenants, 'branches', `${d.active_tenants} active`],
      ['Platform users', d.users, 'user', ''],
      ['Orders today', fmtNum(d.orders_today), 'orders', ''],
      ['GMV today', fmtMoney(d.payments_today), 'payments', 'INBOUND settled'],
      ['Events (bus)', fmtNum(d.events), 'automation', ''],
      ['AI requests', fmtNum(d.ai_requests_month), 'ai', 'metered'],
      ['Messages sent', fmtNum(d.messages_month), 'sms', 'sandbox metered'],
    ];
    return h('div', { class: 'stack' },
      h('div', { class: 'grid c4' }, stats.map(([l, v, i, f]) =>
        h('div', { class: 'card kpi brand-strip' }, h('div', { class: 'k-label' }, iconEl(i, 13), l), h('div', { class: 'k-value num', style: { fontSize: 'var(--fs-22)' } }, String(v)), f ? h('div', { class: 'k-foot tiny' }, f) : null))),
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('admin', 15),
        h('span', {}, 'This plane is empty of tenant business data by design: aggregate counts and statuses only. Tenant rows live behind server-derived tenant scoping.')));
  }

  function tenantsView(rows) {
    return h('div', { class: 'stack' },
      h('div', { class: 'row end' }, btn('Provision tenant', { cls: 'primary', ico: 'plus', onClick: provisionModal })),
      card({
        title: 'Tenant registry', flush: true,
        body: table([
          { label: 'Tenant', render: r => {
              const b = r.business_name || r.name;
              return h('div', { class: 'row', style: { gap: '10px' } },
                h('span', { class: 'brand-mark', style: { width: '28px', height: '28px', fontSize: '11px', background: 'var(--surface-3)', color: 'var(--text)' } }, (r.code || '?').slice(0, 2).toUpperCase()),
                h('div', {}, h('div', { class: 't-main' }, b), h('div', { class: 't-sub mono' }, r.code)));
            } },
          { label: 'Plan', render: r => h('span', { class: 'pill brand' }, h('span', { class: 'pdot' }), r.plan_id || '—') },
          { label: 'Status', render: r => pill(r.status === 'SUSPENDED' ? 'danger' : r.status === 'RESTRICTED' ? 'warn' : 'ok', { raw: true }) },
          { label: 'Users', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum(r.users)) },
          { label: 'Orders', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum(r.orders)) },
          { label: 'Products', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum(r.products)) },
          { label: 'Subscription', render: r => h('span', { class: 'tiny muted' }, r.subscription_status || '—') },
          { label: 'Created', render: r => h('span', { class: 'tiny muted' }, fmtDate(r.created_at)) },
          { label: '', align: 'r', width: '1%', render: r => h('div', { class: 'row end', style: { gap: '6px' } },
            r.status === 'ACTIVE' ? btn('Suspend', { size: 'sm', cls: 'danger', onClick: () => setStatus(r, 'SUSPENDED', 'Suspending cuts ALL writes immediately (reads still allowed). Data is preserved.') }) : null,
            r.status === 'SUSPENDED' ? btn('Restore', { size: 'sm', cls: 'primary', onClick: () => setStatus(r, 'ACTIVE', 'Restoring re-enables full access.') }) : null,
            r.status === 'ACTIVE' ? btn('Restrict', { size: 'sm', onClick: () => setStatus(r, 'RESTRICTED', 'Restricted = read-only mode for the tenant.') }) : null,
            r.status === 'RESTRICTED' ? btn('Restore', { size: 'sm', cls: 'primary', onClick: () => setStatus(r, 'ACTIVE', 'Restoring re-enables full access.') }) : null,
            btn('Plan', { size: 'sm', ghost: true, ico: 'shield', onClick: () => planModal(r) })) },
        ], rows),
      }));

    async function setStatus(r, to, message) {
      const okC = await confirmBox({ title: `${to === 'SUSPENDED' ? 'Suspend' : to === 'RESTRICTED' ? 'Restrict' : 'Restore'} ${r.business_name || r.name}?`, message, confirmLabel: to === 'ACTIVE' ? 'Restore' : to === 'SUSPENDED' ? 'Suspend' : 'Restrict', danger: to !== 'ACTIVE' });
      if (!okC) return;
      try {
        await api.post(`/api/v1/admin/tenants/${r.id}/status`, { status: to, reason: 'operator action from control plane' });
        toast.ok(`${r.code} → ${to}`);
        paint();
      } catch (e) { presentError(e); }
    }

    function planModal(r) {
      const sel = select(['FREE', 'STARTER', 'BUSINESS', 'PROFESSIONAL', 'ENTERPRISE']);
      sel.value = r.plan_id || 'FREE';
      const submit = btn('Change plan', { cls: 'primary', onClick: async () => {
        try {
          await api.post(`/api/v1/admin/tenants/${r.id}/plan`, { plan_id: sel.value });
          document.getElementById('overlays').replaceChildren();
          toast.ok('Plan changed', `${r.code}: ${r.plan_id} → ${sel.value}. Entitlements re-evaluate on the next request.`);
          paint();
        } catch (e) { presentError(e); }
      } });
      modal({ title: `Change plan — ${r.business_name || r.name}`, sub: 'Immediate effect; usage limits and feature gates follow the new plan.', ico: 'shield', width: 'narrow',
        body: field('PLAN', sel), foot: h('div', { class: 'right' }, submit) });
    }

    function provisionModal() {
      const code = input({ placeholder: 'kama-hardware' });
      const name = input({ placeholder: 'Kama Hardware Ltd' });
      const plan = select(['FREE', 'STARTER', 'PROFESSIONAL', 'BUSINESS', 'ENTERPRISE']);
      void 0;

      const ownerName = input({ placeholder: 'Owner full name' });
      const ownerEmail = input({ type: 'email', placeholder: 'owner@business.co.ke' });
      const ownerPass = input({ type: 'password', placeholder: 'Strong temp password' });
      const submit = btn('Provision workspace', { cls: 'primary', ico: 'plus' });
      submit.addEventListener('click', async () => {
        for (const [v, m] of [[code.value, 'code'], [name.value, 'name'], [ownerName.value, 'owner name'], [ownerEmail.value, 'owner email'], [ownerPass.value, 'password']]) if (!v.trim()) return toast.warn(`Missing ${m}`);
        try {
          const res = await api.post('/api/v1/admin/tenants', { code: code.value.trim(), name: name.value.trim(), plan_id: plan.value, owner_name: ownerName.value.trim(), owner_email: ownerEmail.value.trim(), owner_password: ownerPass.value });
          toast.ok('Tenant provisioned', `${res.tenant?.name || name.value} · ${plan.value} — ledger, roles, admin user, defaults all seeded.`);
          document.getElementById('overlays').replaceChildren();
          paint();
        } catch (e) { presentError(e, 'Provision failed'); }
      });
      modal({
        title: 'Provision tenant', sub: 'Single atomic operation — all baseline structures created', ico: 'plus', width: 'narrow',
        body: h('div', {},
          h('div', { class: 'form-row' }, field('TENANT CODE', code), field('PLAN', plan)),
          field('BUSINESS NAME', name),
          h('hr', { class: 'divider' }),
          field('OWNER NAME', ownerName), field('OWNER EMAIL', ownerEmail), field('OWNER PASSWORD', ownerPass)),
        foot: h('div', { class: 'right' }, submit),
      });
    }
  }

  function usageView(rows) {
    const list = Array.isArray(rows) ? rows : (rows.usage || []);
    return card({
      title: 'Usage counters', sub: 'Per-tenant metering subscriptions are billed against',
      flush: true,
      body: table([
        { label: 'Tenant', render: r => h('span', { class: 'mono tiny' }, r.tenant_code || r.tenant_id?.slice(0, 12) || '—') },
        { label: 'Meter', render: r => h('span', { class: 'badge-soft mono' }, r.meter) },
        { label: 'Period', render: r => h('span', { class: 'tiny muted mono' }, r.period || '—') },
        { label: 'Count', align: 'r', render: r => h('span', { class: 'num strong' }, fmtNum(r.count)) },
      ], list, { emptyTitle: 'No usage yet', ico: 'analytics' }),
    });
  }

  function integrityView(d) {
    const rows = [];
    if (d?.ledgers) for (const l of d.ledgers) rows.push({ tenant: l.tenant || l.tenant_id, check: 'Ledger balanced', ok: l.ok, detail: l.ok ? 'ΣDr = ΣCr' : `${(l.issues || []).length} issues` });
    if (d?.tenants) rows.push({ tenant: 'platform', check: 'Tenants', ok: true, detail: `${d.tenants} registered` });
    if (!rows.length) rows.push({ tenant: 'platform', check: 'Integrity snapshot', ok: true, detail: JSON.stringify(d).slice(0, 120) });
    return card({
      title: 'Integrity sweep', flush: true,
      body: table([
        { label: 'Scope', render: r => h('span', { class: 'mono tiny' }, r.tenant) },
        { label: 'Check', key: 'check' },
        { label: 'Detail', render: r => h('span', { class: 'tiny muted' }, r.detail) },
        { label: 'Result', align: 'r', render: r => pill(r.ok ? 'ok' : 'danger', { raw: true }) },
      ], rows),
    });
  }

  function auditView(rows) {
    return card({
      title: 'Global audit (latest 300)', flush: true,
      body: table([
        { label: 'When', render: r => h('span', { class: 'tiny muted mono' }, fmtDT(r.created_at)) },
        { label: 'Tenant', render: r => h('span', { class: 'tiny mono' }, r.tenant_id ? r.tenant_id.slice(0, 14) + '…' : 'platform') },
        { label: 'Actor', render: r => h('span', { class: 'tiny' }, r.actor_name || 'system') },
        { label: 'Action', render: r => h('span', { class: 'mono badge-soft tiny' }, r.action) },
        { label: 'Result', render: r => pill(r.result === 'SUCCESS' ? 'ok' : 'danger', { raw: true }) },
      ], Array.isArray(rows) ? rows : [], { emptyTitle: 'No events', ico: 'history' }),
    });
  }

  el.replaceChildren(pageHead('Platform Control', 'JATA Qi operator plane — isolation enforced below'), tabBar, bodyEl);
  await paint();
}
