/** Payments centre — intents, settled payments, verification, refunds, reconciliation. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtNum, toast, presentError, modal, field, input, select, tabs, kv, iconEl, copyText, idempotencyKey, timeline } from '../ui.js';

export async function render(el) {
  const state = { tab: 'payments', payments: [], intents: [], recon: null };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function load() {
    if (state.tab === 'payments') state.payments = await api.get('/api/v1/payments', { limit: 100 });
    if (state.tab === 'intents') state.intents = await api.get('/api/v1/payments/intents', { limit: 100 });
    if (state.tab === 'recon') state.recon = await api.get('/api/v1/payments/reconcile');
  }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'payments', label: 'Settled payments' },
      { id: 'intents', label: 'Intents in flight' },
      { id: 'recon', label: 'Reconciliation' },
    ], state.tab, async (t) => { state.tab = t; bodyEl.replaceChildren(loading()); await load().catch(presentError); paint(); }));

    if (state.tab === 'payments') bodyEl.replaceChildren(paymentsView());
    else if (state.tab === 'intents') bodyEl.replaceChildren(intentsView());
    else bodyEl.replaceChildren(reconView());
  }
  const loading = () => h('div', { class: 'card' }, h('div', { style: { padding: '16px' } }, h('div', { class: 'skel', style: { height: '260px' } })));

  function paymentsView() {
    return h('div', { class: 'card' }, table([
      { label: 'Reference', render: r => h('button', { class: 'link mono', style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '12px' }, onClick: () => copyText(r.reference, 'Reference copied') }, r.reference) },
      { label: 'Order', render: r => h('span', { class: 'mono tiny' }, r.order_number || '—') },
      { label: 'Customer', render: r => h('span', { class: 'tiny' }, r.customer_name || '—') },
      { label: 'Method', render: r => h('span', { class: 'badge-soft' }, r.method) },
      { label: 'Provider', render: r => h('span', { class: 'tiny muted mono' }, r.provider) },
      { label: 'Amount', align: 'r', render: r => h('span', { class: 'num strong', style: r.direction === 'OUTBOUND' ? { color: 'var(--warn)' } : null }, `${r.direction === 'OUTBOUND' ? '−' : ''}${fmtMoney(r.amount)}`) },
      { label: 'Status', render: r => pill(r.status) },
      { label: 'When', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.received_at || r.created_at)) },
      { label: '', align: 'r', width: '1%', render: r => h('div', { class: 'row end' },
        r.status === 'SETTLED' && store.can('payments.refund') ? btn('Refund', { size: 'sm', cls: 'danger', onClick: () => refundModal(r) }) : null) },
    ], state.payments, { emptyTitle: 'No payments yet', emptyMsg: 'Payments settle through intents with server-side verification.', ico: 'payments' }));
  }

  function refundModal(p) {
    const amt = input({ type: 'number', step: '0.01', min: '0.01', max: (p.amount / 100).toFixed(2), value: (p.amount / 100).toFixed(2) });
    const reason = input({ placeholder: 'Reason (audited)' });
    const submit = btn('Issue refund', { cls: 'danger', ico: 'warning' });
    submit.addEventListener('click', async () => {
      try {
        const r = await api.post(`/api/v1/payments/${p.id}/refund`, { amount: +amt.value, reason: reason.value || 'customer request' });
        toast.ok('Refund executed', `${fmtMoney(r.amount ?? +amt.value * 100)} against ${p.reference}`);
        document.getElementById('overlays').replaceChildren();
        await load(); paint();
      } catch (e) { presentError(e, 'Refund rejected'); }
    });
    modal({
      title: `Refund ${p.reference}`, sub: `Original: ${fmtMoney(p.amount)}`, ico: 'warning', width: 'narrow',
      body: h('div', {},
        field('AMOUNT (KES)', amt, { hint: 'Server hard-caps refund ≤ original captured amount (409 beyond).' }),
        field('REASON', reason)),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  function intentsView() {
    const pending = state.intents.filter(i => !['SETTLED', 'FAILED'].includes(i.status));
    return h('div', { class: 'stack' },
      pending.length ? h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('clock', 15), h('span', {}, `${pending.length} intent(s) awaiting provider confirmation — verify server-side before goods move.`)) : null,
      h('div', { class: 'card' }, table([
        { label: 'Intent', render: r => h('span', { class: 'mono tiny' }, r.id.slice(0, 14) + '…') },
        { label: 'Order', render: r => h('span', { class: 'mono tiny' }, r.order_number || '—') },
        { label: 'Purpose', render: r => h('span', { class: 'badge-soft' }, r.purpose) },
        { label: 'Method', render: r => h('span', { class: 'tiny' }, r.method) },
        { label: 'Amount', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.amount)) },
        { label: 'Status', render: r => pill(r.status) },
        { label: 'Idempotency', render: r => h('span', { class: 'tiny mono faint' }, (r.idempotency_key || '').slice(0, 18) + '…') },
        { label: '', align: 'r', width: '1%', render: r => ['CREATED', 'REQUIRES_ACTION', 'PROCESSING'].includes(r.status) && store.can('payments.verify')
          ? btn('Verify', { size: 'sm', cls: 'primary', onClick: async () => {
              try {
                const res = await api.post(`/api/v1/payments/intents/${r.id}/verify`, {});
                if (res.processing) toast.warn('Still processing', 'Provider has not confirmed yet.');
                else { toast.ok('Verified & settled', r.id); await load(); paint(); }
              } catch (e) { presentError(e); }
            } })
          : null },
      ], state.intents, { emptyTitle: 'No intents', ico: 'bolt' })));
  }

  function reconView() {
    const r = state.recon;
    if (!r) return loading();
    const findings = r.findings || [];
    return h('div', { class: 'stack' },
      h('div', { class: 'grid c3' },
        h('div', { class: 'card kpi ok-strip' }, h('div', { class: 'k-label' }, iconEl('approve', 13), 'Payments checked'), h('div', { class: 'k-value num' }, fmtNum(r.payment_count))),
        h('div', { class: 'card kpi brand-strip' }, h('div', { class: 'k-label' }, iconEl('payments', 13), 'Collected total'), h('div', { class: 'k-value num', style: { fontSize: 'var(--fs-22)' } }, fmtMoney(r.collected_total))),
        h('div', { class: `card kpi ${findings.length ? 'danger' : 'ok'}-strip` }, h('div', { class: 'k-label' }, iconEl('scale', 13), 'Findings'), h('div', { class: 'k-value num' }, fmtNum(findings.length)))),
      findings.length ? card({
        title: 'Discrepancies', flush: true,
        body: table([
          { label: 'Finding', render: f => h('span', { class: 't-main' }, f.message || f.kind) },
          { label: 'Ref', render: f => h('span', { class: 'mono tiny' }, f.payment_id || f.intent_id || '—') },
          { label: 'Severity', render: f => pill(f.severity || 'HIGH') },
        ], findings),
      }) : h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, iconEl('approve', 22)),
        h('div', { class: 'e-title' }, 'Ledger and payments agree'),
        h('div', { class: 'e-msg' }, 'Every settled payment maps to a balanced double-entry journal. Provider records reconcile.'))));
  }

  el.replaceChildren(pageHead('Payments', 'Verify the provider. Reconcile the ledger. Audit the action.'), tabBar, bodyEl);
  await load(); paint();
}
