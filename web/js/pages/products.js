/** Products — catalogue with pricing tiers, stock position, relations & synonyms. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, timeAgo, toast, presentError, drawer, modal, field, input, select, textarea, kv, iconEl, debounce, barList } from '../ui.js';

export async function render(el, ctx) {
  let rows = [], categories = [], meta = {};
  let q = '', cat = '';

  const searchEl = input({ placeholder: 'Search name, SKU, barcode, brand…' });
  searchEl.addEventListener('input', debounce(() => { q = searchEl.value; load(); }, 200));
  const catSel = select([{ value: '', label: 'All categories' }], {});
  catSel.addEventListener('change', () => { cat = catSel.value; load(); });
  const bodyEl = h('div', {});
  const footEl = h('div', { class: 'tbl-foot' });

  categories = await api.get('/api/v1/categories');
  catSel.replaceChildren(h('option', { value: '' }, 'All categories'), categories.map(c => h('option', { value: c.id }, `${c.name} (${c.product_count})`)));

  async function load() {
    try {
      const res = await fetchList([]);
      paint();
    } catch (e) { presentError(e, 'Products failed to load'); }
  }
  async function fetchList() {
    const data = await api.get('/api/v1/products', { q: q || undefined, category_id: cat || undefined, limit: 200 });
    rows = data;
    return data;
  }
  function paint() {
    bodyEl.replaceChildren(table([
      { label: 'Product', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub' }, h('span', { class: 'mono' }, r.sku), r.brand ? ` · ${r.brand}` : '')) },
      { label: 'Category', render: r => h('span', { class: 'badge-soft' }, r.category_name || '—') },
      { label: 'Stock', align: 'r', render: r => {
          const avail = (r.on_hand ?? 0) - (r.reserved ?? 0);
          return h('div', {}, h('div', { class: `num strong${avail <= 0 ? '' : ''}`, style: avail <= 0 ? { color: 'var(--danger)' } : avail <= (r.reorder_point || 0) ? { color: 'var(--warn)' } : null }, fmtNum(avail)), r.reserved ? h('div', { class: 't-sub' }, `${fmtNum(r.reserved)} reserved`) : null);
        } },
      { label: 'Cost', align: 'r', render: r => h('span', { class: 'num muted' }, fmtMoney(r.cost_price)) },
      { label: 'Retail', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.price_retail)) },
      { label: 'Margin', align: 'r', render: r => {
          const m = r.price_retail - r.cost_price;
          const pct = r.price_retail ? Math.round((m / r.price_retail) * 100) : 0;
          return h('span', { class: `num tiny ${pct < 10 ? '' : ''}`, style: { color: pct < 10 ? 'var(--danger)' : 'var(--ok)' } }, `${pct}%`);
        } },
      { label: 'Unit', render: r => h('span', { class: 'tiny mono muted' }, r.unit) },
    ], rows, { onRow: openProduct, emptyTitle: q ? `No products matching “${q}”` : 'Catalogue is empty', emptyMsg: 'Try the synonym search — “mabati”, “chuma”, “simuu” all resolve.', ico: 'products' }));
    footEl.replaceChildren(h('span', {}, `${rows.length} products`));
  }

  async function openProduct(p) {
    let full;
    try { full = await api.get(`/api/v1/products/${p.id}`); } catch (e) { return presentError(e); }
    const stockRows = full.stock || [];
    const rec = full.recommendations || {};
    const rel = rec.relations || rec;
    let relations = [];
    try { relations = await api.get(`/api/v1/products/${p.id}/relations`); } catch { /* optional */ }
    const bodyEl = h('div', { class: 'stack' },
      h('div', { class: 'row between wrap' },
        h('div', {}, h('div', { class: 'strong', style: { fontSize: 'var(--fs-18)' } }, full.name),
          h('div', { class: 'tiny muted mono' }, `${full.sku}${full.barcode ? ' · ' + full.barcode : ''} · ${full.category_name || 'uncategorised'}`)),
        pill(full.is_active ? 'ACTIVE' : 'DISABLED')),
      card({ title: 'Pricing ladder', body: kv([
        ['Retail', fmtMoney(full.price_retail)],
        ['Wholesale', full.price_wholesale ? fmtMoney(full.price_wholesale) : '—'],
        ['Contractor', full.price_contractor ? fmtMoney(full.price_contractor) : '—'],
        ['Minimum (floor)', full.price_min ? fmtMoney(full.price_min) : '—'],
        ['Cost', fmtMoney(full.cost_price)],
        ['Tax', full.tax_category === 'VAT16' ? 'VAT 16% (inclusive)' : full.tax_category || '—'],
        ['Reorder point', fmtNum(full.reorder_point)],
        ['Supplier', full.supplier_name || '—'],
      ]) }),
      stockRows.length ? card({
        title: 'Stock by warehouse', flush: true,
        body: table([
          { label: 'Warehouse', render: r => h('span', { class: 't-main' }, r.warehouse_name) },
          { label: 'On hand', align: 'r', render: r => h('span', { class: 'num strong' }, fmtNum(r.on_hand)) },
          { label: 'Reserved', align: 'r', render: r => h('span', { class: 'num muted' }, fmtNum(r.reserved)) },
          { label: 'Damaged', align: 'r', render: r => h('span', { class: 'num', style: r.damaged ? { color: 'var(--danger)' } : null }, fmtNum(r.damaged)) },
        ], stockRows),
      }) : null,
      relations?.length ? card({
        title: 'Selling graph', sub: 'Often needed together / substitutes',
        body: h('div', { class: 'stack sm' }, relations.map(r => h('div', { class: 'row between' },
          h('span', { class: 'badge-soft' }, r.kind || r.type),
          h('span', { class: 'grow ellipsis' }, r.name || r.related_name),
          store.can('pos.use') ? btn('Sell', { size: 'sm', onClick: () => { } }) : null))),
      }) : null,
      rec?.insights?.length ? card({ title: 'AI read on this product', body: h('div', { class: 'stack xs' }, rec.insights.map(i => h('div', { class: 'row', style: { gap: '8px' } }, iconEl('ai', 14), h('span', { class: 'tiny' }, i)))) }) : null,
      (full.movements || []).length ? card({
        title: 'Latest movements', flush: true,
        body: table([
          { label: 'When', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
          { label: 'Type', render: r => h('span', { class: 'badge-soft mono' }, r.type) },
          { label: 'Qty', align: 'r', render: r => h('span', { class: 'num', style: { color: r.qty < 0 ? 'var(--danger)' : 'var(--ok)' } }, `${r.qty > 0 ? '+' : ''}${fmtNum(r.qty)}`) },
          { label: 'Ref', render: r => h('span', { class: 'tiny mono muted' }, r.ref_type || '—') },
        ], full.movements.slice(0, 8)),
      }) : null,
    );
    drawer({ title: 'Product detail', ico: 'products', body: bodyEl });
  }

  function newProduct() {
    const name = input({ placeholder: 'e.g. Y12 Twisted Bar 12m' });
    const sku = input({ placeholder: 'STE-BAR-Y12' });
    const cat = select([{ value: '', label: '— category —' }, ...categories.map(c => ({ value: c.id, label: c.name }))]);
    const unit = select(['piece', 'bag', 'box', 'packet', 'roll', 'meter', 'kg', 'litre', 'set', 'carton', 'bundle', 'sheet', 'length', 'drum']);
    const cost = input({ type: 'number', step: '0.01', min: '0', placeholder: '0.00' });
    const retail = input({ type: 'number', step: '0.01', min: '0', placeholder: '0.00' });
    const reorder = input({ type: 'number', min: '0', value: '0' });
    const barcode = input({ placeholder: 'optional' });
    const submit = btn('Create product', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      const bad = !name.value.trim() && 'Name required' || !sku.value.trim() && 'SKU required' || !(+cost.value >= 0) && 'Cost invalid' || !(+retail.value > 0) && 'Retail price invalid';
      if (bad) return toast.warn(bad);
      try {
        await api.post('/api/v1/products', {
          name: name.value.trim(), sku: sku.value.trim().toUpperCase(), category_id: cat.value || undefined, unit: unit.value,
          cost_price: +cost.value, price_retail: +retail.value, reorder_point: +reorder.value || 0, barcode: barcode.value || undefined,
        });
        toast.ok('Product created', name.value.trim());
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e, 'Create failed'); }
    });
    modal({
      title: 'New product', ico: 'products', width: 'wide',
      body: h('div', {},
        h('div', { class: 'form-row' }, field('NAME', name), field('SKU', sku)),
        h('div', { class: 'form-row' }, field('CATEGORY', cat), field('UNIT', unit)),
        h('div', { class: 'form-row' }, field('COST PRICE (KES)', cost), field('RETAIL PRICE (KES)', retail)),
        h('div', { class: 'form-row' }, field('REORDER POINT', reorder), field('BARCODE', barcode)),
        h('p', { class: 'tiny faint' }, 'VAT-inclusive retail pricing (16%). Wholesale/contractor tiers can be set after creation.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(
    pageHead('Products', 'Catalogue, pricing & selling graph',
      store.can('catalog.manage') ? btn('New product', { cls: 'primary', ico: 'plus', onClick: newProduct }) : null),
    h('div', { class: 'row wrap', style: { gap: '10px' } },
      h('div', { class: 'input-group', style: { maxWidth: '300px', flex: '1' } }, h('span', { class: 'ig-ico' }, iconEl('search', 15)), searchEl),
      catSel),
    h('div', { class: 'card' }, bodyEl, footEl));
  await load();

  const id = new URLSearchParams((ctx.hash.split('?')[1] || '')).get('id');
  if (id) openProduct({ id });
}
