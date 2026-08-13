/** Dashboard — business pulse (§ dashboards). */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, kpi, pill, table, skeleton, toast, presentError, segmented, barList, vbars, fmtMoney, fmtNum, timeAgo, iconEl, btn, delta } from '../ui.js';
import { go } from '../router.js';

let chartMode = 'revenue';

export async function render(el) {
  const rangeSel = segmented([{ value: 'today', label: 'Today' }, { value: '7d', label: '7D' }, { value: '30d', label: '30D' }, { value: '90d', label: '90D' }], loadCachedRange(), async (r) => { sessionStorage.setItem('tawa.range', r); await load(r); });
  const head = pageHead('Dashboard', `${store.brand?.branding?.business_name || store.tenant?.name || ''} · live operations`, rangeSel);

  const kpis = h('div', { class: 'grid c4' }, skeletonGrid());
  const mid = h('div', { class: 'grid c23' }, h('div', { class: 'card' }, skeletonBox(300)), h('div', { class: 'card' }, skeletonBox(300)));
  const low = h('div', { class: 'grid c3' }, h('div', { class: 'card' }, skeletonBox(200)), h('div', { class: 'card' }, skeletonBox(200)), h('div', { class: 'card' }, skeletonBox(200)));

  el.replaceChildren(head, kpis, mid, low);

  async function load(range) {
    let d;
    try { d = await api.get('/api/v1/dashboard', { range }); }
    catch (e) { presentError(e, 'Dashboard failed to load'); return; }
    paint(d);
  }

  function paint(d) {
    const s = d.sales, p = d.positions, a = d.attention;
    kpis.replaceChildren(
      kpi({ label: `Revenue · ${labelFor()}`, ico: 'trend', value: fmtMoney(s.total), strip: 'brand', foot: h('span', {}, h('span', { class: 'strong' }, fmtNum(s.orders)), ` orders · AOV ${fmtMoney(s.aov)}`) }),
      kpi({ label: 'Collected', ico: 'payments', value: fmtMoney(s.collected), strip: 'ok', foot: h('span', {}, `${pct(s.collected, s.total)}% of billed`) }),
      kpi({ label: 'Gross profit', ico: 'scale', value: fmtMoney(s.gross_profit), strip: 'ok', foot: h('span', {}, `${pct(s.gross_profit, s.total)}% margin`) }),
      kpi({ label: 'Stock value (cost)', ico: 'inventory', value: fmtMoney(p.inventory_cost_value), strip: 'warn', foot: h('span', { class: 'tiny' }, `Retail ${fmtMoney(p.inventory_retail_value)}`) }),
      kpi({ label: 'Credit outstanding', ico: 'credit', value: fmtMoney(p.credit_outstanding), strip: p.credit_outstanding > 0 ? 'danger' : 'ok', foot: h('span', {}, `of ${fmtMoney(p.credit_limits)} limits`), onClick: () => go('/credit') }),
      kpi({ label: 'Payables (suppliers)', ico: 'suppliers', value: fmtMoney(p.supplier_liabilities), strip: a.overdue_supplier_invoices?.n ? 'danger' : 'warn', foot: a.overdue_supplier_invoices?.n ? h('span', { class: 'tiny', style: { color: 'var(--danger)' } }, `${a.overdue_supplier_invoices.n} overdue · ${fmtMoney(a.overdue_supplier_invoices.amt)}`) : h('span', { class: 'tiny' }, 'Nothing overdue'), onClick: () => go('/procurement') }),
      kpi({ label: 'Low stock alerts', ico: 'warning', value: fmtNum(a.low_stock), strip: a.low_stock ? 'warn' : 'ok', foot: h('span', { class: 'tiny' }, `${a.dead_stock} dead · ${fmtMoney(a.dead_stock_value)} idle`), onClick: () => go('/inventory') }),
      kpi({ label: 'Open deliveries', ico: 'truck', value: fmtNum(a.pending_deliveries), strip: 'brand', foot: h('span', { class: 'tiny' }, `${a.pending_orders} orders awaiting fulfilment`), onClick: () => go('/deliveries') }),
    );

    const trend = d.sales_trend || [];
    const items = trend.map(t => ({ label: t.day.slice(5), value: t.total / 100 }));
    const marginItems = (d.margin_trend || []).map(t => ({ label: t.day.slice(5), value: Math.max(t.margin, 0) / 100 }));
    const chartBox = card({
      title: 'Sales trend', sub: `${trend.length} active days · ${labelFor()}`,
      right: h('div', { class: 'row', style: { gap: '6px' } },
        chip('Revenue', chartMode === 'revenue', () => { chartMode = 'revenue'; paintChart(); }),
        chip('Margin', chartMode === 'margin', () => { chartMode = 'margin'; paintChart(); })),
    });
    const chartHost = h('div', { class: 'card-b' });
    chartBox.appendChild(chartHost);
    function paintChart() {
      chartHost.replaceChildren(
        vbars(chartMode === 'revenue' ? items : marginItems, { hgt: 190, labelEvery: Math.ceil(items.length / 12) }),
        h('div', { class: 'row between tiny muted', style: { marginTop: '10px' } },
          h('span', {}, chartMode === 'revenue' ? 'Daily revenue (KES)' : 'Daily gross margin (KES)'),
          h('span', { class: 'mono' }, fmtMoney(trend.reduce((s2, t) => s2 + (chartMode === 'revenue' ? t.total : 0), 0)))));
    }
    paintChart();

    const attention = card({
      title: 'Needs attention', sub: 'Actionable right now',
      right: pill(a.low_stock + (a.pending_orders || 0) + (a.overdue_supplier_invoices?.n || 0) ? 'warn' : 'ok') && h('span', { class: a.low_stock || a.pending_orders ? 'pill warn' : 'pill ok' }, h('span', { class: 'pdot' }), a.low_stock || a.pending_orders ? 'ACTION' : 'CLEAR'),
    });
    const attList = h('div', { class: 'stack sm', style: { padding: '12px 16px' } });
    const lines = [];
    if (a.low_stock) lines.push({ icon: 'warning', tone: 'var(--warn)', text: `${a.low_stock} products at/below reorder point`, link: '/inventory' });
    if (a.pending_orders) lines.push({ icon: 'orders', tone: 'var(--info)', text: `${a.pending_orders} confirmed orders awaiting fulfilment`, link: '/orders?status=CONFIRMED' });
    if (a.pending_deliveries) lines.push({ icon: 'truck', tone: 'var(--brand)', text: `${a.pending_deliveries} deliveries in progress`, link: '/deliveries' });
    if (a.overdue_supplier_invoices?.n) lines.push({ icon: 'suppliers', tone: 'var(--danger)', text: `${a.overdue_supplier_invoices.n} supplier invoices overdue (${fmtMoney(a.overdue_supplier_invoices.amt)})`, link: '/procurement' });
    if (a.overdue_credit_orders?.n) lines.push({ icon: 'credit', tone: 'var(--danger)', text: `${a.overdue_credit_orders.n} credit sales overdue (${fmtMoney(a.overdue_credit_orders.amt)})`, link: '/credit' });
    if (a.pending_quotes) lines.push({ icon: 'quotes', tone: 'var(--info)', text: `${a.pending_quotes} open quotes worth ${fmtMoney(a.pending_quotes_value)}`, link: '/quotes' });
    if (!lines.length) attList.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, h('div', { class: 'e-ico' }, iconEl('approve', 22)), h('div', { class: 'e-title' }, 'All clear'), h('div', { class: 'e-msg' }, 'No operational blockers right now.')));
    for (const l of lines) attList.appendChild(h('a', { class: 'row', href: `#${l.link}`, style: { gap: '10px', padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--line)' } },
      h('span', { style: { color: l.tone, display: 'grid' } }, iconEl(l.icon, 15)), h('span', { class: 'grow', style: { fontSize: '12.5px' } }, l.text), iconEl('chevron-r', 14)));
    attention.appendChild(attList);
    mid.replaceChildren(chartBox, attention);

    low.replaceChildren(
      card({ title: 'Top products', sub: `By revenue · ${labelFor()}`, body: (d.top_products?.length ? barList(d.top_products.map(t => ({ label: `${t.name}`, value: t.revenue / 100, sub: `${fmtNum(t.units)} units` })), { valueFmt: v => `KES ${fmtNum(v)}` }) : h('div', { class: 'faint tiny' }, 'No sales in range — the 30D view includes seeded history.')) }),
      card({ title: 'Top customers', sub: `By spend · ${labelFor()}`, body: d.top_customers?.length ? h('div', { class: 'stack', style: { gap: '2px' } }, d.top_customers.map((c, i) => h('div', { class: 'bar-row' },
        h('div', { class: 'b-label ellipsis' }, h('span', { class: 'mono faint tiny', style: { marginRight: '8px' } }, `#${i + 1}`), c.name),
        h('div', { class: 'b-val' }, `${fmtMoney(c.spent)} · ${c.orders} orders`),
      ))) : h('div', { class: 'faint tiny' }, 'No customer sales in range.') }),
      card({
        title: 'Branch performance', sub: labelFor(),
        body: (d.branch_performance || []).length ? h('div', { class: 'stack', style: { gap: '2px' } },
          d.branch_performance.map(b => h('div', { class: 'bar-row' },
            h('div', { class: 'b-label' }, b.name),
            h('div', { class: 'b-val' }, `${fmtMoney(b.revenue)} · ${fmtNum(b.orders)}`),
            h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${Math.max(3, (b.revenue / Math.max(...d.branch_performance.map(x => x.revenue), 1)) * 100)}%` } }))))) : h('div', { class: 'faint tiny' }, 'Single-branch workspace.'),
        foot: d.best_branch ? h('span', { class: 'tiny muted' }, `Best: ${d.best_branch.name} · Weakest: ${d.worst_branch.name}`) : null,
      }));
  }

  function labelFor() { return { today: 'Today', '7d': '7 days', '30d': '30 days', '90d': '90 days' }[loadCachedRange()]; }
  await load(loadCachedRange());
}

function loadCachedRange() { return sessionStorage.getItem('tawa.range') || '30d'; }
function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
function chip(label, on, onClick) { return h('button', { class: `btn sm ${on ? 'primary' : ''}`, onClick }, label); }
function skeletonGrid() { return [0, 1, 2, 3].map(() => h('div', { class: 'skel', style: { height: '112px', borderRadius: '12px' } })); }
function skeletonBox(hgt) { return h('div', { style: { padding: '16px' } }, h('div', { class: 'skel', style: { height: hgt + 'px' } })); }
