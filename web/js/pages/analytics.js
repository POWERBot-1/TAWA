/** Analytics — velocity, sources, margins, anomaly radar. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtNum, toast, presentError, barList, kv, iconEl, vbars } from '../ui.js';
import { go } from '../router.js';

export async function render(el) {
  let d;
  try { d = await api.get('/api/v1/analytics/overview'); } catch (e) { presentError(e); d = null; }

  if (!d) { el.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'card-b faint' }, 'Analytics unavailable.'))); return; }

  const velocity = d.product_velocity || [];
  const methods = d.payments_by_method || [];
  const sources = d.order_sources || [];
  const anomaly = d.sales_anomaly || {};
  const pnl = d.pnl_30d || {};

  const anomalyTone = anomaly.direction === 'NORMAL' ? 'ok' : anomaly.direction === 'SPIKE' ? 'warn' : 'danger';
  const anomalyMsg = anomaly.direction === 'NORMAL'
    ? `Today’s sales (KES ${fmtNum((anomaly.today_total || 0) / 100)}) sit within normal range.`
    : anomaly.direction === 'SPIKE'
      ? `Unusually high sales today — z-score ${fmtNum(anomaly.z)} vs 30-day mean.`
      : `Sales are unusually slow today — z-score ${fmtNum(anomaly.z)} vs 30-day mean.`;

  el.replaceChildren(
    pageHead('Analytics', 'Velocity, mix and anomaly radar'),
    h('div', { class: 'grid c3' },
      h('div', { class: `card kpi ${anomalyTone === 'ok' ? 'ok' : anomalyTone === 'warn' ? 'warn' : 'danger'}-strip` },
        h('div', { class: 'k-label' }, iconEl('radar', 13), 'Anomaly radar'),
        h('div', { class: 'k-value', style: { fontSize: 'var(--fs-18)' } }, anomaly.direction || 'NORMAL'),
        h('div', { class: 'k-foot tiny' }, `z=${fmtNum(anomaly.z)} · σ ${fmtMoney(anomaly.sd)}`)),
      h('div', { class: 'card kpi brand-strip' },
        h('div', { class: 'k-label' }, iconEl('trend', 13), 'Gross profit (30d)'),
        h('div', { class: 'k-value num', style: { fontSize: 'var(--fs-22)' } }, fmtMoney(pnl.gross_profit)),
        h('div', { class: 'k-foot tiny' }, `Net ${fmtMoney(pnl.net_profit)} from ${fmtMoney(pnl.revenue)}`)),
      h('div', { class: 'card kpi warn-strip' },
        h('div', { class: 'k-label' }, iconEl('clock', 13), 'Slow movers'),
        h('div', { class: 'k-value num' }, fmtNum(d.slow_movers ?? 0)),
        h('div', { class: 'k-foot tiny' }, 'No sale in 60+ days — review in AI insights'))),
    h('div', { class: `demo-hint row`, style: { gap: '10px', borderStyle: anomaly.direction === 'NORMAL' ? 'dashed' : 'solid' } }, iconEl('radar', 15), h('span', {}, anomalyMsg)),
    h('div', { class: 'grid c23' },
      card({
        title: 'Product velocity (30d)', sub: 'Units/day ranked by revenue',
        flush: true,
        body: table([
          { label: 'Product', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, r.sku)) },
          { label: 'Units', align: 'r', render: r => h('span', { class: 'num' }, fmtNum(r.units)) },
          { label: '/day', align: 'r', render: r => h('span', { class: 'num tiny muted' }, fmtNum(r.velocity)) },
          { label: 'Revenue', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.revenue)) },
          { label: 'Margin', align: 'r', render: r => h('span', { class: 'num', style: { color: 'var(--ok)' } }, fmtMoney(r.margin)) },
        ], velocity.slice(0, 12), { emptyTitle: 'No sales yet', ico: 'trend' }),
      }),
      h('div', { class: 'stack' },
        card({
          title: 'Order sources',
          body: sources.length ? barList(sources.map(s => ({ label: s.source || s.kind, value: s.orders ?? s.n ?? 0, sub: fmtMoney(s.total ?? 0) })), { valueFmt: v => `${fmtNum(v)} orders` }) : h('div', { class: 'faint tiny' }, 'No orders in window.'),
        }),
        card({
          title: 'Payment mix',
          body: methods.length ? barList(methods.map(m => ({ label: m.method, value: (m.total ?? m.amount ?? 0) / 100 })), { valueFmt: v => `KES ${fmtNum(v)}` }) : h('div', { class: 'faint tiny' }, 'No payments in window.'),
        })),
    ),
    h('div', { class: 'row wrap' },
      btn('Open AI copilot', { cls: 'primary', ico: 'ai', onClick: () => go('/ai') }),
      btn('All reports', { ico: 'reports', onClick: () => go('/reports') })));
}
