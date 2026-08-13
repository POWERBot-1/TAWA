/** Orders — list, detail drawer, fulfilment, cancellation, invoice. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, iconBtn, table, pill, fmtMoney, fmtDT, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, timeline, confirmBox, segmented, iconEl, emptyState, debounce, idempotencyKey } from '../ui.js';
import { go } from '../router.js';

export async function render(el, ctx) {
  let filter = { status: '', q: '' };
  let page = 1;
  const params = new URLSearchParams((ctx.hash.split('?')[1] || ''));
  if (params.get('status')) filter.status = params.get('status');

  const seg = segmented([{ value: '', label: 'All' }, { value: 'CONFIRMED', label: 'Confirmed' }, { value: 'COMPLETED', label: 'Completed' }, { value: 'PARTIALLY_FULFILLED', label: 'Partial' }, { value: 'CANCELLED', label: 'Cancelled' }], filter.status, (v) => { filter.status = v; page = 1; load(); });
  const searchEl = input({ class: 'input', placeholder: 'Filter client-side…', style: { maxWidth: '240px' } });
  const bodyEl = h('div', {});
  const footEl = h('div', { class: 'tbl-foot' });

  async function load() {
    bodyEl.replaceChildren(h('div', { style: { padding: '16px' } }, h('div', { class: 'skel', style: { height: '240px' } })));
    let data, meta;
    try {
      const res = await fetchOrders();
      data = res.data; meta = res.meta;
    } catch (e) { presentError(e, 'Could not load orders'); return; }
    const q = filter.q.toLowerCase();
    const rows = q ? data.filter(o => (o.number + (o.customer_name || '')).toLowerCase().includes(q)) : data;
    bodyEl.replaceChildren(table([
      { label: 'Order', render: r => h('div', {}, h('div', { class: 't-main mono' }, r.number), h('div', { class: 't-sub' }, r.customer_name || 'Walk-in')) },
      { label: 'Placed', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
      { label: 'Items', align: 'c', render: r => h('span', { class: 'mono tiny' }, String(r.item_count ?? '—')) },
      { label: 'Total', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.total)) },
      { label: 'Paid', align: 'r', render: r => h('span', { class: 'num muted' }, fmtMoney(r.amount_paid)) },
      { label: 'Status', render: r => pill(r.status) },
      { label: 'Payment', render: r => pill(r.payment_status) },
      { label: 'Source', render: r => h('span', { class: 'badge-soft' }, r.source) },
    ], rows, {
      onRow: openOrder,
      emptyTitle: 'No orders yet',
      emptyMsg: 'Run a POS sale or convert a quote — orders appear here instantly.',
      ico: 'orders',
    }));
    footEl.replaceChildren(
      h('span', {}, `${meta?.total ?? rows.length} orders`),
      h('div', { class: 'pager' },
        btn('Previous', { size: 'sm', onClick: () => { if (page > 1) { page--; load(); } } }),
        h('span', { class: 'tiny mono' }, `Page ${page}`),
        btn('Next', { size: 'sm', onClick: () => { if (data.length === 25) { page++; load(); } } })));
  }
  async function fetchOrders() {
    const data = await api.get('/api/v1/orders', { status: filter.status || undefined, page, limit: 25 });
    const enriched = await Promise.all(data.map(o => ({ ...o })));
    return { data: enriched, meta: { total: data.length } };
  }

  searchEl.addEventListener('input', debounce(() => { filter.q = searchEl.value; loadRowsClient(); }, 150));
  function loadRowsClient() { load(); }

  async function openOrder(o) {
    let full;
    try { full = await api.get(`/api/v1/orders/${o.id}`); } catch (e) { return presentError(e); }
    const d = drawerOrder(full);
    return d;
  }

  function drawerOrder(o) {
    const actions = h('div', { class: 'row wrap' });
    const bodyEl = h('div', { class: 'stack' });

    const b = () => {
      actions.replaceChildren();
      const can = (...p) => store.can(...p);
      if (o.status !== 'CANCELLED' && o.payment_status !== 'PAID' && can('payments.create')) {
        actions.appendChild(btn('Record payment', { cls: 'primary sm', ico: 'payments', onClick: () => payModal(o, refresh) }));
      }
      if (o.status === 'CONFIRMED' && can('orders.fulfil')) {
        actions.appendChild(btn('Fulfil order', { cls: 'sm', ico: 'approve', onClick: async () => {
          try { await api.post(`/api/v1/orders/${o.id}/fulfil`); toast.ok('Order fulfilled', o.number); await refresh(); load(); }
          catch (e) { presentError(e, 'Fulfil failed'); }
        } }));
      }
      if (o.status !== 'CANCELLED' && store.has('TAWA.DELIVERY') && store.can('deliveries.manage', 'orders.create')) {
        actions.appendChild(btn('Create delivery', { cls: 'sm', ico: 'truck', onClick: () => deliveryModal(o, refresh) }));
      }
      if (can('orders.view')) {
        actions.appendChild(btn('Invoice', { cls: 'ghost sm', ico: 'printer', onClick: () => openDoc(`/api/v1/orders/${o.id}/invoice`) }));
      }
      if (o.status !== 'CANCELLED' && o.status !== 'COMPLETED' && can('orders.cancel')) {
        actions.appendChild(btn('Cancel', { cls: 'danger sm', ico: 'x', onClick: async () => {
          const okC = await confirmBox({ title: `Cancel ${o.number}?`, message: 'Reserved stock is released and the cancellation is audited. Payments already settled are NOT auto-refunded.', confirmLabel: 'Cancel order', danger: true });
          if (!okC) return;
          try { await api.post(`/api/v1/orders/${o.id}/cancel`, { reason: 'cancelled from UI' }); toast.ok('Order cancelled'); await refresh(); load(); }
          catch (e) { presentError(e, 'Cancel failed'); }
        } }));
      }
    };

    async function refresh() {
      try { o = await api.get(`/api/v1/orders/${o.id}`); paint(); } catch { /* noop */ }
    }
    function paint() {
      bodyEl.replaceChildren(
        h('div', { class: 'row between wrap' },
          h('div', {},
            h('div', { class: 'mono strong', style: { fontSize: 'var(--fs-18)' } }, o.number),
            h('div', { class: 'tiny muted' }, `${o.customer_name || o.customer?.name || 'Walk-in'} · ${fmtDT(o.created_at)}`)),
          h('div', { class: 'row', style: { gap: '6px' } }, pill(o.status), pill(o.payment_status))),
        h('div', { class: 'card', style: { background: 'var(--bg-soft)' } },
          h('div', { class: 'card-b stack xs' },
            (o.items || []).map(it => h('div', { class: 'row between', style: { fontSize: '13px' } },
              h('span', {}, h('b', { class: 'mono' }, `${fmtNum(it.qty)}×`), ' ', it.name_snap || it.name || it.product_name, h('span', { class: 'tiny faint mono' }, ` · ${it.unit || ''}`)),
              h('span', { class: 'num' }, fmtMoney(it.total)))),
            h('hr', { class: 'divider', style: { margin: '6px 0' } }),
            h('div', { class: 'row between tiny muted' }, h('span', {}, 'Subtotal'), h('span', { class: 'num' }, fmtMoney(o.subtotal))),
            o.discount ? h('div', { class: 'row between tiny muted' }, h('span', {}, 'Discount'), h('span', { class: 'num' }, `−${fmtMoney(o.discount)}`)) : null,
            h('div', { class: 'row between tiny muted' }, h('span', {}, 'VAT'), h('span', { class: 'num' }, fmtMoney(o.tax))),
            o.delivery_fee ? h('div', { class: 'row between tiny muted' }, h('span', {}, 'Delivery'), h('span', { class: 'num' }, fmtMoney(o.delivery_fee))) : null,
            h('div', { class: 'row between strong' }, h('span', {}, 'Total'), h('span', { class: 'num' }, fmtMoney(o.total))),
            h('div', { class: 'row between tiny', style: { color: 'var(--ok)' } }, h('span', {}, 'Paid'), h('span', { class: 'num' }, fmtMoney(o.amount_paid))),
            o.total - o.amount_paid > 0 ? h('div', { class: 'row between tiny', style: { color: 'var(--warn)' } }, h('span', {}, 'Balance'), h('span', { class: 'num' }, fmtMoney(o.total - o.amount_paid))) : null)),
        o.is_credit ? h('div', { class: 'pill warn', style: { alignSelf: 'flex-start' } }, h('span', { class: 'pdot' }), 'CREDIT SALE') : null,
        actions,
        (o.payments || []).length ? card({
          title: 'Payments', flush: true,
          body: table([
            { label: 'Reference', render: r => h('span', { class: 'mono tiny' }, r.reference) },
            { label: 'Method', render: r => h('span', { class: 'badge-soft' }, r.method) },
            { label: 'Amount', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.amount)) },
            { label: 'Status', render: r => pill(r.status) },
          ], o.payments),
        }) : null,
      );
      b();
    }
    paint();
    const close = drawer({ title: 'Order detail', sub: o.quote_id ? 'Converted from quote' : o.source, ico: 'orders', body: bodyEl });
    return close;
  }

  async function openDoc(path) {
    try {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${store.session.token}` } });
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch { toast.err('Could not open document'); }
  }

  function payModal(o, done) {
    const amt = input({ type: 'number', step: '0.01', min: '0.01', value: ((o.total - o.amount_paid) / 100).toFixed(2) });
    const method = select([{ value: 'CASH', label: 'Cash (till)' }, { value: 'BANK', label: 'Bank transfer (manual confirm)' }, { value: 'MPESA', label: 'M-Pesa (STK push, sandbox)' }], { value: 'CASH' });
    const ref = input({ placeholder: 'Bank reference (bank only)' });
    const refField = field('REFERENCE', ref);
    refField.style.display = 'none';
    method.addEventListener('change', () => { refField.style.display = method.value === 'BANK' ? '' : 'none'; });
    const submit = btn('Record payment', { cls: 'primary', ico: 'approve' });
    submit.addEventListener('click', async () => {
      submit.classList.add('busy');
      try {
        const provider = { CASH: 'cash', BANK: 'bank_manual', MPESA: 'mpesa_sandbox' }[method.value];
        const res = await api.post('/api/v1/payments/intents', { order_id: o.id, customer_id: o.customer_id, amount: +amt.value, provider, method: method.value, idempotency_key: idempotencyKey() });
        const intent = res.intent;
        await api.post(`/api/v1/payments/intents/${intent.id}/initiate`, {});
        if (method.value === 'CASH') await api.post(`/api/v1/payments/intents/${intent.id}/confirm-cash`, { amount: +amt.value });
        else if (method.value === 'BANK') await api.post(`/api/v1/payments/intents/${intent.id}/confirm-bank`, { bank_reference: ref.value || 'MANUAL' });
        else toast.warn('M-Pesa pending', 'Confirm in Payments centre after the customer approves (sandbox).');
        toast.ok('Payment recorded', o.number);
        closeAllOverlays();
        await done(); load();
      } catch (e) { submit.classList.remove('busy'); presentError(e, 'Payment failed'); }
    });
    const closeAllOverlays = () => document.getElementById('overlays').replaceChildren();
    modal({
      title: `Collect · ${o.number}`, ico: 'payments', width: 'narrow',
      body: h('div', {},
        field('AMOUNT (KES)', amt, { hint: `Balance outstanding: ${fmtMoney(o.total - o.amount_paid)}` }),
        field('METHOD', method),
        refField),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  function deliveryModal(o, done) {
    const addr = input({ placeholder: 'Delivery address / site' });
    const fee = input({ type: 'number', step: '0.01', min: '0', value: '0' });
    const submit = btn('Create delivery', { cls: 'primary', ico: 'truck' });
    submit.addEventListener('click', async () => {
      try {
        await api.post('/api/v1/deliveries', { order_id: o.id, address: addr.value || 'Customer pickup', fee: +fee.value || 0 });
        toast.ok('Delivery created', 'Assign a driver from Deliveries.');
        document.getElementById('overlays').replaceChildren();
        go('/deliveries');
      } catch (e) { presentError(e, 'Could not create delivery'); }
    });
    modal({
      title: `Deliver · ${o.number}`, ico: 'truck', width: 'narrow',
      body: h('div', {}, field('ADDRESS', addr), field('DELIVERY FEE (KES)', fee)),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(
    pageHead('Orders', 'Every sale, paid or pending',
      btn('New sale', { cls: 'primary', ico: 'plus', onClick: () => go('/pos') }),
    ),
    h('div', { class: 'row wrap', style: { gap: '10px' } }, seg, searchEl),
    h('div', { class: 'card' }, bodyEl, footEl));

  await load();

  // Deep-link ?id=
  if (params.get('id')) {
    try { openOrder({ id: params.get('id') }); } catch { /* noop */ }
  }
}
