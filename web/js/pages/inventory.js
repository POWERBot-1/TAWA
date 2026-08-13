/** Inventory — levels, immutable movement ledger, valuation, warehouses, actions. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtNum, toast, presentError, modal, field, input, select, tabs, kv, iconEl, debounce, idempotencyKey } from '../ui.js';

export async function render(el, ctx) {
  const state = { tab: 'levels', warehouses: [], products: [], levels: [], movements: [], valuation: null, q: '' };

  const [warehouses, products, valuation] = await Promise.all([
    api.get('/api/v1/warehouses'), api.get('/api/v1/products', { limit: 200 }), api.get('/api/v1/inventory/valuation').catch(() => null),
  ]);
  state.warehouses = warehouses; state.products = products; state.valuation = valuation;

  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  const canAct = store.can('inventory.adjust', 'inventory.receive', 'inventory.transfer');

  async function loadTab() {
    if (state.tab === 'levels') state.levels = await api.get('/api/v1/inventory/levels', { warehouse_id: undefined });
    if (state.tab === 'movements') state.movements = await api.get('/api/v1/inventory/movements', { limit: 100 });
    if (state.tab === 'valuation') state.valuation = await api.get('/api/v1/inventory/valuation');
    if (state.tab === 'warehouses') state.warehouses = await api.get('/api/v1/warehouses');
  }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'levels', label: 'Stock levels' },
      { id: 'movements', label: 'Movements (immutable)' },
      { id: 'valuation', label: 'Valuation' },
      { id: 'warehouses', label: 'Warehouses' },
    ], state.tab, async (t) => { state.tab = t; bodyEl.replaceChildren(loading()); await loadTab(); paint(); }));
    bodyEl.replaceChildren(viewFor());
  }

  const loading = () => h('div', { class: 'card' }, h('div', { style: { padding: '16px' } }, h('div', { class: 'skel', style: { height: '260px' } })));

  function viewFor() {
    if (state.tab === 'levels') return levelsView();
    if (state.tab === 'movements') return movementsView();
    if (state.tab === 'valuation') return valuationView();
    return warehousesView();
  }

  function levelsView() {
    const q = state.q.toLowerCase();
    // aggregate across warehouses per product
    const byProduct = new Map();
    for (const l of state.levels) {
      const cur = byProduct.get(l.product_id) || { ...l, on_hand: 0, reserved: 0, damaged: 0, wh: [] };
      cur.on_hand += l.on_hand; cur.reserved += l.reserved; cur.damaged += l.damaged;
      cur.wh.push(`${l.warehouse_name}: ${fmtNum(l.on_hand)}`);
      byProduct.set(l.product_id, cur);
    }
    let list = [...byProduct.values()];
    if (q) list = list.filter(l => (l.product_name + l.sku).toLowerCase().includes(q));
    const search = input({ placeholder: 'Filter products…', value: state.q, onInput: debounce(e => { state.q = e.target.value; paint(); }, 150) });
    const lowOnly = list.filter(l => l.reorder_point > 0 && (l.on_hand - l.reserved) <= l.reorder_point);
    return h('div', { class: 'stack' },
      h('div', { class: 'grid c3' },
        statCard('SKUs tracked', fmtNum(list.length), 'inventory'),
        statCard('Units on hand', fmtNum(list.reduce((s, l) => s + l.on_hand, 0)), 'box'),
        statCard('At/below reorder', String(lowOnly.length), 'warning', lowOnly.length ? 'var(--warn)' : 'var(--ok)')),
      h('div', { class: 'row wrap', style: { gap: '10px' } },
        h('div', { class: 'input-group', style: { maxWidth: '280px', flex: '1' } }, h('span', { class: 'ig-ico' }, iconEl('search', 15)), search),
        canAct ? btn('Receive stock', { ico: 'inbox', onClick: () => actionModal('receive') }) : null,
        canAct ? btn('Adjust', { ico: 'edit', onClick: () => actionModal('adjust') }) : null,
        canAct && store.has('TAWA.ADVANCED_INVENTORY') ? btn('Transfer', { ico: 'transfer', onClick: () => actionModal('transfer') }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Product', render: r => h('div', {}, h('div', { class: 't-main' }, r.product_name), h('div', { class: 't-sub mono' }, r.sku)) },
        { label: 'Location breakdown', render: r => h('span', { class: 'tiny muted' }, r.wh.join('  ·  ')) },
        { label: 'On hand', align: 'r', render: r => h('span', { class: 'num strong' }, fmtNum(r.on_hand)) },
        { label: 'Reserved', align: 'r', render: r => h('span', { class: 'num muted' }, fmtNum(r.reserved)) },
        { label: 'Available', align: 'r', render: r => {
            const a = r.on_hand - r.reserved;
            return h('span', { class: 'num strong', style: { color: a <= 0 ? 'var(--danger)' : a <= (r.reorder_point || 0) ? 'var(--warn)' : 'var(--ok)' } }, fmtNum(a));
          } },
        { label: 'Reorder pt', align: 'r', render: r => h('span', { class: 'num tiny muted' }, fmtNum(r.reorder_point)) },
        { label: 'Value (cost)', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.on_hand * (r.cost_price || 0))) },
      ], list, { emptyTitle: 'No stock records', emptyMsg: 'Receive stock against a purchase order or use Receive stock.', ico: 'inventory' })));
  }

  function movementsView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('shield-check', 15), h('span', {}, 'Movements are append-only — database triggers reject UPDATE/DELETE. Corrections happen as new signed movements.')),
      h('div', { class: 'card' }, table([
        { label: 'When', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
        { label: 'Product', render: r => h('div', {}, h('div', { class: 't-main' }, r.product_name), h('div', { class: 't-sub mono' }, r.sku)) },
        { label: 'Warehouse', render: r => h('span', { class: 'tiny' }, r.warehouse_name) },
        { label: 'Type', render: r => h('span', { class: `badge-soft mono` }, r.type) },
        { label: 'Qty', align: 'r', render: r => h('span', { class: 'num strong', style: { color: r.qty < 0 ? 'var(--danger)' : 'var(--ok)' } }, `${r.qty > 0 ? '+' : ''}${fmtNum(r.qty)}`) },
        { label: 'Balance after', align: 'r', render: r => h('span', { class: 'num muted' }, fmtNum(r.balance_after)) },
        { label: 'Reason / ref', render: r => h('span', { class: 'tiny muted' }, r.reason || r.ref_type || '—') },
      ], state.movements, { emptyTitle: 'No movements yet', ico: 'history' })));
  }

  function valuationView() {
    const v = state.valuation;
    if (!v) return h('div', { class: 'card' }, h('div', { class: 'card-b faint' }, 'Valuation unavailable with your role.'));
    const rows = [];
    return h('div', { class: 'stack' },
      h('div', { class: 'grid c3' },
        statCard('Cost value', fmtMoney(v.cost_value ?? v.total_cost), 'scale'),
        statCard('Retail value', fmtMoney(v.retail_value ?? v.total_retail), 'trend'),
        statCard('Potential margin', fmtMoney((v.retail_value ?? v.total_retail ?? 0) - (v.cost_value ?? v.total_cost ?? 0)), 'percent', 'var(--ok)')),
      h('div', { class: 'card' }, h('div', { class: 'card-b' },
        kv([['SKUs in stock', fmtNum(v.products ?? 0)],
            ['Margin if all sold at retail', fmtMoney((v.retail_value ?? 0) - (v.cost_value ?? 0))],
            ['Note', 'Receipt movements and the double-entry ledger always agree — see Accounting.']]))));
  }

  function warehousesView() {
    return h('div', { class: 'stack' },
      store.can('branches.manage', 'settings.manage') ? h('div', { class: 'row end' }, btn('New warehouse', { cls: 'primary', ico: 'plus', onClick: warehouseModal })) : null,
      h('div', { class: 'card' }, table([
        { label: 'Code', render: r => h('span', { class: 'mono badge-soft' }, r.code) },
        { label: 'Name', render: r => h('span', { class: 't-main' }, r.name) },
        { label: 'Branch', render: r => h('span', { class: 'tiny muted' }, r.branch_name || '—') },
        { label: 'SKUs in stock', align: 'r', render: r => h('span', { class: 'num' }, fmtNum(r.stocked_products ?? 0)) },
        { label: 'Status', render: r => pill(r.is_active ? 'ACTIVE' : 'DISABLED') },
      ], state.warehouses, { emptyTitle: 'No warehouses', ico: 'inventory' })));
  }

  function warehouseModal() {
    const name = input({ placeholder: 'e.g. Ruiru Yard' });
    const code = input({ placeholder: 'YARD-01' });
    const submit = btn('Create', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      try {
        await api.post('/api/v1/warehouses', { name: name.value, code: code.value });
        toast.ok('Warehouse added'); document.getElementById('overlays').replaceChildren();
        state.warehouses = await api.get('/api/v1/warehouses'); paint();
      } catch (e) { presentError(e); }
    });
    modal({ title: 'New warehouse', ico: 'inventory', width: 'narrow', body: h('div', {}, field('NAME', name), field('CODE', code)), foot: h('div', { class: 'right' }, submit) });
  }

  /* ------------- receive / adjust / transfer ------------- */
  function actionModal(kind) {
    const wh = select(state.warehouses.map(w => ({ value: w.id, label: w.name })));
    const wh2 = kind === 'transfer' ? select(state.warehouses.map(w => ({ value: w.id, label: w.name })), { value: state.warehouses[1]?.id }) : null;
    const prodSearch = input({ placeholder: 'Search product to add…' });
    const listEl = h('div', { class: 'stack sm' });
    const lines = new Map();
    const reason = input({ placeholder: kind === 'adjust' ? 'e.g. damages, count correction, promotion usage' : 'e.g. GRN PO-000012 / supplier drop' });
    const typeSel = kind === 'adjust' ? select([
      { value: 'ADJUST', label: 'Correction (signed qty)' }, { value: 'DAMAGE', label: 'Damage (reduces stock)' }, { value: 'RETURN', label: 'Customer return (adds stock)' }, { value: 'COUNT', label: 'Stock count (sets level)' },
    ]) : null;

    prodSearch.addEventListener('input', debounce(() => {
      const q = prodSearch.value.toLowerCase();
      listEl.replaceChildren(
        h('div', { class: 'stack xs', style: { maxHeight: '200px', overflowY: 'auto' } },
          state.products.filter(p => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)).slice(0, 6).map(p =>
            h('button', { class: 'tenant-opt', style: { padding: '8px 10px' }, onClick: () => { if (!lines.has(p.id)) { lines.set(p.id, { product: p, qty: 1 }); prodSearch.value = ''; paintLines(); } } },
              h('span', { class: 'icon-btn', style: { width: '26px', height: '26px' } }, iconEl('plus', 13)),
              h('span', { class: 'grow ellipsis', style: { fontSize: '13px' } }, `${p.name} `, h('span', { class: 'mono tiny faint' }, p.sku)),
              h('span', { class: 'tiny muted mono' }, `${fmtNum((p.on_hand ?? 0) - (p.reserved ?? 0))} ${p.unit}`)))));
    }, 120));

    const linesEl = h('div', { class: 'stack sm' }, h('div', { class: 'faint tiny' }, 'No items yet'));
    function paintLines() {
      linesEl.replaceChildren([...lines.values()].length ? [...lines.values()].map(({ product, qty }) =>
        h('div', { class: 'row between' },
          h('span', { class: 'grow ellipsis', style: { fontSize: '13px' } }, product.name),
          h('input', { class: 'input mono', type: 'number', style: { width: '90px', height: '28px' }, value: String(qty), onChange: (e) => { lines.get(product.id).qty = Number(e.target.value); } }),
          h('button', { class: 'icon-btn', style: { width: '26px', height: '26px' }, onClick: () => { lines.delete(product.id); paintLines(); } }, iconEl('x', 13)))) : [h('div', { class: 'faint tiny' }, 'No items yet')]);
    }

    const submit = btn(kind === 'receive' ? 'Receive into stock' : kind === 'adjust' ? 'Post adjustment' : 'Transfer', { cls: 'primary', ico: 'approve' });
    submit.addEventListener('click', async () => {
      if (!lines.size) return toast.warn('Add at least one item');
      try {
        if (kind === 'receive') {
          await api.post('/api/v1/inventory/receive', { warehouse_id: wh.value, reason: reason.value || 'manual receive', items: items((q) => Math.abs(q)) });
        } else if (kind === 'adjust') {
          const type = typeSel.value;
          await api.post('/api/v1/inventory/adjust', { warehouse_id: wh.value, type, reason: reason.value || type.toLowerCase(), items: items((q) => type === 'DAMAGE' ? -Math.abs(q) : type === 'RETURN' ? Math.abs(q) : q, type) });
        } else {
          await api.post('/api/v1/inventory/transfer', { from_warehouse_id: wh.value, to_warehouse_id: wh2.value, reason: reason.value || 'rebalance', items: items((q) => Math.abs(q)) });
        }
        toast.ok('Stock updated', 'Movement appended to the immutable ledger.');
        document.getElementById('overlays').replaceChildren();
        await loadTab(); paint();
      } catch (e) { presentError(e, 'Stock update failed'); }
    });
    // COUNT semantics: qty = the counted physical level; server derives the signed delta.
    const items = (mapQty, type) => [...lines.values()].map(({ product, qty }) =>
      ({ product_id: product.id, qty: type === 'COUNT' ? Math.max(0, qty) : mapQty(qty) }));

    modal({
      title: kind === 'receive' ? 'Receive stock' : kind === 'adjust' ? 'Stock adjustment' : 'Inter-warehouse transfer',
      ico: kind === 'transfer' ? 'transfer' : 'inventory', width: 'wide',
      body: h('div', {},
        h('div', { class: 'form-row' },
          field(kind === 'transfer' ? 'FROM WAREHOUSE' : 'WAREHOUSE', wh),
          kind === 'transfer' ? field('TO WAREHOUSE', wh2) : (typeSel ? field('TYPE', typeSel) : field(' ', h('div')))),
        field('REASON', reason, { hint: 'Required for audit significance.' }),
        field('ITEMS', prodSearch), listEl, h('hr', { class: 'divider' }), linesEl,
        typeSel ? h('p', { class: 'tiny faint' }, 'Damage always subtracts; returns always add; corrections take the sign of the quantity; counts SET the level.') : null),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  function statCard(label, value, ico, color) {
    return h('div', { class: 'card kpi' },
      h('div', { class: 'k-label' }, iconEl(ico, 13, 2), label),
      h('div', { class: 'k-value num', style: color ? { color } : null }, value));
  }

  el.replaceChildren(pageHead('Inventory', 'Immutably tracked stock, valued live'), tabBar, bodyEl);
  await loadTab(); paint();
}
