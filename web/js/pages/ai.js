/** AI Copilot — deterministic, explainable. READ / ANALYSE / RECOMMEND / PREPARE — never EXECUTE. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtNum, timeAgo, toast, presentError, modal, field, input, tabs, iconEl, spark } from '../ui.js';
import { go } from '../router.js';

const CLASS_TONE = { READ: 'info', ANALYSE: 'brand', RECOMMEND: 'warn', PREPARE: 'ok' };
const SUGGESTIONS = [
  'How much did we sell today?',
  'Which customers owe us money?',
  'What should I reorder?',
  'Which products are dead stock?',
  'Any unusual sales activity?',
  'Top 5 products this month',
];

export async function render(el) {
  const state = { tab: 'copilot', chat: [], insights: null, reorder: [], log: [], loading: false };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function loadTab() {
    if (state.tab === 'insights') state.insights = await api.get('/api/v1/ai/insights');
    if (state.tab === 'reorder') state.reorder = await api.get('/api/v1/ai/reorder');
    if (state.tab === 'log') state.log = await api.get('/api/v1/ai/log').catch(() => []);
  }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'copilot', label: 'Copilot' },
      { id: 'insights', label: 'Insights' },
      { id: 'reorder', label: 'Reorder advisor' },
      { id: 'log', label: 'Action log' },
    ], state.tab, async (t) => { state.tab = t; bodyEl.replaceChildren(spin()); try { await loadTab(); } catch (e) { presentError(e); } paint(); }));
    if (state.tab === 'copilot') bodyEl.replaceChildren(copilotView());
    else if (state.tab === 'insights') bodyEl.replaceChildren(insightsView());
    else if (state.tab === 'reorder') bodyEl.replaceChildren(reorderView());
    else bodyEl.replaceChildren(logView());
  }
  const spin = () => h('div', { class: 'skel', style: { height: '300px', borderRadius: '12px' } });

  /* ---------------- copilot chat ---------------- */
  function copilotView() {
    const chatEl = h('div', { class: 'ai-chat', style: { minHeight: '200px' } });
    const inputEl = h('input', { class: 'input', style: { height: '44px', fontSize: '14px' }, placeholder: 'Ask about sales, stock, credit, staff…' });

    if (!state.chat.length) {
      state.chat.push({
        who: 'ai', answer: `Karibu. I'm the ${store.brand?.branding?.business_name || 'TAWA'} copilot. I answer from your live ledgers and I'm explainable — every answer shows its data source. I can recommend and prepare, but I never execute.`,
        action_class: 'READ', why: 'Deterministic engine — the same question always yields the same audited answer.',
      });
    }
    const paintChat = () => {
      chatEl.replaceChildren(...state.chat.map(m => {
        if (m.who === 'user') return h('div', { class: 'ai-msg user' }, h('span', { class: 'a-avatar' }, iconEl('user', 15)), h('div', { class: 'a-body' }, m.text));
        return h('div', { class: 'ai-msg' },
          h('span', { class: 'a-avatar' }, iconEl('ai', 15)),
          h('div', { class: 'a-body' },
            h('div', { html: m.answer }),
            h('div', { class: 'a-meta' },
              pill(m.action_class || 'READ', { raw: true }),
              m.confidence ? h('span', { class: 'tiny faint mono' }, `confidence ${(m.confidence * 100).toFixed(0)}%`) : null,
              m.busy ? h('span', { class: 'tiny faint' }, 'thinking…') : null),
            m.why ? h('div', { class: 'tiny', style: { marginTop: '8px', color: 'var(--text-3)', borderTop: '1px dashed var(--line)', paddingTop: '7px' } }, h('b', { style: { color: 'var(--text-2)' } }, 'WHY: '), m.why) : null,
            (m.actions || []).length ? h('div', { class: 'row wrap', style: { marginTop: '8px', gap: '6px' } },
              m.actions.map(a => btn(a.label || a, { size: 'sm', onClick: () => followAction(a) }))) : null));
      }));
    };

    async function ask(q) {
      if (state.loading || !q.trim()) return;
      state.chat.push({ who: 'user', text: q });
      const pending = { who: 'ai', answer: '…', busy: true, action_class: 'READ' };
      state.chat.push(pending);
      state.loading = true; paintChat();
      try {
        const res = await api.post('/api/v1/ai/ask', { question: q });
        Object.assign(pending, res, { who: 'ai', busy: false, answer: res.answer });
      } catch (e) {
        Object.assign(pending, { answer: `<b>Could not answer.</b> ${e?.message || ''}`, busy: false, action_class: 'READ' });
      }
      state.loading = false; paintChat();
    }

    async function followAction(a) {
      if (a === 'Go to reorder analysis' || /reorder/i.test(a)) { state.tab = 'reorder'; bodyEl.replaceChildren(spin()); try { await loadTab(); } catch {} paint(); }
      else if (/dead stock/i.test(a)) { ask('Which products are dead stock?'); }
      else if (typeof a === 'string') ask(a);
    }

    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inputEl.value.trim()) { const v = inputEl.value.trim(); inputEl.value = ''; ask(v); } });
    paintChat();

    return h('div', { class: 'stack' },
      h('div', { class: 'ai-suggest' }, SUGGESTIONS.map(s => h('button', { class: 'ai-chip', onClick: () => ask(s) }, s))),
      card({ body: chatEl }),
      h('div', { class: 'row' },
        h('div', { class: 'input-group grow' }, h('span', { class: 'ig-ico' }, iconEl('ai', 16)), inputEl),
        btn('Ask', { cls: 'primary', ico: 'send', onClick: () => { const v = inputEl.value.trim(); if (v) { inputEl.value = ''; ask(v); } } })),
      h('p', { class: 'tiny faint', style: { margin: 0 } },
        'Action classes: READ (facts) · ANALYSE (patterns) · RECOMMEND (options) · PREPARE (drafts for approval). EXECUTE does not exist for the AI.'));
  }

  /* ---------------- insights ---------------- */
  function insightsView() {
    const items = state.insights?.stored || state.insights?.items || [];
    const live = state.insights?.fresh || state.insights?.live || [];
    const all = [...(Array.isArray(items) ? items : []), ...(Array.isArray(live) ? live : [])]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return h('div', { class: 'stack' },
      !all.length ? h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, iconEl('approve', 22)), h('div', { class: 'e-title' }, 'No insights right now'), h('div', { class: 'e-msg' }, 'The engine scans stock-outs, dead stock, anomalies and overdue liabilities continuously.'))) : null,
      h('div', { class: 'grid c2' }, all.map(i => h('div', { class: `card ${i.severity === 'HIGH' ? '' : ''}`, style: { borderColor: i.severity === 'HIGH' ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : null } },
        h('div', { class: 'card-h' },
          h('span', { style: { color: i.severity === 'HIGH' ? 'var(--danger)' : 'var(--brand)', display: 'grid' } }, iconEl('lightbulb', 17)),
          h('div', { class: 'grow' }, h('h3', {}, i.title), h('div', { class: 'h-sub' }, `${i.kind} · ${timeAgo(i.created_at)}`)),
          pill(i.severity || 'NORMAL')),
        h('div', { class: 'card-b stack sm' },
          h('p', { style: { margin: 0, fontSize: '13px', color: 'var(--text-2)' } }, i.body),
          i.action ? h('div', { class: 'row between' },
            h('span', { class: 'tiny', style: { color: 'var(--text-2)' } }, h('b', {}, 'Recommended: '), i.action),
            h('span', { class: 'tiny faint mono' }, `${Math.round((i.confidence ?? 0) * 100)}%`)) : null,
          i.kind === 'REORDER' ? btn('Open reorder advisor', { size: 'sm', cls: 'primary', onClick: async () => { state.tab = 'reorder'; bodyEl.replaceChildren(spin()); await loadTab(); paint(); } }) : null)))));
  }

  /* ---------------- reorder advisor ---------------- */
  function reorderView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('ai', 15),
        h('span', {}, 'Model: demand-during-lead-time + 3 days safety cover, honoring configured reorder points. Drafts only — humans convert to POs.')),
      h('div', { class: 'card' }, table([
        { label: 'Product', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, `${r.sku} · ${r.unit}`)) },
        { label: 'Available', align: 'r', render: r => h('span', { class: 'num strong', style: { color: r.available <= 0 ? 'var(--danger)' : 'var(--warn)' } }, fmtNum(r.available)) },
        { label: 'Velocity/day', align: 'r', render: r => h('span', { class: 'num' }, fmtNum(r.velocity)) },
        { label: 'Days of stock', align: 'r', render: r => h('span', { class: 'num' }, r.days_of_stock >= 999 ? '∞' : fmtNum(r.days_of_stock)) },
        { label: 'Lead', align: 'r', render: r => h('span', { class: 'mono tiny muted' }, `${r.lead_days}d`) },
        { label: 'Supplier', render: r => h('span', { class: 'tiny' }, r.supplier || '—') },
        { label: 'Suggest', align: 'r', render: r => h('span', { class: 'num strong', style: { color: 'var(--brand)' } }, fmtNum(r.suggested_qty)) },
        { label: 'Cost est.', align: 'r', render: r => h('span', { class: 'num tiny muted' }, fmtMoney(r.est_cost)) },
        { label: 'Urgency', render: r => pill(r.urgency) },
      ], state.reorder, {
        emptyTitle: 'Nothing to reorder', emptyMsg: 'All products are above safe cover at current sales velocity.', ico: 'approve',
      })));
  }

  /* ---------------- audit of the AI itself ---------------- */
  function logView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('history', 15), h('span', {}, 'Every AI answer is logged with its class and inputs — full accountability for automation.')),
      h('div', { class: 'card' }, table([
        { label: 'When', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
        { label: 'Class', render: r => pill(r.action_class || 'READ', { raw: true }) },
        { label: 'Question / action', render: r => h('span', {}, r.question || r.action || r.summary || '—') },
        { label: 'Actor', render: r => h('span', { class: 'tiny muted' }, r.actor_name || '—') },
      ], state.log, { emptyTitle: 'No AI activity yet', ico: 'history' })));
  }

  el.replaceChildren(pageHead('AI Copilot', 'Deterministic. Explainable. Never executes.'), tabBar, bodyEl);
  paint();
}
