/** Credit — house accounts with hard limits, repayments, and history. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, iconEl, idempotencyKey } from '../ui.js';

export async function render(el) {
  let accounts = [];
  const bodyEl = h('div', {});

  async function load() {
    try { accounts = await api.get('/api/v1/credit/accounts'); paint(); } catch (e) { presentError(e); }
  }

  function paint() {
    const totalLimit = accounts.reduce((s, a) => s + (a.limit_amount || 0), 0);
    const totalOut = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    bodyEl.replaceChildren(
      h('div', { class: 'grid c3' },
        h('div', { class: 'card kpi brand-strip' }, h('div', { class: 'k-label' }, iconEl('credit', 13), 'Credit accounts'), h('div', { class: 'k-value num' }, fmtNum(accounts.length))),
        h('div', { class: 'card kpi warn-strip' }, h('div', { class: 'k-label' }, iconEl('wallet', 13), 'Outstanding'), h('div', { class: 'k-value num', style: { fontSize: 'var(--fs-22)' } }, fmtMoney(totalOut))),
        h('div', { class: 'card kpi ok-strip' }, h('div', { class: 'k-label' }, iconEl('scale', 13), 'Available to lend'), h('div', { class: 'k-value num', style: { fontSize: 'var(--fs-22)' } }, fmtMoney(Math.max(0, totalLimit - totalOut))))),
      h('div', { class: 'card' }, table([
        { label: 'Customer', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, r.code)) },
        { label: 'Limit', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.limit_amount)) },
        { label: 'Used', align: 'r', render: r => h('span', { class: 'num strong', style: r.balance > 0 ? { color: 'var(--warn)' } : null }, fmtMoney(r.balance)) },
        { label: 'Utilisation', width: '180px', render: r => {
            const pct = r.limit_amount ? Math.round(((r.balance || 0) / r.limit_amount) * 100) : 0;
            return h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${pct > 80 ? 'danger' : pct > 50 ? 'warn' : 'ok'}`, style: { width: `${Math.min(100, pct)}%` } }));
          } },
        { label: '', align: 'r', width: '1%', render: r => h('div', { class: 'row end', style: { gap: '6px' } },
          btn('History', { size: 'sm', onClick: (e) => { e.stopPropagation(); openAccount(r); } }),
          r.balance > 0 && store.can('payments.create') ? btn('Collect', { size: 'sm', cls: 'primary', onClick: (e) => { e.stopPropagation(); repayModal(r); } }) : null) },
      ], accounts, { onRow: openAccount, emptyTitle: 'No credit accounts', emptyMsg: 'Grant credit from a customer profile — limits are enforced at order time, server-side.', ico: 'credit' })));
  }

  async function openAccount(a) {
    let full;
    try { full = await api.get(`/api/v1/credit/accounts/${a.customer_id}`); } catch (e) { return presentError(e); }
    drawer({
      title: a.name, sub: `Credit account · ${a.code}`, ico: 'credit',
      body: h('div', { class: 'stack' },
        card({ title: 'Position', body: kv([
          ['Limit', fmtMoney(full.limit_amount)],
          ['Outstanding', fmtMoney(full.balance)],
          ['Available', fmtMoney(Math.max(0, full.limit_amount - full.balance))],
          ['Status', full.is_active ? 'Active' : 'Frozen'],
        ]) }),
        (full.transactions || []).length ? card({
          title: 'Account history', flush: true,
          body: table([
            { label: 'When', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
            { label: 'Type', render: r => h('span', { class: 'badge-soft mono' }, r.type) },
            { label: 'Amount', align: 'r', render: r => h('span', { class: 'num', style: { color: r.type === 'REPAYMENT' || r.amount < 0 ? 'var(--ok)' : 'var(--text)' } }, fmtMoney(r.amount)) },
            { label: 'Balance', align: 'r', render: r => h('span', { class: 'num muted' }, fmtMoney(r.balance_after)) },
          ], full.transactions),
        }) : h('div', { class: 'faint tiny' }, 'No transactions yet.')),
    });
  }

  function repayModal(a) {
    const amt = input({ type: 'number', step: '0.01', max: (a.balance / 100).toFixed(2), value: (a.balance / 100).toFixed(2) });
    const method = select([{ value: 'CASH', label: 'Cash (till)' }, { value: 'MPESA', label: 'M-Pesa (sandbox STK)' }, { value: 'BANK', label: 'Bank reference' }]);
    const submit = btn('Collect repayment', { cls: 'primary', ico: 'payments' });
    submit.addEventListener('click', async () => {
      try {
        const res = await api.post(`/api/v1/credit/accounts/${a.customer_id}/pay`, { amount: +amt.value, method: method.value, idempotency_key: idempotencyKey() });
        const intent = res.intent;
        await api.post(`/api/v1/payments/intents/${intent.id}/initiate`, {});
        if (method.value === 'CASH') {
          await api.post(`/api/v1/payments/intents/${intent.id}/confirm-cash`, { amount: +amt.value });
          toast.ok('Repayment settled', 'Credit capacity released.');
        } else if (method.value === 'BANK') {
          await api.post(`/api/v1/payments/intents/${intent.id}/confirm-bank`, { bank_reference: 'UI-MANUAL' });
          toast.ok('Repayment settled');
        } else {
          toast.warn('STK push sent', 'Verify the intent from Payments → Intents.');
        }
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e, 'Repayment failed'); }
    });
    modal({
      title: `Collect from ${a.name}`, sub: `Outstanding ${fmtMoney(a.balance)}`, ico: 'payments', width: 'narrow',
      body: h('div', {}, field('AMOUNT (KES)', amt), field('METHOD', method)),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(
    pageHead('Credit', 'Hard limits. Real balances. Audited repayments.'),
    bodyEl);
  await load();
}
