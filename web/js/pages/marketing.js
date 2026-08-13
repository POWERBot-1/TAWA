/** Marketing — campaigns (consent-gated), promotions engine, loyalty, Auto-Pay rules. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, modal, field, input, select, textarea, tabs, kv, iconEl } from '../ui.js';

export async function render(el) {
  const state = { tab: 'campaigns', campaigns: [], promos: [], loyalty: null, autopay: [] };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function load() {
    if (state.tab === 'campaigns') state.campaigns = await api.get('/api/v1/marketing/campaigns');
    if (state.tab === 'promotions') state.promos = await api.get('/api/v1/marketing/promotions');
    if (state.tab === 'loyalty') state.loyalty = await api.get('/api/v1/marketing/loyalty').catch(() => null);
    if (state.tab === 'autopay') state.autopay = await api.get('/api/v1/autopay/rules').catch(() => []);
  }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'campaigns', label: 'Campaigns' },
      { id: 'promotions', label: 'Promotions' },
      { id: 'loyalty', label: 'Loyalty' },
      ...(store.has('TAWA.AUTOPAY') ? [{ id: 'autopay', label: 'Auto-Pay rules' }] : []),
    ], state.tab, async (t) => { state.tab = t; bodyEl.replaceChildren(h('div', { class: 'skel', style: { height: '220px', borderRadius: '12px' } })); await load(); paint(); }));
    if (state.tab === 'campaigns') bodyEl.replaceChildren(campaignsView());
    else if (state.tab === 'promotions') bodyEl.replaceChildren(promosView());
    else if (state.tab === 'loyalty') bodyEl.replaceChildren(loyaltyView());
    else bodyEl.replaceChildren(autopayView());
  }

  /* ---------- campaigns ---------- */
  function campaignsView() {
    const canManage = store.can('marketing.manage');
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('shield-check', 15),
        h('span', {}, 'Broadcasts are consent-gated: only customers with marketing opt-in receive messages, via sandbox messaging adapters.')),
      h('div', { class: 'row end' }, canManage ? btn('New campaign', { cls: 'primary', ico: 'plus', onClick: campaignModal }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Campaign', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub' }, r.objective || r.description || '—')) },
        { label: 'Segment', render: r => h('span', { class: 'badge-soft' }, r.segment) },
        { label: 'Channels', render: r => h('span', { class: 'tiny mono' }, safeArr(r.channels).join(' · ')) },
        { label: 'Budget', align: 'r', render: r => h('span', { class: 'num' }, r.budget ? fmtMoney(r.budget) : '—') },
        { label: 'Result', render: r => { const s = safeJson(r.stats); return s.sent !== undefined ? h('span', { class: 'tiny' }, h('b', { class: 'num' }, fmtNum(s.sent)), ' sent', s.blocked_consent ? h('span', { class: 'muted' }, ` · ${fmtNum(s.blocked_consent)} consent-blocked`) : '') : h('span', { class: 'faint tiny' }, '—'); } },
        { label: 'Status', render: r => h('div', { class: 'row' }, pill(r.status), r.ai_prepared ? h('span', { class: 'pill brand' }, h('span', { class: 'pdot' }), 'AI DRAFT') : null) },
        { label: '', align: 'r', width: '1%', render: r => h('div', { class: 'row end', style: { gap: '6px' } },
          ['DRAFT', 'PENDING_APPROVAL'].includes(r.status) && store.can('marketing.approve') ? btn('Approve', { size: 'sm', onClick: () => campaignAct(r, 'approve', 'Campaign approved') }) : null,
          r.status === 'APPROVED' && canManage ? btn('Send broadcast', { size: 'sm', cls: 'primary', onClick: () => campaignAct(r, 'send', 'Broadcast delivered via adapters') }) : null) },
      ], state.campaigns, { emptyTitle: 'No campaigns', emptyMsg: 'Draft a campaign — humans approve before any customer is contacted.', ico: 'marketing' })));
  }

  async function campaignAct(r, kind, msg) {
    try { await api.post(`/api/v1/marketing/campaigns/${r.id}/${kind}`, {}); toast.ok(msg, r.name); await load(); paint(); }
    catch (e) { presentError(e); }
  }

  function campaignModal() {
    const name = input({ placeholder: 'e.g. Roofing Week' });
    const objective = input({ placeholder: 'What should this achieve?' });
    const segment = select([{ value: 'ALL', label: 'All opted-in customers' }, { value: 'MARKETING_OPTIN', label: 'Marketing opt-in only' }, { value: 'DORMANT', label: 'Dormant (60d no purchase)' }, { value: 'HIGH_VALUE', label: 'High value' }]);
    const message = textarea({ placeholder: 'Message customers receive. Keep it short and clear.' });
    const budget = input({ type: 'number', min: '0', step: '0.01', placeholder: '0.00' });
    const submit = btn('Create draft', { cls: 'primary', ico: 'marketing' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim()) return toast.warn('Name required');
      try {
        await api.post('/api/v1/marketing/campaigns', { name: name.value.trim(), objective: objective.value || undefined, segment: segment.value, offer: { message: message.value || name.value.trim() }, channels: ['SMS'], budget: +budget.value || 0 });
        toast.ok('Campaign drafted — pending approval');
        document.getElementById('overlays').replaceChildren();
        await load(); paint();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New campaign', ico: 'marketing', width: 'wide',
      body: h('div', {},
        h('div', { class: 'form-row' }, field('NAME', name), field('SEGMENT', segment)),
        field('OBJECTIVE', objective), field('MESSAGE (SMS)', message, { hint: 'Branded prefix and opt-out footer are appended automatically.' }),
        field('BUDGET CAP (KES)', budget)),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  /* ---------- promotions ---------- */
  function promosView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'row end wrap' },
        btn('Evaluate cart total', { ico: 'percent', onClick: evalModal }),
        store.can('marketing.manage') ? btn('New promotion', { cls: 'primary', ico: 'plus', onClick: promoModal }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Code', render: r => h('span', { class: 'mono badge-soft', style: { color: 'var(--brand)' } }, r.code) },
        { label: 'Name', render: r => h('span', { class: 't-main' }, r.name) },
        { label: 'Type', render: r => h('span', { class: 'badge-soft' }, r.type) },
        { label: 'Value', align: 'r', render: r => h('span', { class: 'num' }, r.type === 'PERCENT' ? `${r.value}%` : fmtMoney(r.value * 100)) },
        { label: 'Condition', render: r => { const c = safeJson(r.conditions); return h('span', { class: 'tiny muted' }, c.min_order_total ? `orders ≥ ${fmtMoney(c.min_order_total)}` : '—'); } },
        { label: 'Window', render: r => h('span', { class: 'tiny muted' }, r.starts_at ? `${fmtDate(r.starts_at)} → ${fmtDate(r.ends_at)}` : 'always on') },
        { label: 'Status', render: r => pill(r.is_active ? 'ENABLED' : 'DISABLED') },
      ], state.promos, { emptyTitle: 'No promotions', emptyMsg: 'Percent-off, fixed discounts, buy-X-get-Y — evaluated by the pricing engine at the till.', ico: 'percent' })));
  }

  function evalModal() {
    const amt = input({ type: 'number', step: '0.01', min: '0', value: '25000' });
    const out = h('div', { class: 'tiny muted' }, 'Enter a cart subtotal to see which promotions apply.');
    const run = async () => {
      if (!(+amt.value > 0)) return;
      try {
        const r = await api.post('/api/v1/marketing/promotions/evaluate', { subtotal: +amt.value });
        out.replaceChildren(r.applied.length
          ? h('div', { class: 'stack xs' },
              r.applied.map(a => h('div', { class: 'row between' }, h('span', {}, h('span', { class: 'mono badge-soft' }, a.code), ` ${a.name}`), h('span', { class: 'num strong', style: { color: 'var(--ok)' } }, `−${fmtMoney(a.discount)}`))),
              h('hr', { class: 'divider', style: { margin: '6px 0' } }),
              h('div', { class: 'row between strong' }, h('span', {}, 'Total discount'), h('span', { class: 'num' }, fmtMoney(r.total_discount))))
          : h('div', { class: 'tiny muted' }, 'No promotion applies at that subtotal.'));
      } catch (e) { presentError(e); }
    };
    amt.addEventListener('change', run);
    modal({
      title: 'Promotion evaluator', ico: 'percent', width: 'narrow',
      body: h('div', {}, field('CART SUBTOTAL (KES)', amt), out),
      foot: h('div', { class: 'right' }, btn('Evaluate', { cls: 'primary', onClick: run })),
    });
  }

  function promoModal() {
    const code = input({ placeholder: 'BUILD5' });
    const name = input({ placeholder: '5% off orders above KES 20,000' });
    const type = select([{ value: 'PERCENT', label: 'Percent off' }, { value: 'FIXED', label: 'Fixed amount off (KES)' }]);
    const value = input({ type: 'number', min: '0', step: '0.01', value: '5' });
    const minTotal = input({ type: 'number', min: '0', step: '0.01', placeholder: 'e.g. 20000' });
    const submit = btn('Create promotion', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      if (!code.value.trim()) return toast.warn('Code required');
      try {
        await api.post('/api/v1/marketing/promotions', { code: code.value.trim(), name: name.value.trim() || code.value.trim(), type: type.value, value: +value.value || 0, conditions: minTotal.value ? { min_order_total: Math.round(+minTotal.value * 100) } : {} });
        toast.ok('Promotion live', code.value.trim().toUpperCase());
        document.getElementById('overlays').replaceChildren();
        await load(); paint();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New promotion', ico: 'percent', width: 'narrow',
      body: h('div', {}, h('div', { class: 'form-row' }, field('CODE', code), field('NAME', name)),
        h('div', { class: 'form-row' }, field('TYPE', type), field('VALUE', value)),
        field('MINIMUM ORDER (KES, OPTIONAL)', minTotal)),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  /* ---------- loyalty ---------- */
  function loyaltyView() {
    const l = state.loyalty;
    if (!l) return h('div', { class: 'card' }, h('div', { class: 'card-b faint' }, 'Loyalty is not in your current plan.'));
    const dist = l.distribution || [];
    return h('div', { class: 'stack' },
      h('div', { class: 'grid c4' }, (l.tiers || []).map(t =>
        h('div', { class: 'card kpi brand-strip' },
          h('div', { class: 'k-label' }, iconEl('gift', 13), t.name),
          h('div', { class: 'k-value num', style: { fontSize: 'var(--fs-22)' } }, fmtNum(t.min_points)),
          h('div', { class: 'k-foot tiny' }, `${(dist.find(d => d.loyalty_tier === t.name)?.members) || 0} members`)))),
      card({
        title: 'Top members', flush: true,
        body: table([
          { label: 'Customer', render: r => h('span', { class: 't-main' }, r.name) },
          { label: 'Tier', render: r => pill(r.loyalty_tier === 'PLATINUM' ? 'brand' : r.loyalty_tier === 'GOLD' ? 'warn' : 'neutral', { raw: true }) && h('span', { class: `pill ${r.loyalty_tier === 'PLATINUM' ? 'brand' : 'neutral'}` }, h('span', { class: 'pdot' }), r.loyalty_tier) },
          { label: 'Points', align: 'r', render: r => h('span', { class: 'num strong' }, fmtNum(r.loyalty_points)) },
        ], l.top_members || [], { emptyTitle: 'No loyalty activity', ico: 'gift' }),
      }));
  }

  /* ---------- autopay ---------- */
  function autopayView() {
    const canManage = store.can('payments.payout');
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('automation', 15),
        h('span', {}, 'Auto-Pay executes payouts with caps and approval policy. Disabling a rule prevents ALL future executions.')),
      h('div', { class: 'row end' }, canManage ? btn('New Auto-Pay rule', { cls: 'primary', ico: 'plus', onClick: autopayModal }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Rule', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, r.purpose)) },
        { label: 'Cap / run', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.max_amount)) },
        { label: 'Frequency', render: r => h('span', { class: 'badge-soft' }, r.frequency) },
        { label: 'Approval', render: r => h('span', { class: 'tiny' }, r.approval_policy === 'REQUIRE_CONFIRMATION' ? 'Confirm each time' : 'Within cap only') },
        { label: 'Window', render: r => h('span', { class: 'tiny muted' }, `${fmtDate(r.starts_at)} → ${fmtDate(r.ends_at)}`) },
        { label: 'Status', render: r => pill(r.enabled ? 'ENABLED' : 'DISABLED') },
        { label: '', align: 'r', width: '1%', render: r => canManage ? (() => {
            const sw = h('span', { class: `switch${r.enabled ? ' on' : ''}`, title: r.enabled ? 'Disable' : 'Enable', onClick: async () => {
              try { const u = await api.post(`/api/v1/autopay/rules/${r.id}/toggle`, {}); toast.ok(u.enabled ? 'Rule enabled' : 'Rule disabled — no future executions'); await load(); paint(); }
              catch (e) { presentError(e); }
            } });
            return sw;
          })() : null },
      ], state.autopay, { emptyTitle: 'No Auto-Pay rules', emptyMsg: 'Recurring supplier/worker settlements with hard caps.', ico: 'automation' })));
  }

  function autopayModal() {
    const name = input({ placeholder: 'e.g. Weekly casual wages' });
    const purpose = select(['SUPPLIER_PAYMENT', 'WORKER_PAYMENT', 'BROKER_COMMISSION', 'EXPENSE', 'SUBSCRIPTION', 'OTHER']);
    const maxAmt = input({ type: 'number', min: '0.01', step: '0.01', placeholder: '50000' });
    const freq = select(['WEEKLY', 'DAILY', 'MONTHLY', 'ON_APPROVAL']);
    const start = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
    const end = input({ type: 'date', value: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) });
    const submit = btn('Create rule', { cls: 'primary', ico: 'automation' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim() || !(+maxAmt.value > 0)) return toast.warn('Name and cap required');
      try {
        await api.post('/api/v1/autopay/rules', { name: name.value.trim(), purpose: purpose.value, max_amount: +maxAmt.value, frequency: freq.value, starts_at: start.value, ends_at: end.value, approval_policy: 'REQUIRE_CONFIRMATION', failure_policy: 'NOTIFY', notify_policy: 'ALWAYS' });
        toast.ok('Auto-Pay rule created', 'Confirmation is required before each payout.');
        document.getElementById('overlays').replaceChildren();
        await load(); paint();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New Auto-Pay rule', ico: 'automation', width: 'narrow',
      body: h('div', {},
        field('NAME', name), field('PURPOSE', purpose),
        h('div', { class: 'form-row' }, field('MAX AMOUNT PER RUN (KES)', maxAmt), field('FREQUENCY', freq)),
        h('div', { class: 'form-row' }, field('STARTS', start), field('ENDS', end)),
        h('p', { class: 'tiny faint' }, 'All rules require per-run confirmation; caps are hard limits enforced server-side.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  function safeArr(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }
  function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

  el.replaceChildren(pageHead('Marketing', 'Campaigns, promotions, loyalty & Auto-Pay'), tabBar, bodyEl);
  await load(); paint();
}
