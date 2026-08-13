/** Brokers — agent network, leads pipeline, commission lifecycle. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, iconEl, tabs } from '../ui.js';

export async function render(el) {
  const state = { brokers: [], commissions: [], tab: 'brokers' };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function load() {
    state.brokers = await api.get('/api/v1/brokers');
    paint();
  }
  async function loadCommissions() {
    // commissions aggregate across brokers
    const details = await Promise.all(state.brokers.map(b => api.get(`/api/v1/brokers/${b.id}`).catch(() => null)));
    state.commissions = details.flatMap(d => (d?.commissions || []).map(c => ({ ...c, broker_name: d.name })));
    paint();
  }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'brokers', label: 'Brokers' },
      { id: 'commissions', label: 'Commissions' },
    ], state.tab, (t) => { state.tab = t; t === 'commissions' ? loadCommissions() : paint(); }));
    bodyEl.replaceChildren(state.tab === 'brokers' ? brokersView() : commissionsView());
  }

  function brokersView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'row end' }, store.can('brokers.view') ? btn('New broker', { cls: 'primary', ico: 'plus', onClick: newBroker }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Broker', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, `${r.code} · ${r.territory || '—'}`)) },
        { label: 'Phone', render: r => h('span', { class: 'tiny mono' }, r.phone || '—') },
        { label: 'Commission', align: 'c', render: r => h('span', { class: 'mono badge-soft' }, `${r.commission_pct}%`) },
        { label: 'Leads', align: 'c', render: r => h('span', { class: 'mono' }, `${fmtNum(r.converted_count)}/${fmtNum(r.leads_count)}`) },
        { label: 'Pending comm.', align: 'r', render: r => h('span', { class: 'num', style: { color: 'var(--warn)' } }, fmtMoney(r.pending_commission)) },
        { label: 'Paid out', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.paid_commission)) },
        { label: 'Status', render: r => pill(r.status) },
      ], state.brokers, { onRow: openBroker, emptyTitle: 'No brokers', emptyMsg: 'Brokers bring leads that convert to customers — commission settles only on PAID orders.', ico: 'brokers' })));
  }

  async function openBroker(b) {
    let full;
    try { full = await api.get(`/api/v1/brokers/${b.id}`); } catch (e) { return presentError(e); }
    const bodyEl = h('div', { class: 'stack' });
    const paintDetail = () => {
      bodyEl.replaceChildren(
        card({ title: 'Snapshot', body: kv([
          ['Territory', full.territory || '—'],
          ['Commission rate', `${full.commission_pct}% of paid order value`],
          ['Leads / converted', `${full.leads_count} / ${full.converted_count}`],
          ['Pending commission', fmtMoney(full.pending_commission)],
          ['Paid commission', fmtMoney(full.paid_commission)],
          ['Revenue generated', fmtMoney(full.revenue_generated)],
        ]) }),
        h('div', { class: 'row' }, btn('Log a lead', { cls: 'primary sm', ico: 'plus', onClick: leadModal })),
        card({
          title: 'Leads pipeline', flush: true,
          body: table([
            { label: 'Lead', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, r.phone || '—')) },
            { label: 'Logged', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
            { label: 'Status', render: r => pill(r.status) },
            { label: '', align: 'r', width: '1%', render: r => r.status !== 'CONVERTED' && store.can('customers.manage')
              ? btn('Convert to customer', { size: 'sm', cls: 'primary', onClick: async (e) => {
                  e.stopPropagation();
                  try { await api.post(`/api/v1/leads/${r.id}/convert`, {}); toast.ok('Lead converted — customer created'); refresh(); load(); }
                  catch (er) { presentError(er); }
                } })
              : null },
          ], full.leads || [], { emptyTitle: 'No leads yet', ico: 'inbox' }),
        }),
        (full.commissions || []).length ? card({
          title: 'Commissions', flush: true,
          body: table([
            { label: 'Order', render: r => h('span', { class: 'mono tiny' }, r.order_number) },
            { label: 'Amount', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.amount)) },
            { label: 'Status', render: r => pill(r.status) },
            { label: '', align: 'r', width: '1%', render: r => commissionActions(r) },
          ], full.commissions),
        }) : null);
    };
    const refresh = async () => { full = await api.get(`/api/v1/brokers/${b.id}`); paintDetail(); };

    function leadModal() {
      const name = input({ placeholder: 'Lead name' });
      const phone = input({ placeholder: '+254…' });
      const note = input({ placeholder: 'Interest / context' });
      const submit = btn('Log lead', { cls: 'primary', ico: 'plus' });
      submit.addEventListener('click', async () => {
        if (!name.value.trim()) return toast.warn('Name required');
        try {
          await api.post(`/api/v1/brokers/${b.id}/leads`, { name: name.value.trim(), phone: phone.value || undefined, note: note.value || undefined });
          toast.ok('Lead logged', name.value.trim());
          document.getElementById('overlays').replaceChildren();
          refresh(); load();
        } catch (e) { presentError(e); }
      });
      modal({ title: `Lead for ${b.name}`, ico: 'plus', width: 'narrow', body: h('div', {}, field('NAME', name), field('PHONE', phone), field('NOTE', note)), foot: h('div', { class: 'right' }, submit) });
    }
    paintDetail();
    drawer({ title: b.name, sub: `${b.code} · ${b.territory || ''}`, ico: 'brokers', body: bodyEl });
  }

  function commissionActions(cm) {
    const row = h('div', { class: 'row end', style: { gap: '6px' } });
    if (cm.status === 'EARNED' && store.can('brokers.commission.approve')) {
      row.appendChild(btn('Approve', { size: 'sm', onClick: async (e) => { e.stopPropagation(); try { await api.post(`/api/v1/commissions/${cm.id}/approve`); toast.ok('Commission approved'); loadCommissions(); } catch (er) { presentError(er); } } }));
    }
    if (cm.status === 'APPROVED' && store.can('brokers.commission.pay')) {
      row.appendChild(btn('Pay', { size: 'sm', cls: 'primary', onClick: (e) => { e.stopPropagation(); payCommissionModal(cm); } }));
    }
    return row;
  }

  function payCommissionModal(cm) {
    const method = select([{ value: 'MPESA', label: 'M-Pesa (sandbox)' }, { value: 'CASH', label: 'Cash' }, { value: 'BANK', label: 'Bank' }]);
    const submit = btn(`Pay ${fmtMoney(cm.amount)}`, { cls: 'primary', ico: 'payments' });
    submit.addEventListener('click', async () => {
      try {
        await api.post(`/api/v1/commissions/${cm.id}/pay`, { method: method.value });
        toast.ok('Commission paid', cm.order_number);
        document.getElementById('overlays').replaceChildren();
        loadCommissions();
      } catch (e) { presentError(e, 'Payout failed'); }
    });
    modal({ title: 'Commission payout', ico: 'payments', width: 'narrow', body: field('METHOD', method), foot: h('div', { class: 'right' }, submit) });
  }

  function commissionsView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('shield-check', 15), h('span', {}, 'Commissions are earned once per paid order, approved by finance, and paid once — double payment is rejected (409).')),
      h('div', { class: 'card' }, table([
        { label: 'Broker', render: r => h('span', { class: 't-main' }, r.broker_name || '—') },
        { label: 'Order', render: r => h('span', { class: 'mono tiny' }, r.order_number) },
        { label: 'Earned', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
        { label: 'Amount', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.amount)) },
        { label: 'Status', render: r => pill(r.status) },
        { label: '', align: 'r', width: '1%', render: r => commissionActions(r) },
      ], state.commissions.sort((a, b) => b.created_at.localeCompare(a.created_at)), { emptyTitle: 'No commissions yet', emptyMsg: 'Commission accrues the moment a broker-linked order is paid.', ico: 'payroll' })));
  }

  function newBroker() {
    const name = input({ placeholder: 'Full name' });
    const phone = input({ placeholder: '+254…' });
    const terr = input({ placeholder: 'e.g. Thika, Ruiru' });
    const pct = input({ type: 'number', min: '0', max: '50', step: '0.5', value: '5' });
    const submit = btn('Add broker', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim()) return toast.warn('Name required');
      try {
        await api.post('/api/v1/brokers', { name: name.value.trim(), phone: phone.value || undefined, territory: terr.value || undefined, commission_pct: +pct.value || 5 });
        toast.ok('Broker added'); document.getElementById('overlays').replaceChildren(); load();
      } catch (e) { presentError(e); }
    });
    modal({ title: 'New broker', ico: 'brokers', width: 'narrow', body: h('div', {}, field('NAME', name), field('PHONE', phone), field('TERRITORY', terr), field('COMMISSION %', pct)), foot: h('div', { class: 'right' }, submit) });
  }

  el.replaceChildren(pageHead('Brokers & Leads', 'Agent network with auditable commissions'), tabBar, bodyEl);
  await load();
}
