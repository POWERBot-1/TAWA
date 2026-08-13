/** Procurement — requisitions → POs → GRN → supplier invoices → payment. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, drawer, modal, field, input, select, tabs, kv, iconEl, confirmBox, timeline } from '../ui.js';
import { go } from '../router.js';

export async function render(el) {
  const state = { tab: 'requisitions', requisitions: [], pos: [], invoices: [], suppliers: [], products: [], warehouses: [] };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function loadAll() {
    const fetches = [];
    if (state.tab === 'requisitions') fetches.push(api.get('/api/v1/procurement/requisitions').then(r => state.requisitions = r));
    if (state.tab === 'pos') { fetches.push(api.get('/api/v1/procurement/pos').then(r => state.pos = r)); fetches.push(api.get('/api/v1/suppliers').then(r => state.suppliers = r).catch(() => [])); fetches.push(api.get('/api/v1/warehouses').then(r => state.warehouses = r)); }
    if (state.tab === 'invoices') fetches.push(api.get('/api/v1/procurement/invoices').then(r => state.invoices = r));
    await Promise.all(fetches);
  }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'requisitions', label: 'Requisitions' },
      { id: 'pos', label: 'Purchase orders' },
      { id: 'invoices', label: 'Supplier invoices' },
    ], state.tab, async (t) => { state.tab = t; bodyEl.replaceChildren(h('div', { class: 'skel', style: { height: '240px', borderRadius: '12px' } })); await loadAll(); paint(); }));

    if (state.tab === 'requisitions') bodyEl.replaceChildren(reqView());
    else if (state.tab === 'pos') bodyEl.replaceChildren(poView());
    else bodyEl.replaceChildren(invView());
  }

  /* ---------------- requisitions ---------------- */
  function reqView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'row end wrap' },
        store.can('ai.view') && store.has('TAWA.AI') ? btn('AI reorder suggestions', { ico: 'ai', onClick: aiReorderModal }) : null,
        store.can('procurement.create') ? btn('New requisition', { cls: 'primary', ico: 'plus', onClick: () => reqModal() }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Number', render: r => h('span', { class: 'mono badge-soft' }, r.number) },
        { label: 'Reason', render: r => h('div', {}, h('div', { class: 't-main' }, r.reason || '—'), h('div', { class: 't-sub' }, `${(r.items || []).length} items · by ${r.requested_by_name || '—'}`)) },
        { label: 'Source', render: r => h('span', { class: `pill ${r.source === 'AI' ? 'brand' : 'neutral'}` }, h('span', { class: 'pdot' }), r.source || 'MANUAL') },
        { label: 'Created', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
        { label: 'Est. cost', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney((r.items || []).reduce((s, i) => s + i.est_cost * i.qty, 0))) },
        { label: 'Status', render: r => pill(r.status) },
        { label: '', align: 'r', width: '1%', render: r => h('div', { class: 'row end', style: { gap: '6px' } },
          r.status === 'PENDING_APPROVAL' && store.can('procurement.approve') ? btn('Approve', { size: 'sm', cls: 'primary', onClick: async (e) => { e.stopPropagation(); try { await api.post(`/api/v1/procurement/requisitions/${r.id}/approve`); toast.ok('Approved', r.number); refresh(); } catch (er) { presentError(er); } } }) : null,
          r.status === 'APPROVED' && store.can('procurement.create') ? btn('Make PO', { size: 'sm', onClick: (e) => { e.stopPropagation(); poModal(r); } }) : null) },
      ], state.requisitions, { emptyTitle: 'No requisitions', emptyMsg: 'AI reorder analysis can draft these — nothing is sent to suppliers without human approval.', ico: 'procurement' })));
  }

  async function aiReorderModal() {
    let recs;
    try { recs = await api.get('/api/v1/ai/reorder'); } catch (e) { return presentError(e); }
    const picks = new Map();
    const submit = btn('Draft requisition', { cls: 'primary', ico: 'procurement' });
    submit.addEventListener('click', async () => {
      if (!picks.size) return toast.warn('Select at least one line');
      try {
        await api.post('/api/v1/procurement/requisitions', {
          reason: 'AI-prepared replenishment draft',
          source: 'AI',
          items: [...picks.values()].map(r => ({ product_id: r.product_id, qty: r.suggested_qty, est_cost: r.est_cost })),
        });
        toast.ok('Requisition drafted', 'Approve it, then convert to a PO.');
        document.getElementById('overlays').replaceChildren();
        refresh();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'AI reorder analysis', sub: 'RECOMMEND class — drafts only, humans approve', ico: 'ai', width: 'wide',
      body: h('div', { class: 'stack' },
        h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Computed from reorder points, recent sales velocity and lead time. Nothing is ordered automatically.'),
        table([
          { label: '', width: '1%', render: r => h('input', { type: 'checkbox', style: { accentColor: 'var(--brand)' }, checked: picks.has(r.product_id), onChange: (e) => e.target.checked ? picks.set(r.product_id, r) : picks.delete(r.product_id) }) },
          { label: 'Product', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, r.sku)) },
          { label: 'Available', align: 'r', render: r => h('span', { class: 'num', style: { color: 'var(--danger)' } }, fmtNum(r.available)) },
          { label: 'Daily velocity', align: 'r', render: r => h('span', { class: 'num tiny muted' }, fmtNum(r.velocity)) },
          { label: 'Days of stock', align: 'r', render: r => h('span', { class: 'num' }, r.days_of_stock == null ? '—' : r.days_of_stock >= 999 ? '∞' : fmtNum(r.days_of_stock)) },
          { label: 'Suggested', align: 'r', render: r => h('span', { class: 'num strong', style: { color: 'var(--brand)' } }, fmtNum(r.suggested_qty)) },
          { label: 'Urgency', render: r => pill(r.urgency) },
        ], recs, { emptyTitle: 'No reorder needs', emptyMsg: 'All products are above their reorder points.', ico: 'approve' })),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  async function reqModal() {
    try { if (!state.products.length) state.products = await api.get('/api/v1/products', { limit: 200 }); } catch { /* noop */ }
    const reason = input({ placeholder: 'e.g. Replenish fast-moving fasteners' });
    const reason2 = reason;
    const prodSel = select([{ value: '', label: 'Add product…' }, ...state.products.map(p => ({ value: p.id, label: `${p.name} — ${fmtMoney(p.cost_price)} cost` }))]);
    const lines = new Map();
    const linesEl = h('div', { class: 'stack sm' }, h('div', { class: 'faint tiny' }, 'No lines yet'));
    prodSel.addEventListener('change', () => {
      if (!prodSel.value) return;
      lines.set(prodSel.value, { product: state.products.find(p => p.id === prodSel.value), qty: 1, est: 0 });
      prodSel.value = ''; paintLines();
    });
    function paintLines() {
      linesEl.replaceChildren([...lines.values()].length ? [...lines.values()].map(l => {
        const qIn = input({ type: 'number', min: '1', value: String(l.qty), style: { width: '80px', height: '28px' }, onChange: (e) => { l.qty = Math.max(1, Number(e.target.value)); } });
        const eIn = input({ type: 'number', min: '0', step: '0.01', value: (l.est || l.product.cost_price / 100).toFixed(2), style: { width: '110px', height: '28px' }, onChange: (e) => { l.est = Math.max(0, Number(e.target.value)); } });
        return h('div', { class: 'row between', style: { gap: '8px' } },
          h('span', { class: 'grow ellipsis', style: { fontSize: '13px' } }, l.product.name), qIn, eIn,
          h('button', { class: 'icon-btn', style: { width: '26px', height: '26px' }, onClick: () => { lines.delete(l.product.id); paintLines(); } }, iconEl('x', 13)));
      }) : [h('div', { class: 'faint tiny' }, 'No lines yet')]);
    }
    const submit = btn('Submit requisition', { cls: 'primary', ico: 'procurement' });
    submit.addEventListener('click', async () => {
      if (!reason2.value.trim()) return toast.warn('Reason required');
      if (!lines.size) return toast.warn('Add at least one product');
      try {
        await api.post('/api/v1/procurement/requisitions', {
          reason: reason2.value.trim(),
          items: [...lines.values()].map(l => ({ product_id: l.product.id, qty: l.qty, est_cost: Math.round((l.est || l.product.cost_price / 100) * 100) })),
        });
        toast.ok('Requisition submitted for approval');
        document.getElementById('overlays').replaceChildren();
        refresh();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New requisition', ico: 'procurement', width: 'wide',
      body: h('div', {}, field('REASON', reason), field('PRODUCTS', prodSel), linesEl,
        h('p', { class: 'tiny faint' }, 'Columns: quantity · estimated unit cost (KES). Approval is a separate step — segregation of duties.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  /* ---------------- purchase orders ---------------- */
  function poView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'row end' }, store.can('procurement.create') ? btn('New PO', { cls: 'primary', ico: 'plus', onClick: () => poModal(null) }) : null),
      h('div', { class: 'card' }, table([
        { label: 'PO', render: r => h('div', {}, h('div', { class: 't-main mono' }, r.number), h('div', { class: 't-sub' }, r.supplier_name)) },
        { label: 'Warehouse', render: r => h('span', { class: 'tiny' }, r.warehouse_name || 'Any') },
        { label: 'Created', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
        { label: 'Expected', render: r => h('span', { class: 'tiny muted' }, r.expected_at ? fmtDate(r.expected_at) : '—') },
        { label: 'Total (VAT incl.)', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.total)) },
        { label: 'Status', render: r => pill(r.status) },
      ], state.pos, { onRow: openPo, emptyTitle: 'No purchase orders', emptyMsg: 'Approve a requisition and convert it — or create a PO directly.', ico: 'procurement' })));
  }

  async function openPo(row) {
    let po;
    try { po = await api.get(`/api/v1/procurement/pos/${row.id}`); } catch (e) { return presentError(e); }
    const actions = h('div', { class: 'row wrap' });
    const paintActions = () => {
      actions.replaceChildren();
      if (['PENDING_APPROVAL', 'DRAFT'].includes(po.status) && store.can('procurement.approve')) actions.appendChild(btn('Approve PO', { cls: 'primary sm', ico: 'approve', onClick: () => step('approve', 'PO approved') }));
      if (po.status === 'APPROVED' && store.can('procurement.approve')) actions.appendChild(btn('Send to supplier', { cls: 'sm', ico: 'send', onClick: () => step('send', 'PO sent — supplier SMS queued') }));
      if (['SENT', 'PARTIALLY_RECEIVED', 'APPROVED'].includes(po.status) && store.can('procurement.receive')) actions.appendChild(btn('Receive goods (GRN)', { cls: 'sm', ico: 'inbox', onClick: receiveModal }));
      actions.appendChild(btn('PO document', { cls: 'ghost sm', ico: 'printer', onClick: async () => {
        const res = await fetch(`/api/v1/procurement/pos/${po.id}/document`, { headers: { Authorization: `Bearer ${store.session.token}` } });
        window.open(URL.createObjectURL(await res.blob()), '_blank');
      } }));
    };
    async function step(kind, msg) {
      try { po = await api.post(`/api/v1/procurement/pos/${po.id}/${kind}`, {}); toast.ok(msg, po.number); paintActions(); repaint(); refresh(); }
      catch (e) { presentError(e); }
    }
    function receiveModal() {
      const rows = po.items.filter(i => i.qty > i.received_qty);
      const inputs = new Map(rows.map(i => [i.product_id, (i.qty - i.received_qty)]));
      const list = h('div', { class: 'stack sm' }, rows.map(i => {
        const qtyIn = input({ type: 'number', min: '0', step: '1', value: String(i.qty - i.received_qty), style: { width: '90px', height: '28px' } });
        qtyIn.addEventListener('change', () => inputs.set(i.product_id, Number(qtyIn.value)));
        return h('div', { class: 'row between', style: { fontSize: '13px' } },
          h('span', { class: 'grow ellipsis' }, i.name || i.name_snap),
          h('span', { class: 'tiny muted mono' }, `${fmtNum(i.received_qty)}/${fmtNum(i.qty)}`),
          qtyIn);
      }));
      const submit = btn('Post GRN & stock-in', { cls: 'primary', ico: 'inbox' });
      submit.addEventListener('click', async () => {
        const items = rows.map(i => ({ product_id: i.product_id, qty: inputs.get(i.product_id) })).filter(i => i.qty > 0);
        if (!items.length) return toast.warn('Nothing to receive');
        try {
          await api.post(`/api/v1/procurement/pos/${po.id}/receive`, { items });
          toast.ok('Goods received', 'Stock incremented atomically with the GRN.');
          document.getElementById('overlays').replaceChildren();
          refresh();
        } catch (e) { presentError(e, 'GRN failed'); }
      });
      modal({
        title: `Receive · ${po.number}`, ico: 'inbox', width: 'wide',
        body: h('div', {}, h('p', { class: 'tiny muted' }, 'Quantities are validated against the PO — over-receipt is rejected by the server.'), list),
        foot: h('div', { class: 'right' }, submit),
      });
    }
    const headEl = h('div', {});
    const repaint = () => {
      headEl.replaceChildren(h('div', { class: 'row between wrap' },
        h('div', {}, h('div', { class: 'mono strong', style: { fontSize: 'var(--fs-18)' } }, po.number), h('div', { class: 'tiny muted' }, po.supplier_name)),
        pill(po.status)),
      h('div', { class: 'card', style: { background: 'var(--bg-soft)' } },
        h('div', { class: 'card-b stack xs' },
          (po.items || []).map(i => h('div', { class: 'row between', style: { fontSize: '13px' } },
            h('span', {}, h('b', { class: 'mono' }, `${fmtNum(i.qty)}×`), ' ', i.name || i.name_snap, h('span', { class: 'tiny faint' }, ` (${fmtNum(i.received_qty)} received)`)),
            h('span', { class: 'num' }, fmtMoney(i.total)))),
          h('hr', { class: 'divider', style: { margin: '6px 0' } }),
          h('div', { class: 'row between tiny muted' }, h('span', {}, 'Subtotal'), h('span', { class: 'num' }, fmtMoney(po.subtotal))),
          h('div', { class: 'row between tiny muted' }, h('span', {}, 'VAT 16%'), h('span', { class: 'num' }, fmtMoney(po.tax))),
          h('div', { class: 'row between strong' }, h('span', {}, 'Total'), h('span', { class: 'num' }, fmtMoney(po.total))))));
    };
    repaint(); paintActions();
    drawer({ title: 'Purchase order', ico: 'procurement', body: h('div', { class: 'stack' }, headEl, actions) });
    function refresh() { loadAll().then(paint); }
  }

  function poModal(requisition) {
    if (!state.suppliers.length) return toast.warn('No suppliers', 'Add a supplier first.');
    const supSel = select(state.suppliers.map(s => ({ value: s.id, label: s.name })));
    const whSel = select(state.warehouses.map(w => ({ value: w.id, label: w.name })));
    const submit = btn(requisition ? 'Create PO from requisition' : 'Create PO', { cls: 'primary', ico: 'procurement' });
    submit.addEventListener('click', async () => {
      try {
        const po = await api.post('/api/v1/procurement/pos', { supplier_id: supSel.value, requisition_id: requisition?.id, warehouse_id: whSel.value });
        toast.ok('PO created', po.number);
        document.getElementById('overlays').replaceChildren();
        state.tab = 'pos'; await loadAll(); paint();
      } catch (e) { presentError(e, 'PO failed'); }
    });
    modal({
      title: requisition ? `PO from ${requisition.number}` : 'New purchase order', ico: 'procurement', width: 'narrow',
      body: h('div', {}, field('SUPPLIER', supSel), field('RECEIVING WAREHOUSE', whSel),
        requisition ? h('p', { class: 'tiny muted' }, `${(requisition.items || []).length} lines copied from the approved requisition.`) : h('p', { class: 'tiny muted' }, 'Direct PO without lines uses catalogue products at cost — recommended path is via an approved requisition for a clean audit chain.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  /* ---------------- invoices ---------------- */
  function invView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('ledger', 15), h('span', {}, 'Recording an invoice posts to Accounts Payable (double-entry). Payment posts an AP settlement — always balanced, always audited.')),
      h('div', { class: 'card' }, table([
        { label: 'Invoice', render: r => h('div', {}, h('div', { class: 't-main mono' }, r.number), h('div', { class: 't-sub' }, r.supplier_name)) },
        { label: 'Raised', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
        { label: 'Due', render: r => h('span', { class: 'tiny', style: r.due_at && r.due_at < new Date().toISOString() && r.status !== 'PAID' ? { color: 'var(--danger)', fontWeight: 600 } : null }, r.due_at ? fmtDate(r.due_at) : '—') },
        { label: 'Amount', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.amount)) },
        { label: 'Paid', align: 'r', render: r => h('span', { class: 'num muted' }, fmtMoney(r.paid)) },
        { label: 'Status', render: r => pill(r.status) },
        { label: '', align: 'r', width: '1%', render: r => r.status !== 'PAID' && store.can('payments.payout')
          ? btn('Pay', { size: 'sm', cls: 'primary', onClick: (e) => { e.stopPropagation(); payInvoiceModal(r); } })
          : null },
      ], state.invoices, { emptyTitle: 'No supplier invoices', ico: 'ledger' })));
  }

  function payInvoiceModal(inv) {
    const method = select([{ value: 'CASH', label: 'Cash' }, { value: 'MPESA', label: 'M-Pesa (sandbox)' }, { value: 'BANK', label: 'Bank (manual)' }]);
    const submit = btn(`Pay ${fmtMoney(inv.amount - inv.paid)}`, { cls: 'primary', ico: 'payments' });
    submit.addEventListener('click', async () => {
      try {
        await api.post(`/api/v1/procurement/invoices/${inv.id}/pay`, { method: method.value });
        toast.ok('Supplier paid', `${inv.number} · ledger settled`);
        document.getElementById('overlays').replaceChildren();
        refresh();
      } catch (e) { presentError(e, 'Payment failed'); }
    });
    modal({
      title: `Pay ${inv.number}`, ico: 'payments', width: 'narrow',
      body: h('div', {}, field('METHOD', method), h('p', { class: 'tiny faint' }, 'Outbound payments are executed through the payment engine with the same verify-then-post discipline.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  function refresh() { loadAll().then(paint); }

  el.replaceChildren(
    pageHead('Procurement', 'Requisition → PO → GRN → invoice → pay'),
    tabBar, bodyEl);
  await loadAll(); paint();
}
