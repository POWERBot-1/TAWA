/** Expenses — submit → approve → pay pipeline with segregation of duties. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtNum, toast, presentError, modal, field, input, select, textarea, iconEl } from '../ui.js';

const CATEGORIES = ['RENT', 'ELECTRICITY', 'WATER', 'INTERNET', 'FUEL', 'DELIVERY', 'REPAIRS', 'SALARIES', 'SUPPLIER', 'MARKETING', 'TAXES', 'MISC'];

export async function render(el) {
  let rows = [];
  const bodyEl = h('div', {});

  async function load() {
    try { rows = await api.get('/api/v1/expenses'); paint(); } catch (e) { presentError(e); }
  }

  function paint() {
    const openTotal = rows.filter(r => r.status === 'SUBMITTED').reduce((s, r) => s + r.amount, 0);
    const approved = rows.filter(r => r.status === 'APPROVED').reduce((s, r) => s + r.amount, 0);
    const paid = rows.filter(r => r.status === 'PAID').reduce((s, r) => s + r.amount, 0);
    bodyEl.replaceChildren(
      h('div', { class: 'grid c3' },
        statCard('Awaiting approval', fmtMoney(openTotal), 'warning', rows.filter(r => r.status === 'SUBMITTED').length),
        statCard('Approved · unpaid', fmtMoney(approved), 'clock', rows.filter(r => r.status === 'APPROVED').length),
        statCard('Paid (all time shown)', fmtMoney(paid), 'approve', rows.filter(r => r.status === 'PAID').length)),
      h('div', { class: 'card' }, table([
        { label: 'Expense', render: r => h('div', {}, h('div', { class: 't-main' }, r.description || r.category), h('div', { class: 't-sub mono' }, `${r.number} · ${r.category}`)) },
        { label: 'Payee', render: r => h('span', { class: 'tiny' }, r.payee || '—') },
        { label: 'Submitted', render: r => h('span', { class: 'tiny muted' }, `${fmtDT(r.created_at)} by ${r.submitted_by_name || '—'}`) },
        { label: 'Amount', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.amount)) },
        { label: 'Status', render: r => pill(r.status) },
        { label: 'Approved by', render: r => h('span', { class: 'tiny muted' }, r.approved_by_name || '—') },
        { label: '', align: 'r', width: '1%', render: r => h('div', { class: 'row end', style: { gap: '6px' } },
          r.status === 'SUBMITTED' && store.can('expenses.approve') ? [
            btn('Approve', { size: 'sm', cls: 'primary', onClick: () => act(r, 'approve', 'Expense approved — ledger accrued') }),
            btn('Reject', { size: 'sm', cls: 'danger', onClick: () => act(r, 'reject', 'Expense rejected') })] : null,
          r.status === 'APPROVED' && store.can('expenses.pay') ? btn('Pay', { size: 'sm', cls: 'primary', onClick: () => payModal(r) }) : null) },
      ], rows, { emptyTitle: 'No expenses', emptyMsg: 'Submit rent, fuel, repairs — approval posts a double-entry accrual, payment settles it.', ico: 'expenses' })));
  }

  function statCard(label, value, ico, count) {
    return h('div', { class: 'card kpi' },
      h('div', { class: 'k-label' }, iconEl(ico, 13), label),
      h('div', { class: 'k-value num', style: { fontSize: 'var(--fs-22)' } }, value),
      h('div', { class: 'k-foot tiny' }, `${count} record(s)`));
  }

  async function act(r, kind, msg) {
    try { await api.post(`/api/v1/expenses/${r.id}/${kind}`, {}); toast.ok(msg, r.number); load(); }
    catch (e) { presentError(e); }
  }

  function payModal(r) {
    const method = select([{ value: 'CASH', label: 'Cash' }, { value: 'MPESA', label: 'M-Pesa (sandbox)' }, { value: 'BANK', label: 'Bank' }]);
    const submit = btn(`Pay ${fmtMoney(r.amount)}`, { cls: 'primary', ico: 'payments' });
    submit.addEventListener('click', async () => {
      try {
        await api.post(`/api/v1/expenses/${r.id}/pay`, { method: method.value });
        toast.ok('Expense paid', `${r.number} settled in the ledger`);
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e); }
    });
    modal({ title: `Pay ${r.number}`, ico: 'payments', width: 'narrow', body: field('METHOD', method), foot: h('div', { class: 'right' }, submit) });
  }

  function newExpense() {
    const cat = select(CATEGORIES);
    const desc = input({ placeholder: 'e.g. August electricity bill' });
    const amt = input({ type: 'number', step: '0.01', min: '0.01', placeholder: '0.00' });
    const payee = input({ placeholder: 'e.g. Kenya Power' });
    const submit = btn('Submit expense', { cls: 'primary', ico: 'send' });
    submit.addEventListener('click', async () => {
      if (!(+amt.value > 0)) return toast.warn('Valid amount required');
      try {
        await api.post('/api/v1/expenses', { category: cat.value, description: desc.value || undefined, amount: +amt.value, payee: payee.value || undefined });
        toast.ok('Expense submitted for approval');
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New expense', ico: 'expenses', width: 'narrow',
      body: h('div', {}, field('CATEGORY', cat), field('DESCRIPTION', desc), h('div', { class: 'form-row' }, field('AMOUNT (KES)', amt), field('PAYEE', payee)),
        h('p', { class: 'tiny faint' }, 'Submit ≠ approve ≠ pay. Different hands, full audit chain.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(
    pageHead('Expenses', 'Operating spend with double-entry discipline',
      store.can('expenses.submit') ? btn('New expense', { cls: 'primary', ico: 'plus', onClick: newExpense }) : null),
    bodyEl);
  await load();
}
