/** Customers — CRM with segments, lifetime value, credit & loyalty. */
import { api, downloadFile } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, barList, iconEl } from '../ui.js';

export async function render(el, ctx) {
  let rows = [];
  const searchEl = input({ placeholder: 'Search name, phone, code…' });
  const bodyEl = h('div', {});
  const filterEl = select([
    { value: '', label: 'All segments' }, { value: 'RETAIL', label: 'Retail' }, { value: 'CONTRACTOR', label: 'Contractors' },
    { value: 'WHOLESALE', label: 'Wholesale' }, { value: 'CORPORATE', label: 'Corporate' },
  ]);
  filterEl.addEventListener('change', load);
  searchEl.addEventListener('input', () => paint());

  async function load() {
    try {
      rows = await api.get('/api/v1/customers', { segment: filterEl.value || undefined, limit: 200 });
      paint();
    } catch (e) { presentError(e, 'Customers failed to load'); }
  }
  function paint() {
    const q = searchEl.value.trim().toLowerCase();
    const list = q ? rows.filter(c => (c.name + (c.phone || '') + (c.code || '')).toLowerCase().includes(q)) : rows;
    bodyEl.replaceChildren(table([
      { label: 'Customer', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, `${r.code} · ${r.phone || 'no phone'}`)) },
      { label: 'Type', render: r => h('span', { class: 'badge-soft' }, r.type) },
      { label: 'Loyalty', render: r => r.loyalty_tier ? h('span', { class: `pill ${r.loyalty_tier === 'PLATINUM' ? 'brand' : r.loyalty_tier === 'GOLD' ? 'warn' : 'neutral'}` }, h('span', { class: 'pdot' }), `${r.loyalty_tier} · ${fmtNum(r.loyalty_points)}`) : h('span', { class: 'faint tiny' }, '—') },
      { label: 'Orders', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum(r.orders_count ?? 0)) },
      { label: 'Lifetime value', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.lifetime_value ?? 0)) },
      { label: 'Credit', align: 'r', render: r => r.credit_limit ? h('span', { class: 'num tiny' }, `${fmtMoney(r.credit_balance ?? 0)} / ${fmtMoney(r.credit_limit)}`) : h('span', { class: 'faint tiny' }, 'no account') },
      { label: 'Last order', render: r => h('span', { class: 'tiny muted' }, r.last_order_at ? fmtDate(r.last_order_at) : '—') },
    ], list, { onRow: openCustomer, emptyTitle: 'No customers', emptyMsg: 'Add walk-in customers here or convert broker leads.', ico: 'customers' }));
  }

  async function openCustomer(c) {
    let full = c;
    try { full = await api.get(`/api/v1/customers/${c.id}`); } catch { /* fall back to row */ }
    const orders = full.orders || [];
    const bodyEl = h('div', { class: 'stack' },
      h('div', { class: 'row between wrap' },
        h('div', {},
          h('div', { class: 'strong', style: { fontSize: 'var(--fs-18)' } }, full.name),
          h('div', { class: 'tiny muted mono' }, `${full.code} · ${full.phone || '—'} ${full.email ? '· ' + full.email : ''}`)),
        h('div', { class: 'row' }, h('span', { class: 'badge-soft' }, full.type), full.loyalty_tier ? h('span', { class: 'pill brand' }, h('span', { class: 'pdot' }), full.loyalty_tier) : null)),
      card({ title: 'Snapshot', body: kv([
        ['Lifetime value', fmtMoney(full.lifetime_value ?? 0)],
        ['Orders', fmtNum(full.orders_count ?? 0)],
        ['Outstanding credit', fmtMoney(full.credit?.balance ?? full.credit_balance ?? 0)],
        ['Credit limit', (full.credit?.limit_amount ?? full.credit_limit) ? fmtMoney(full.credit?.limit_amount ?? full.credit_limit) : 'No credit account'],
        ['Last order', full.last_order_at ? fmtDT(full.last_order_at) : 'Never'],
        ['Marketing opt-in', full.marketing_opt_in ? 'Yes' : 'No'],
        ['Address', full.address || '—'],
      ]) }),
      store.can('credit.grant') && store.has('TAWA.CREDIT') ? h('div', { class: 'row' },
        btn((full.credit?.limit_amount || full.credit_limit) ? 'Adjust credit' : 'Grant credit', { cls: 'sm', ico: 'credit', onClick: () => creditModal(full) })) : null,
      orders.length ? card({
        title: 'Recent orders', flush: true,
        body: table([
          { label: 'Order', render: r => h('span', { class: 'mono tiny' }, r.number) },
          { label: 'Date', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
          { label: 'Total', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.total)) },
          { label: 'Status', render: r => pill(r.status) },
        ], orders),
      }) : null,
    );
    drawer({ title: 'Customer', sub: full.segment || full.type, ico: 'customers', body: bodyEl });
  }

  function creditModal(c) {
    const limit = input({ type: 'number', step: '0.01', min: '0', value: (((c.credit?.limit_amount ?? c.credit_limit) ?? 5000000) / 100).toFixed(2) });
    const submit = btn('Save credit account', { cls: 'primary', ico: 'credit' });
    submit.addEventListener('click', async () => {
      try {
        await api.post('/api/v1/credit/accounts', { customer_id: c.id, limit: +limit.value });
        toast.ok('Credit account saved', c.name);
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e, 'Credit save failed'); }
    });
    modal({
      title: `Credit — ${c.name}`, ico: 'credit', width: 'narrow',
      body: h('div', {},
        field('CREDIT LIMIT (KES)', limit, { hint: 'Hard cap. The credit engine blocks orders beyond available limit (server-enforced).' }),
        h('p', { class: 'tiny faint' }, 'Granting credit is audited; repayments release capacity immediately.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  function newCustomer() {
    const name = input({ placeholder: 'Full name / company' });
    const phone = input({ placeholder: '+254 7…' });
    const email = input({ placeholder: 'optional' });
    const type = select(['RETAIL', 'CONTRACTOR', 'WHOLESALE', 'CORPORATE']);
    const address = input({ placeholder: 'Delivery address / town' });
    const opt = h('input', { type: 'checkbox' });
    const submit = btn('Create customer', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim()) return toast.warn('Name required');
      try {
        await api.post('/api/v1/customers', { name: name.value.trim(), phone: phone.value || undefined, email: email.value || undefined, type: type.value, address: address.value || undefined, marketing_opt_in: opt.checked });
        toast.ok('Customer created', name.value.trim());
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e, 'Create failed'); }
    });
    modal({
      title: 'New customer', ico: 'customers', width: 'narrow',
      body: h('div', {},
        field('NAME', name), field('PHONE', phone), field('EMAIL', email),
        h('div', { class: 'form-row' }, field('TYPE', type), field('ADDRESS', address)),
        h('label', { class: 'checkbox' }, opt, 'Allow marketing messages (consent gate for campaigns)')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(
    pageHead('Customers', `${rows.length} relationships`,
      btn('Export segment CSV', { ico: 'download', onClick: async () => {
        try { await downloadFile(`/api/v1/customers/segment/${filterEl.value || 'ALL'}/export`, `customers-${(filterEl.value || 'ALL').toLowerCase()}.csv`); }
        catch (e) { presentError(e, 'Export failed'); }
      } }),
      store.can('customers.manage') ? btn('New customer', { cls: 'primary', ico: 'plus', onClick: newCustomer }) : null),
    h('div', { class: 'row wrap', style: { gap: '10px' } }, h('div', { class: 'input-group', style: { maxWidth: '280px', flex: '1' } }, h('span', { class: 'ig-ico' }, iconEl('search', 15)), searchEl), filterEl),
    h('div', { class: 'card' }, bodyEl));
  await load();

  const id = new URLSearchParams((ctx.hash.split('?')[1] || '')).get('id');
  if (id) openCustomer({ id });
}