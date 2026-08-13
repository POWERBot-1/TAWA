/** Suppliers — directory with performance scores, POs, invoices. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, iconEl, debounce } from '../ui.js';

export async function render(el, ctx) {
  let rows = [];
  const searchEl = input({ placeholder: 'Search suppliers…' });
  searchEl.addEventListener('input', () => paint());
  const bodyEl = h('div', {});

  async function load() {
    try { rows = await api.get('/api/v1/suppliers'); paint(); } catch (e) { presentError(e); }
  }
  function scoreBadge(s) {
    const pct = Math.round((s ?? 0) * 100);
    const tone = pct >= 85 ? 'var(--ok)' : pct >= 65 ? 'var(--warn)' : 'var(--danger)';
    return h('span', { class: 'num strong', style: { color: tone } }, `${pct}`);
  }
  function paint() {
    const q = searchEl.value.trim().toLowerCase();
    const list = q ? rows.filter(s => (s.name + (s.contact_name || '')).toLowerCase().includes(q)) : rows;
    bodyEl.replaceChildren(table([
      { label: 'Supplier', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, `${r.code} · ${r.contact_name || '—'}`)) },
      { label: 'Phone', render: r => h('span', { class: 'tiny mono' }, r.phone || '—') },
      { label: 'Terms', render: r => h('span', { class: 'badge-soft' }, r.payment_terms) },
      { label: 'Lead time', align: 'c', render: r => h('span', { class: 'mono tiny' }, `${r.lead_time_days}d`) },
      { label: 'Reliability', align: 'r', render: r => scoreBadge(r.reliability) },
      { label: 'Products', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum(r.products_count)) },
      { label: 'POs', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum(r.orders_count)) },
      { label: 'Outstanding', align: 'r', render: r => h('span', { class: 'num', style: r.outstanding > 0 ? { color: 'var(--warn)' } : null }, fmtMoney(r.outstanding)) },
    ], list, { onRow: openSupplier, emptyTitle: 'No suppliers', ico: 'suppliers' }));
  }

  async function openSupplier(s) {
    let full;
    try { full = await api.get(`/api/v1/suppliers/${s.id}`); } catch (e) { return presentError(e); }
    const sc = full.score || {};
    drawer({
      title: full.name, sub: `${full.code} · ${full.payment_terms} · lead ${full.lead_time_days}d`, ico: 'suppliers',
      body: h('div', { class: 'stack' },
        card({
          title: 'Performance score', sub: 'Derived from real receipts and invoices',
          body: h('div', { class: 'stack sm' },
            ...[['Reliability', full.reliability], ['Quality', full.quality], ['Fulfilment', full.fulfilment_rate], ['On-time', full.on_time_rate]].map(([label, v]) =>
              h('div', { class: 'bar-row' },
                h('div', { class: 'b-label' }, label),
                h('div', { class: 'b-val num' }, `${Math.round((v ?? 0) * 100)}%`),
                h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${Math.round((v ?? 0) * 100)}%` } })))),
            sc.overall != null ? h('div', { class: 'row between' }, h('span', { class: 'muted tiny' }, 'OVERALL'), h('span', { class: 'num strong', style: { fontSize: 'var(--fs-18)' } }, `${Math.round(sc.overall * 100)} / 100`)) : null),
        }),
        full.products?.length ? card({
          title: `Supplied products (${full.products.length})`, flush: true,
          body: table([
            { label: 'SKU', render: r => h('span', { class: 'mono tiny' }, r.sku) },
            { label: 'Name', render: r => h('span', {}, r.name) },
            { label: 'Cost', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.cost_price)) },
          ], full.products),
        }) : null,
        full.purchase_orders?.length ? card({
          title: 'Recent purchase orders', flush: true,
          body: table([
            { label: 'PO', render: r => h('span', { class: 'mono tiny' }, r.number) },
            { label: 'Date', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
            { label: 'Total', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.total)) },
            { label: 'Status', render: r => pill(r.status) },
          ], full.purchase_orders),
        }) : null,
        full.invoices?.length ? card({
          title: 'Invoices', flush: true,
          body: table([
            { label: 'No.', render: r => h('span', { class: 'mono tiny' }, r.number) },
            { label: 'Due', render: r => h('span', { class: 'tiny' }, r.due_at ? fmtDate(r.due_at) : '—') },
            { label: 'Amount', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.amount)) },
            { label: 'Balance', align: 'r', render: r => h('span', { class: 'num', style: r.amount - r.paid > 0 ? { color: 'var(--warn)' } : null }, fmtMoney(r.amount - (r.paid || 0))) },
            { label: 'Status', render: r => pill(r.status) },
          ], full.invoices),
        }) : null),
    });
  }

  function newSupplier() {
    const name = input({ placeholder: 'Company name' });
    const contact = input({ placeholder: 'Contact person' });
    const phone = input({ placeholder: '+254…' });
    const email = input({ placeholder: 'sales@supplier.co.ke' });
    const terms = select(['NET14', 'NET30', 'NET60', 'COD', 'PREPAID']);
    const lead = input({ type: 'number', min: '0', value: '3' });
    const submit = btn('Add supplier', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim()) return toast.warn('Name required');
      try {
        await api.post('/api/v1/suppliers', { name: name.value.trim(), contact_name: contact.value || undefined, phone: phone.value || undefined, email: email.value || undefined, payment_terms: terms.value, lead_time_days: +lead.value || 0 });
        toast.ok('Supplier added', name.value.trim());
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New supplier', ico: 'suppliers', width: 'narrow',
      body: h('div', {}, field('NAME', name), field('CONTACT', contact), h('div', { class: 'form-row' }, field('PHONE', phone), field('EMAIL', email)), h('div', { class: 'form-row' }, field('PAYMENT TERMS', terms), field('LEAD TIME (DAYS)', lead))),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(
    pageHead('Suppliers', 'Performance-scored sourcing network',
      store.can('suppliers.manage') ? btn('New supplier', { cls: 'primary', ico: 'plus', onClick: newSupplier }) : null),
    h('div', { class: 'row' }, h('div', { class: 'input-group', style: { maxWidth: '300px', flex: '1' } }, h('span', { class: 'ig-ico' }, iconEl('search', 15)), searchEl)),
    h('div', { class: 'card' }, bodyEl));
  await load();
  const id = new URLSearchParams((ctx.hash.split('?')[1] || '')).get('id');
  if (id) openSupplier({ id });
}
