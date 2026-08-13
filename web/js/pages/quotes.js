/** Quotations — draft → send → accept → convert to order (no re-entry). */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, segmented, iconEl, debounce, confirmBox } from '../ui.js';
import { go } from '../router.js';

export async function render(el, ctx) {
  let status = '';
  let products = [], customers = [];
  try { [products, customers] = await Promise.all([api.get('/api/v1/products', { limit: 200 }), api.get('/api/v1/customers', { limit: 200 })]); } catch (e) { presentError(e); }

  const seg = segmented([{ value: '', label: 'All' }, { value: 'DRAFT', label: 'Draft' }, { value: 'SENT', label: 'Sent' }, { value: 'ACCEPTED', label: 'Accepted' }, { value: 'CONVERTED', label: 'Converted' }, { value: 'REJECTED', label: 'Rejected' }], status, (v) => { status = v; load(); });
  const bodyEl = h('div', {});

  async function load() {
    bodyEl.replaceChildren(h('div', { style: { padding: '16px' } }, h('div', { class: 'skel', style: { height: '240px' } })));
    let rows;
    try { rows = await api.get('/api/v1/quotes', { status: status || undefined, limit: 100 }); } catch (e) { presentError(e); return; }
    bodyEl.replaceChildren(table([
      { label: 'Quote', render: r => h('div', {}, h('div', { class: 't-main mono' }, r.number), h('div', { class: 't-sub' }, r.customer_name)) },
      { label: 'Created', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
      { label: 'Valid until', render: r => h('span', { class: `tiny${r.valid_until && r.valid_until < new Date().toISOString() && !['CONVERTED', 'REJECTED'].includes(r.status) ? '' : ''}` }, fmtDate(r.valid_until)) },
      { label: 'Total', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.total)) },
      { label: 'Status', render: r => pill(r.status) },
    ], rows, { onRow: openQuote, emptyTitle: 'No quotations', emptyMsg: 'Create a quote for a project — convert it to an order in one tap when accepted.', ico: 'quotes' }));
  }

  function openQuote(q) {
    api.get(`/api/v1/quotes/${q.id}`).then(full => drawerQuote(full)).catch(presentError);
  }

  function drawerQuote(q) {
    const actions = h('div', { class: 'row wrap' });
    const paintActions = () => {
      actions.replaceChildren();
      const can = (...p) => store.can(...p);
      if (q.status === 'DRAFT' && can('quotes.send')) actions.appendChild(btn('Send to customer', { cls: 'primary sm', ico: 'send', onClick: () => act('send', 'Quote sent + SMS queued (sandbox)') }));
      if (['SENT', 'VIEWED', 'DRAFT'].includes(q.status) && can('quotes.create')) {
        actions.appendChild(btn('Mark accepted', { cls: 'sm', ico: 'approve', onClick: () => act('accept', 'Quote accepted') }));
        actions.appendChild(btn('Reject', { cls: 'danger sm', ico: 'x', onClick: () => act('reject', 'Quote rejected') }));
      }
      if (q.status === 'ACCEPTED' && can('orders.create')) actions.appendChild(btn('Convert to order', { cls: 'primary sm', ico: 'orders', onClick: () => convert() }));
      actions.appendChild(btn('Document', { cls: 'ghost sm', ico: 'printer', onClick: () => openDoc(`/api/v1/quotes/${q.id}/document`) }));
    };
    async function act(kind, msg) {
      try {
        q = await api.post(`/api/v1/quotes/${q.id}/${kind}`, {});
        toast.ok(msg, q.number);
        paintActions(); repaintHead(); load();
      } catch (e) { presentError(e); }
    }
    async function convert() {
      try {
        const order = await api.post(`/api/v1/quotes/${q.id}/convert`, {});
        toast.ok('Order created from quote', order.number);
        document.getElementById('overlays').replaceChildren();
        go(`/orders?id=${order.id}`);
      } catch (e) { presentError(e, 'Convert failed'); }
    }
    const headEl = h('div', {});
    const repaintHead = () => {
      headEl.replaceChildren(
        h('div', { class: 'row between wrap' },
          h('div', {}, h('div', { class: 'mono strong', style: { fontSize: 'var(--fs-18)' } }, q.number), h('div', { class: 'tiny muted' }, `${q.customer_name || ''} · valid to ${fmtDate(q.valid_until)}`)),
          pill(q.status)));
    };
    repaintHead(); paintActions();
    drawer({
      title: 'Quotation', ico: 'quotes',
      body: h('div', { class: 'stack' },
        headEl,
        h('div', { class: 'card', style: { background: 'var(--bg-soft)' } },
          h('div', { class: 'card-b stack xs' },
            (q.items || []).map(it => h('div', { class: 'row between', style: { fontSize: '13px' } },
              h('span', {}, h('b', { class: 'mono' }, `${fmtNum(it.qty)}×`), ` ${it.name || it.product_name}`),
              h('span', { class: 'num' }, fmtMoney(it.total)))),
            h('hr', { class: 'divider', style: { margin: '6px 0' } }),
            h('div', { class: 'row between tiny muted' }, h('span', {}, 'Subtotal'), h('span', { class: 'num' }, fmtMoney(q.subtotal))),
            h('div', { class: 'row between tiny muted' }, h('span', {}, 'VAT'), h('span', { class: 'num' }, fmtMoney(q.tax))),
            h('div', { class: 'row between strong' }, h('span', {}, 'Total'), h('span', { class: 'num' }, fmtMoney(q.total))))),
        q.project ? h('div', { class: 'badge-soft' }, `Project: ${q.project}`) : null,
        actions,
        h('p', { class: 'tiny faint', style: { margin: 0 } }, 'Conversion copies lines into an order and reserves stock — conversion is idempotent, no double orders.')),
    });
  }

  function newQuoteModal() {
    if (!canCreate()) return;
    const custSel = select([{ value: '', label: 'Select customer…' }, ...customers.map(c => ({ value: c.id, label: `${c.name} · ${c.type}` }))]);
    const days = input({ type: 'number', value: '14', min: '1', max: '365' });
    const project = input({ placeholder: 'e.g. Kibera Phase 2' });
    const lines = new Map();
    const linesEl = h('div', { class: 'stack sm' });
    const totalEl = h('div', { class: 'strong num', style: { fontSize: 'var(--fs-18)' } }, fmtMoney(0));
    const prodSel = select([{ value: '', label: 'Add product…' }, ...products.map(p => ({ value: p.id, label: `${p.name} — ${fmtMoney(p.price_retail)} (${fmtNum((p.on_hand ?? 0) - (p.reserved ?? 0))} avail)` }))]);
    prodSel.addEventListener('change', () => {
      if (!prodSel.value) return;
      const p = products.find(x => x.id === prodSel.value);
      lines.set(p.id, { product: p, qty: 1 });
      prodSel.value = '';
      paintLines();
    });
    function paintLines() {
      let total = 0;
      linesEl.replaceChildren([...lines.values()].map(({ product, qty }) => {
        total += product.price_retail * qty;
        return h('div', { class: 'row between', style: { fontSize: '13px' } },
          h('span', { class: 'grow ellipsis' }, product.name),
          h('div', { class: 'qty-stepper' },
            h('button', { onClick: () => { const l = lines.get(product.id); l.qty--; if (l.qty <= 0) lines.delete(product.id); paintLines(); } }, '−'),
            h('span', {}, String(qty)),
            h('button', { onClick: () => { lines.get(product.id).qty++; paintLines(); } }, '+')),
          h('span', { class: 'num', style: { width: '90px', textAlign: 'right' } }, fmtMoney(product.price_retail * qty)));
      }));
      totalEl.textContent = fmtMoney(total);
    }
    const submit = btn('Create quote', { cls: 'primary', ico: 'quotes' });
    submit.addEventListener('click', async () => {
      if (!custSel.value) return toast.warn('Pick a customer');
      if (!lines.size) return toast.warn('Add at least one product');
      try {
        const q = await api.post('/api/v1/quotes', {
          customer_id: custSel.value, project: project.value || undefined, valid_days: +days.value || 14,
          items: [...lines.values()].map(({ product, qty }) => ({ product_id: product.id, qty })),
        });
        toast.ok('Quote drafted', q.number);
        document.getElementById('overlays').replaceChildren();
        load();
        openQuote(q);
      } catch (e) { presentError(e, 'Could not create quote'); }
    });
    modal({
      title: 'New quotation', ico: 'quotes', width: 'wide',
      body: h('div', {},
        h('div', { class: 'form-row' }, field('CUSTOMER', custSel), field('VALIDITY (DAYS)', days)),
        field('PROJECT (OPTIONAL)', project),
        field('PRODUCTS', prodSel),
        linesEl,
        h('div', { class: 'row between', style: { marginTop: '8px' } }, h('span', { class: 'muted' }, 'Total (VAT incl.)'), totalEl)),
      foot: h('div', { class: 'right' }, submit),
    });
  }
  const canCreate = () => store.can('quotes.create');

  async function openDoc(path) {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${store.session.token}` } });
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  }

  el.replaceChildren(
    pageHead('Quotations', 'Draft → send → accept → order',
      canCreate() ? btn('New quote', { cls: 'primary', ico: 'plus', onClick: newQuoteModal }) : null),
    seg,
    h('div', { class: 'card' }, bodyEl));
  await load();
  const id = new URLSearchParams((ctx.hash.split('?')[1] || '')).get('id');
  if (id) openQuote({ id });
}
