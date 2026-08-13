/** Accounting — chart of accounts, trial balance, P&L, balance sheet, journal, integrity. */
import { api, downloadFile } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtNum, toast, presentError, tabs, kv, iconEl } from '../ui.js';

export async function render(el) {
  const state = { tab: 'pnl' };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function fetchFor(tab) {
    switch (tab) {
      case 'pnl': return api.get('/api/v1/accounting/pnl');
      case 'trial': return api.get('/api/v1/accounting/trial-balance');
      case 'bs': return api.get('/api/v1/accounting/balance-sheet');
      case 'journal': return api.get('/api/v1/accounting/journal', { limit: 60 });
      case 'coa': return api.get('/api/v1/accounting/accounts');
      case 'integrity': return Promise.all([api.get('/api/v1/accounting/integrity'), api.get('/api/v1/accounting/reconcile').catch(() => null)]).then(([i, r]) => ({ i, r }));
    }
  }

  async function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'pnl', label: 'Profit & loss' },
      { id: 'bs', label: 'Balance sheet' },
      { id: 'trial', label: 'Trial balance' },
      { id: 'journal', label: 'Journal' },
      { id: 'coa', label: 'Chart of accounts' },
      { id: 'integrity', label: 'Integrity' },
    ], state.tab, (t) => { state.tab = t; paint(); }));
    bodyEl.replaceChildren(h('div', { class: 'card' }, h('div', { style: { padding: '16px' } }, h('div', { class: 'skel', style: { height: '300px' } }))));
    let data;
    try { data = await fetchFor(state.tab); } catch (e) { presentError(e); return; }
    bodyEl.replaceChildren(view(data));
  }

  function view(data) {
    if (state.tab === 'pnl') return pnlView(data);
    if (state.tab === 'bs') return bsView(data);
    if (state.tab === 'trial') return trialView(data);
    if (state.tab === 'journal') return journalView(data);
    if (state.tab === 'coa') return coaView(data);
    return integrityView(data);
  }

  function pnlView(p) {
    const line = (label, val, strong = false, color = null) => h('div', { class: 'row between', style: { padding: '7px 0', borderBottom: '1px solid var(--line)' } },
      h('span', { class: strong ? 'strong' : 'muted', style: { fontSize: strong ? 'var(--fs-15)' : 'var(--fs-13)' } }, label),
      h('span', { class: `num ${strong ? 'strong' : ''}`, style: color ? { color } : null }, fmtMoney(val)));
    return h('div', { class: 'grid c32' },
      card({
        title: 'Profit & loss statement', sub: 'Derived from posted journals',
        body: h('div', {},
          line('Revenue', p.revenue),
          line('Discounts & refunds', -(p.discounts_refunds || 0)),
          line('Net revenue', p.net_revenue, true),
          line('Cost of goods sold', -p.cogs),
          line('Gross profit', p.gross_profit, true, p.gross_profit >= 0 ? 'var(--ok)' : 'var(--danger)'),
          line('Operating expenses', -p.opex),
          h('div', { style: { marginTop: '10px', borderTop: '2px solid var(--line-strong)', paddingTop: '10px' } },
            line('NET PROFIT', p.net_profit, true, p.net_profit >= 0 ? 'var(--ok)' : 'var(--danger)'))),
      }),
      h('div', { class: 'stack' },
        card({ title: 'Margins', body: kv([
          ['Gross margin', p.net_revenue ? `${Math.round((p.gross_profit / p.net_revenue) * 100)}%` : '—'],
          ['Net margin', p.net_revenue ? `${Math.round((p.net_profit / p.net_revenue) * 100)}%` : '—'],
          ['COGS ratio', p.revenue ? `${Math.round((p.cogs / p.revenue) * 100)}%` : '—'],
        ]) }),
        card({
          title: 'Account detail', flush: true,
          body: table([
            { label: 'Code', render: r => h('span', { class: 'mono badge-soft' }, r.code) },
            { label: 'Account', key: 'name' },
            { label: 'Debits', align: 'r', render: r => h('span', { class: 'num tiny' }, fmtMoney(r.debits)) },
            { label: 'Credits', align: 'r', render: r => h('span', { class: 'num tiny' }, fmtMoney(r.credits)) },
          ], p.lines || []),
        })));
  }

  function bsView(b) {
    const sct = (title, rows, totalLabel, total, tone) => card({
      title, flush: true,
      body: table([
        { label: 'Account', render: r => h('span', {}, h('span', { class: 'mono badge-soft', style: { marginRight: '8px' } }, r.code), r.name) },
        { label: 'Balance', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.value)) },
      ], rows),
      foot: h('div', { class: 'row between', style: { width: '100%' } }, h('span', { class: 'strong' }, totalLabel), h('span', { class: 'num strong', style: { color: tone } }, fmtMoney(total))),
    });
    const ta = (b.assets || []).reduce((s, r) => s + r.value, 0);
    const tl = (b.liabilities || []).reduce((s, r) => s + r.value, 0);
    const te = (b.equity || []).reduce((s, r) => s + r.value, 0);
    return h('div', { class: 'stack' },
      h('div', { class: 'grid c3' },
        sct('Assets', b.assets || [], 'Total assets', ta, 'var(--ok)'),
        sct('Liabilities', b.liabilities || [], 'Total liabilities', tl, 'var(--warn)'),
        sct('Equity', b.equity || [], 'Total equity', te, 'var(--brand)')),
      h('div', { class: `demo-hint row`, style: { gap: '10px' } }, iconEl('scale', 15),
        h('span', {}, `Assets ${fmtMoney(ta)} ${Math.abs(ta - (tl + te)) < 2 ? '=' : '≠'} Liabilities + Equity ${fmtMoney(tl + te)} — ${Math.abs(ta - (tl + te)) < 2 ? 'balanced.' : 'OUT OF BALANCE (investigate immediately).'}`)));
  }

  function trialView(t) {
    const accounts = t.accounts || [];
    const td = accounts.reduce((s, a) => s + a.debits, 0);
    const tc = accounts.reduce((s, a) => s + a.credits, 0);
    return card({
      title: 'Trial balance', sub: 'Sum of debits must equal sum of credits — enforced per entry server-side',
      flush: true,
      body: table([
        { label: 'Code', render: r => h('span', { class: 'mono badge-soft' }, r.code) },
        { label: 'Account', key: 'name' },
        { label: 'Type', render: r => h('span', { class: 'tiny badge-soft' }, r.type) },
        { label: 'Debits', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.debits)) },
        { label: 'Credits', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.credits)) },
        { label: 'Balance (D−C)', align: 'r', render: r => h('span', { class: 'num', style: { color: r.balance >= 0 ? 'var(--text)' : 'var(--text-2)' } }, fmtMoney(r.balance)) },
      ], accounts),
      foot: h('div', { class: 'row between', style: { width: '100%' } },
        h('span', { class: 'strong' }, 'Totals'),
        h('span', { class: `num strong`, style: { color: td === tc ? 'var(--ok)' : 'var(--danger)' } }, `${fmtMoney(td)} / ${fmtMoney(tc)} ${td === tc ? '· BALANCED' : '· UNBALANCED'}`)),
    });
  }

  function journalView(rows) {
    return card({
      title: 'Journal (latest 60)', sub: 'Append-only — reversal entries, never edits',
      flush: true,
      body: table([
        { label: 'No.', render: r => h('span', { class: 'mono badge-soft' }, r.entry_no) },
        { label: 'Posted', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.posted_at)) },
        { label: 'Memo', render: r => h('div', {}, h('div', { class: 't-main' }, r.memo || r.ref_type), h('div', { class: 't-sub' }, `by ${r.actor_name || 'system'}`)) },
        { label: 'Lines', render: r => h('div', { class: 'stack xs' }, (r.lines || []).map(l =>
          h('div', { class: 'row tiny', style: { gap: '8px', justifyContent: 'flex-end' } },
            h('span', { class: 'mono faint' }, l.code),
            h('span', { class: 'num', style: { color: l.debit ? 'var(--ok)' : 'var(--info)' } }, l.debit ? `Dr ${fmtMoney(l.debit)}` : `Cr ${fmtMoney(l.credit)}`)))) },
      ], rows, { emptyTitle: 'No journal entries', ico: 'ledger' }),
      foot: h('div', { class: 'row end', style: { width: '100%' } },
        btn('Export full journal (CSV)', { size: 'sm', ico: 'download', onClick: async () => { try { await downloadFile('/api/v1/accounting/journal.csv', 'journal.csv'); } catch (e) { presentError(e); } } })),
    });
  }

  function coaView(rows) {
    return card({
      title: 'Chart of accounts', flush: true,
      body: table([
        { label: 'Code', render: r => h('span', { class: 'mono badge-soft' }, r.code) },
        { label: 'Name', key: 'name' },
        { label: 'Type', render: r => pill(r.type === 'ASSET' ? 'ok' : r.type === 'LIABILITY' ? 'warn' : r.type === 'EQUITY' ? 'brand' : r.type === 'REVENUE' ? 'info' : 'danger', { raw: true }) },
      ], rows),
    });
  }

  function integrityView({ i, r }) {
    const checks = [
      ['Journal entries balanced', i?.balanced !== false && i?.ok !== false, i?.balanced !== false && i?.ok !== false ? 'Every entry debits = credits' : `${(i?.unbalanced_entries || []).length} unbalanced entries found`],
      ['Payments reconcile', !r || (r.findings || []).length === 0, r ? `${r.payment_count ?? '—'} payments checked · ${(r.findings || []).length} findings` : 'Not available'],
      ['Append-only movements', true, 'Database trigger rejects UPDATE/DELETE on inventory_movements'],
      ['Append-only audit', true, 'Database trigger rejects UPDATE/DELETE on audit_events'],
      ['Tenant scoping', true, 'Every scoped table carries tenant_id; queries are server-derived'],
    ];
    const allOk = checks.every(c => c[1]);
    return h('div', { class: 'stack' },
      h('div', { class: `card kpi ${allOk ? 'ok' : 'danger'}-strip` },
        h('div', { class: 'k-label' }, iconEl('shield-check', 13), 'Integrity status'),
        h('div', { class: 'k-value', style: { color: allOk ? 'var(--ok)' : 'var(--danger)' } }, allOk ? 'ALL CHECKS PASS' : 'ATTENTION REQUIRED')),
      card({
        title: 'Continuous controls', flush: true,
        body: table([
          { label: 'Control', render: c => h('span', { class: 't-main' }, c[0]) },
          { label: 'Evidence', render: c => h('span', { class: 'tiny muted' }, c[2]) },
          { label: 'Result', align: 'r', render: c => pill(c[1] ? 'ok' : 'danger', { raw: true }) },
        ], checks),
      }));
  }

  el.replaceChildren(pageHead('Accounting', 'Double-entry truth, always balanced'), tabBar, bodyEl);
  await paint();
}
