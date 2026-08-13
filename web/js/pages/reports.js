/** Reports — catalogue, runner, CSV export. */
import { api, downloadFile } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtNum, fmtDT, toast, presentError, field, input, iconEl, tabs } from '../ui.js';

const REPORTS = [
  { id: 'sales', name: 'Sales register', desc: 'Every order with payment state, per period', ico: 'orders' },
  { id: 'stock-ageing', name: 'Stock ageing', desc: 'Inventory grouped by days since last movement', ico: 'inventory' },
  { id: 'profit', name: 'Profit & margins', desc: 'Gross margin by product over a period', ico: 'trend' },
  { id: 'customers', name: 'Customer balances', desc: 'Lifetime value, credit position, last order', ico: 'customers' },
  { id: 'suppliers', name: 'Supplier ledger', desc: 'Invoices, payments, outstanding balances', ico: 'suppliers' },
  { id: 'tax', name: 'Tax summary', desc: 'VAT collected per period for filing', ico: 'scale' },
  { id: 'payroll', name: 'Payroll register', desc: 'Runs, items, payout references', ico: 'payroll' },
  { id: 'brokers', name: 'Broker commissions', desc: 'Earned, approved, paid — full trail', ico: 'brokers' },
];

export async function render(el) {
  const state = { active: null, data: null };
  const from = input({ type: 'date', value: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) });
  const to = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
  const listEl = h('div', { class: 'grid c4' });
  const outEl = h('div', { class: 'report-out', style: { minHeight: '260px' } }, h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, iconEl('reports', 22)), h('div', { class: 'e-title' }, 'Pick a report'), h('div', { class: 'e-msg' }, 'Server-generated, tenant-scoped, exportable.')));

  function paintList() {
    listEl.replaceChildren(REPORTS.map(r =>
      h('button', { class: `card`, style: { cursor: 'pointer', textAlign: 'left', border: state.active === r.id ? '1px solid var(--brand-line)' : null, background: state.active === r.id ? 'var(--brand-soft)' : null }, onClick: () => run(r) },
        h('div', { class: 'card-b', style: { padding: '14px' } },
          h('div', { class: 'row', style: { gap: '10px', marginBottom: '6px' } },
            h('span', { style: { color: 'var(--brand)', display: 'grid' } }, iconEl(r.ico, 18)),
            h('b', { style: { fontSize: '13px' } }, r.name)),
          h('div', { class: 'tiny muted' }, r.desc)))));
  }

  async function run(r) {
    state.active = r.id;
    paintList();
    outEl.replaceChildren(h('div', { style: { padding: '16px' } }, h('div', { class: 'skel', style: { height: '200px' } })));
    let data;
    try { data = await api.get(`/api/v1/reports/${r.id}`, { from: from.value, to: to.value }); }
    catch (e) { outEl.replaceChildren(h('div', { class: 'card-b muted' }, e?.message || 'Failed')); return; }
    state.data = data;
    paintOut(r, data);
  }

  function paintOut(r, data) {
    const rows = data.rows || [];
    const cols = rows.length ? Object.keys(rows[0]).filter(k => !['tenant_id'].includes(k)) : [];
    outEl.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'card-h' },
        h('div', { class: 'grow' }, h('h3', {}, r.name), h('div', { class: 'h-sub' }, `${fmtNum(rows.length)} rows · ${(data.from || '').slice(0, 10)} → ${(data.to || '').slice(0, 10)}`)),
        h('div', { class: 'h-right' },
          btn('Download CSV', { size: 'sm', ico: 'download', onClick: async () => {
            try { await downloadFile(`/api/v1/reports/${r.id}?format=csv&from=${from.value}&to=${to.value}`, `${r.id}.csv`); }
            catch (e) { presentError(e, 'Export failed'); }
          } }))),
      h('div', { class: 'tbl-wrap', style: { maxHeight: '480px', overflow: 'auto' } },
        rows.length ? h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c.replace(/_/g, ' '))))),
          h('tbody', {}, rows.slice(0, 200).map(row => h('tr', {}, cols.map(c => h('td', { class: 'tiny' }, formatCell(row[c]))))))) :
          h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, iconEl('inbox', 20)), h('div', { class: 'e-title' }, 'No rows in range')))));
  }

  function formatCell(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDT(v);
    return String(v);
  }

  el.replaceChildren(
    pageHead('Reports', 'Audit-grade exports, always tenant-scoped'),
    h('div', { class: 'card' }, h('div', { class: 'card-b row wrap', style: { gap: '12px', alignItems: 'flex-end' } },
      field('FROM', from), field('TO', to),
      h('div', { class: 'hint tiny', style: { paddingBottom: '8px' } }, 'Range applies to transactional reports.'))),
    listEl,
    outEl);
  paintList();
}
