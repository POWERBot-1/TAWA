/** Point of Sale — fast checkout with idempotent charge + pending-payment flow. */
import { api, downloadFile } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, iconEl, toast, presentError, modal, fmtMoney, fmtNum, esc, idempotencyKey, debounce, pill, emptyState } from '../ui.js';
import { go } from '../router.js';

export async function render(el) {
  const state = {
    products: [], customers: [], categories: [],
    cat: null, q: '',
    cart: new Map(),     // product_id -> {product, qty}
    customerId: null, method: 'CASH', phone: '', deliveryFee: 0,
    busy: false, today: { orders: 0, total: 0, collected: 0 },
  };

  const [products, customers, categories, today] = await Promise.all([
    api.get('/api/v1/products', { limit: 200 }),
    api.get('/api/v1/customers', { limit: 200 }),
    api.get('/api/v1/categories'),
    api.get('/api/v1/sales/today'),
  ]);
  state.products = products; state.customers = customers; state.categories = categories; state.today = today;

  const searchEl = h('input', { class: 'input', placeholder: 'Search name, SKU or scan barcode…  (Enter adds exact match)', style: { height: '40px' } });
  const catsEl = h('div', { class: 'pos-cats' });
  const gridEl = h('div', { class: 'pos-products' });
  const cartBody = h('div', {});
  const chargeBtn = btn('Charge', { cls: 'primary lg block', ico: 'bolt' });
  const todayChip = h('span', { class: 'badge-soft mono' });

  const customerSel = h('select', { class: 'select' },
    h('option', { value: '' }, 'Walk-in customer'),
    customers.map(c => h('option', { value: c.id }, `${c.name} · ${c.phone || c.code || ''}`)));
  customerSel.addEventListener('change', () => { state.customerId = customerSel.value || null; });

  const methods = [
    { id: 'CASH', label: 'Cash', ico: 'cash' },
    { id: 'MPESA', label: 'M-Pesa', ico: 'smartphone' },
    { id: 'CARD', label: 'Card', ico: 'card' },
    { id: 'BANK', label: 'Bank', ico: 'bank' },
  ];
  const methodEl = h('div', { class: 'pay-methods', style: { gridTemplateColumns: 'repeat(4,1fr)' } },
    methods.map(m => h('button', { class: `pay-m${m.id === state.method ? ' on' : ''}`, dataset: { m: m.id }, onClick: () => { state.method = m.id; paintMethod(); paintCart(); } }, iconEl(m.ico, 18), m.label)));
  function paintMethod() {
    methodEl.querySelectorAll('.pay-m').forEach(b => b.classList.toggle('on', b.dataset.m === state.method));
    phoneRow.style.display = state.method === 'MPESA' ? '' : 'none';
  }
  const phoneEl = h('input', { class: 'input mono', placeholder: 'M-Pesa phone e.g. 0712 345 678' });
  phoneEl.addEventListener('input', () => { state.phone = phoneEl.value; });
  const phoneRow = h('div', { style: { display: 'none' } }, phoneEl);

  const feeEl = h('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '0.00', style: { width: '120px' } });
  feeEl.addEventListener('input', () => { state.deliveryFee = Math.max(0, Number(feeEl.value) || 0); paintCart(); });

  /* ---------- left side: catalogue ---------- */
  function paintCats() {
    catsEl.replaceChildren(
      h('button', { class: `pos-cat${!state.cat ? ' on' : ''}`, onClick: () => { state.cat = null; paintCats(); paintGrid(); } }, 'All'),
      state.categories.map(c => h('button', { class: `pos-cat${state.cat === c.id ? ' on' : ''}`, onClick: () => { state.cat = c.id; paintCats(); paintGrid(); } }, c.name)));
  }
  function filtered() {
    const q = state.q.toLowerCase();
    return state.products.filter(p =>
      (!state.cat || p.category_id === state.cat) &&
      (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode || '').includes(q)));
  }
  function paintGrid() {
    const list = filtered();
    if (!list.length) {
      gridEl.replaceChildren(emptyState('No products match', 'Try a different search or category.', 'search'));
      return;
    }
    gridEl.replaceChildren(list.slice(0, 60).map(p => {
      const available = (p.on_hand ?? 0) - (p.reserved ?? 0);
      const low = available <= 0;
      return h('button', { class: 'pos-tile', onClick: () => addToCart(p, 1), disabled: low ? true : null, title: low ? 'Out of stock' : 'Tap to add' },
        h('span', { class: `p-stock${available <= (p.reorder_point || 0) ? ' low' : ''}` }, fmtNum(available)),
        h('span', { class: 'p-name' }, p.name),
        h('span', { class: 'p-sku' }, p.sku),
        h('span', { class: 'p-price' }, fmtMoney(p.price_retail)));
    }));
  }
  searchEl.addEventListener('input', debounce(() => { state.q = searchEl.value.trim(); paintGrid(); }, 120));
  searchEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = searchEl.value.trim().toLowerCase();
    const exact = state.products.find(p => p.barcode === q || p.sku.toLowerCase() === q);
    if (exact) { addToCart(exact, 1); searchEl.select(); }
    else { const f = filtered(); if (f.length === 1) { addToCart(f[0], 1); searchEl.select(); } }
  });

  /* ---------- cart ---------- */
  function addToCart(p, qty) {
    const available = (p.on_hand ?? 0) - (p.reserved ?? 0);
    const cur = state.cart.get(p.id) || { product: p, qty: 0 };
    if (cur.qty + qty > available) { toast.warn('Stock limit', `Only ${fmtNum(available)} ${p.unit} available for ${p.name}`); return; }
    cur.qty += qty;
    state.cart.set(p.id, cur);
    paintCart();
  }
  function setQty(id, qty) {
    const line = state.cart.get(id);
    if (!line) return;
    const available = (line.product.on_hand ?? 0) - (line.product.reserved ?? 0);
    if (qty <= 0) state.cart.delete(id);
    else if (qty > available) { toast.warn('Stock limit', `Only ${fmtNum(available)} available`); return; }
    else line.qty = qty;
    paintCart();
  }
  function totals() {
    let subtotal = 0, tax = 0;
    for (const { product, qty } of state.cart.values()) {
      const line = product.price_retail * qty;
      subtotal += line;
      if (product.tax_category === 'VAT16') tax += Math.round(line * 16 / 116); // VAT-inclusive pricing
    }
    const fee = Math.round(state.deliveryFee * 100);
    return { subtotal, tax, fee, total: subtotal + fee };
  }
  function paintCart() {
    const t = totals();
    const lines = [...state.cart.values()];
    cartBody.replaceChildren(
      h('div', { class: 'cart-lines' },
        lines.length ? lines.map(({ product, qty }) => h('div', { class: 'cart-line' },
          h('div', {},
            h('div', { class: 'c-name' }, product.name),
            h('div', { class: 'c-unit' }, `${fmtMoney(product.price_retail)} / ${product.unit}`),
            h('button', { class: 'c-rm', onClick: () => { state.cart.delete(product.id); paintCart(); } }, 'remove')),
          h('div', { class: 'c-right' },
            h('div', { class: 'c-total' }, fmtMoney(product.price_retail * qty)),
            h('div', { class: 'qty-stepper', style: { marginTop: '6px' } },
              h('button', { onClick: () => setQty(product.id, qty - 1) }, '−'),
              h('span', {}, String(qty)),
              h('button', { onClick: () => setQty(product.id, qty + 1) }, '+'))))) :
          h('div', { class: 'empty', style: { padding: '26px 16px' } },
            h('div', { class: 'e-ico' }, iconEl('cart', 22)),
            h('div', { class: 'e-title' }, 'Cart is empty'),
            h('div', { class: 'e-msg' }, 'Tap a product tile to begin a sale.'))),
      h('div', { style: { padding: '12px 16px 16px' } },
        h('div', { class: 'cart-total-row' }, h('span', {}, 'Subtotal'), h('span', { class: 'num' }, fmtMoney(t.subtotal))),
        h('div', { class: 'cart-total-row tiny' }, h('span', {}, 'VAT (included)'), h('span', { class: 'num' }, fmtMoney(t.tax))),
        h('div', { class: 'cart-total-row' }, h('span', {}, 'Delivery fee'), feeEl),
        h('div', { class: 'cart-total-row grand' }, h('span', {}, 'Total'), h('span', { class: 'num' }, fmtMoney(t.total))),
        h('div', { style: { marginTop: '10px', display: 'grid', gap: '8px' } },
          phoneRow,
          chargeBtn)));

    chargeBtn.disabled = !lines.length || state.busy;
    chargeBtn.replaceChildren(...(state.busy
      ? [iconEl('refresh', 15, 2.2), ' Processing…']
      : [iconEl('bolt', 15, 2.4), ` Charge ${fmtMoney(t.total)}`]));
    chargeBtn.classList.toggle('busy', state.busy);
  }

  chargeBtn.addEventListener('click', async () => {
    if (!state.cart.size || state.busy) return;
    state.busy = true; paintCart();
    let result;
    try {
      result = await api.post('/api/v1/pos/sale', {
        idempotency_key: idempotencyKey(),
        customer_id: state.customerId,
        method: state.method,
        phone: state.phone || undefined,
        delivery_fee: state.deliveryFee || undefined,
        items: [...state.cart.values()].map(({ product, qty }) => ({ product_id: product.id, qty })),
      });
    } catch (e) {
      state.busy = false; paintCart();
      if (e?.details?.shortfall) {
        presentError(e, 'Insufficient stock');
      } else presentError(e, 'Sale failed');
      return;
    }
    state.busy = false; paintCart();
    if (result.pending || result.intent_id && !result.payment) return pendingFlow(result);
    return successReceipt(result);
  });

  /* ---------- pending (M-Pesa / card sandbox) ---------- */
  async function pendingFlow(result) {
    const order = result.order;
    let statusEl, simulateEl;
    const checkBtn = btn('Check status', { cls: 'primary', ico: 'refresh' });
    body();
    function body() {
      statusEl = h('div', { class: 'pill warn' }, h('span', { class: 'pdot' }), 'AWAITING CUSTOMER');
      simulateEl = h('div', { class: 'card', style: { borderStyle: 'dashed' } },
        h('div', { class: 'card-b stack sm' },
          h('div', { class: 'row' }, h('span', { class: 'sandbox-tag' }, 'SANDBOX CONSOLE'), h('span', { class: 'tiny faint' }, 'simulates the customer phone')),
          h('div', { class: 'row' },
            btn('Customer approves', { cls: 'sm primary', ico: 'approve', onClick: () => simulate('SUCCESS') }),
            btn('Customer cancels', { cls: 'sm danger', ico: 'x', onClick: () => simulate('FAILED') }))));
    }
    async function simulate(outcome) {
      try {
        const intents = await api.get('/api/v1/payments/intents', { limit: 10 });
        const intent = intents.find(i => i.id === result.intent_id);
        if (!intent?.provider_ref) throw new Error('provider ref missing');
        await api.sandbox('/api/v1/sandbox/mpesa/outcome', { provider_ref: intent.provider_ref, outcome });
        toast.info('Sandbox outcome recorded', 'TAWA will still verify server-side.');
        await check();
      } catch (e) { presentError(e, 'Sandbox simulation failed'); }
    }
    async function check() {
      try {
        const settled = await api.post('/api/v1/pos/complete', { intent_id: result.intent_id });
        if (settled.processing || settled.intent?.status === 'PROCESSING' || settled.intent?.status === 'REQUIRES_ACTION') {
          statusEl.className = 'pill warn'; statusEl.replaceChildren(h('span', { class: 'pdot' }), 'AWAITING CUSTOMER');
          toast.warn('Still pending', 'The provider has not confirmed yet.');
          return;
        }
        close();
        const fresh = await api.get(`/api/v1/orders/${order.id}`);
        if (fresh.payment_status === 'PAID') return successReceipt({ order: fresh, payment: settled.payment, receipt_no: settled.payment?.reference });
        state.q = '';
        toast.err('Payment failed', 'The order remains pending — collect payment again from Orders.');
        go('/orders');
      } catch (e) { presentError(e, 'Status check failed'); }
    }
    checkBtn.addEventListener('click', check);
    const close = modal({
      title: 'Awaiting customer payment', sub: `${order.number} · ${fmtMoney(order.total)} · ${state.method}`, ico: 'smartphone',
      body: h('div', { class: 'stack' },
        h('div', { class: 'row' }, statusEl, h('span', { class: 'tiny muted' }, 'STK push sent to the customer phone')),
        h('p', { class: 'tiny muted', style: { margin: 0 } }, 'TAWA never assumes success — it verifies the provider record server-side before posting the payment.'),
        simulateEl),
      foot: h('div', { class: 'right' }, checkBtn),
    });
  }

  /* ---------- success receipt ---------- */
  async function successReceipt(result) {
    const order = result.order;
    state.cart.clear(); state.deliveryFee = 0; feeEl.value = ''; state.customerId = null; customerSel.value = '';
    paintCart(); paintToday();
    const receiptNo = result.receipt_no || result.payment?.reference;
    modal({
      title: 'Payment settled', sub: receiptNo ? `Receipt ${receiptNo}` : undefined, ico: 'approve',
      body: h('div', { class: 'stack' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } },
          h('div', {}, h('div', { class: 'ph-t', style: { fontSize: 'var(--fs-28)' } }, fmtMoney(order.total)), h('div', { class: 'tiny muted' }, `${order.number} · ${state.method}`)),
          pill('PAID')),
        h('div', { class: 'card', style: { background: 'var(--bg-soft)' } },
          h('div', { class: 'card-b stack xs' },
            (order.items || []).map(it => h('div', { class: 'row between', style: { fontSize: '13px' } },
              h('span', {}, h('b', { class: 'mono' }, `${fmtNum(it.qty)}×`), ` ${it.name || it.product_name}`),
              h('span', { class: 'num' }, fmtMoney(it.total)))),
            h('hr', { class: 'divider', style: { margin: '6px 0' } }),
            h('div', { class: 'row between tiny muted' }, h('span', {}, 'VAT (incl.)'), h('span', { class: 'num' }, fmtMoney(order.tax))))),
        h('div', { class: 'tiny faint' }, 'Ledger posted · stock moved · audit recorded. The same idempotency key replays this exact receipt.'),
      ),
      foot: h('div', { class: 'right' },
        result.payment?.id ? btn('Print receipt', { ico: 'printer', onClick: () => printReceipt(result.payment.id) }) : null,
        btn('New sale', { cls: 'primary', ico: 'plus', onClick: () => { closeAll(); searchEl.focus(); } })),
    });
    function closeAll() { document.getElementById('overlays').replaceChildren(); }
  }

  async function printReceipt(paymentId) {
    try {
      const res = await fetch(`/api/v1/receipts/${paymentId}`, { headers: { Authorization: `Bearer ${store.session.token}` } });
      if (!res.ok) throw new Error('receipt unavailable');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      if (!w) toast.warn('Popup blocked', 'Allow popups to print receipts.');
    } catch (e) { presentError(e, 'Print failed'); }
  }

  async function paintToday() {
    try {
      const t = await api.get('/api/v1/sales/today');
      todayChip.replaceChildren(iconEl('trend', 12), `TODAY ${fmtNum(t.orders)} SALES · ${fmtMoney(t.collected)}`);
    } catch { /* noop */ }
  }

  /* ---------- layout ---------- */
  paintCats(); paintGrid(); paintCart(); paintMethod(); paintToday();

  el.replaceChildren(
    pageHead('Point of Sale', `${state.products.length} products ready`, todayChip,
      btn('Orders', { cls: '', ico: 'orders', onClick: () => go('/orders') })),
    h('div', { class: 'pos-grid' },
      h('div', { class: 'stack' },
        card({ body: h('div', { class: 'stack' }, h('div', { class: 'input-group' }, h('span', { class: 'ig-ico' }, iconEl('scan', 16)), searchEl), catsEl), cls: '' }),
        gridEl),
      h('div', { class: 'card cart' },
        h('div', { class: 'card-h' }, h('div', { class: 'grow' }, h('h3', {}, 'Current sale'), h('div', { class: 'h-sub' }, 'Customer')), customerSel),
        cartBody)));

  searchEl.focus();
  return () => { state.cart.clear(); };
}
