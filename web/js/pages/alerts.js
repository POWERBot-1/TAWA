/** Alerts & Inbox — in-app notifications, outbound feed, alert rules. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtDT, fmtNum, timeAgo, toast, presentError, modal, field, input, select, tabs, iconEl, textarea } from '../ui.js';

export async function render(el) {
  const state = { tab: 'inbox', inbox: [], outbound: [], rules: [] };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function load() {
    if (state.tab === 'inbox') state.inbox = await api.get('/api/v1/notifications', { limit: 60 });
    if (state.tab === 'outbound') state.outbound = await api.get('/api/v1/notifications/outbound', { limit: 60 });
    if (state.tab === 'rules') state.rules = await api.get('/api/v1/alerts/rules');
  }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'inbox', label: 'Inbox' },
      { id: 'outbound', label: 'Outbound (sandbox)' },
      { id: 'rules', label: 'Alert rules' },
    ], state.tab, async (t) => { state.tab = t; bodyEl.replaceChildren(spin()); await load().catch(presentError); paint(); }));
    if (state.tab === 'inbox') bodyEl.replaceChildren(inboxView());
    else if (state.tab === 'outbound') bodyEl.replaceChildren(outboundView());
    else bodyEl.replaceChildren(rulesView());
  }
  const spin = () => h('div', { class: 'skel', style: { height: '260px', borderRadius: '12px' } });

  function inboxView() {
    const items = state.inbox || [];
    return h('div', { class: 'card' },
      items.length ? h('div', {}, items.map(n =>
        h('div', { class: `notif-item${n.read_at ? '' : ' unread'}`, onClick: async () => { try { await api.post(`/api/v1/notifications/${n.id}/read`); } catch {} n.read_at = new Date().toISOString(); paint(); } },
          h('span', { class: 'notif-ico' }, iconEl(n.kind === 'MARKETING' ? 'marketing' : n.severity === 'HIGH' ? 'warning' : 'bell', 15)),
          h('div', { class: 'grow' },
            h('div', { class: 'row between' },
              h('span', { class: 'strong', style: { fontSize: '13px' } }, n.title || n.event_type || 'Notification'),
              h('span', { class: 'tiny faint' }, timeAgo(n.created_at))),
            h('div', { class: 'tiny muted' }, n.body || ''),
            h('div', { class: 'row', style: { gap: '6px', marginTop: '5px' } },
              h('span', { class: 'badge-soft tiny' }, n.channel),
              n.event_type ? h('span', { class: 'badge-soft tiny mono' }, n.event_type) : null,
              n.ref_type ? h('span', { class: 'tiny faint mono' }, `${n.ref_type}`) : null))))
      ) : h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, iconEl('bell', 22)), h('div', { class: 'e-title' }, 'Inbox zero'), h('div', { class: 'e-msg' }, 'Alert rules post here when events fire.')));
  }

  function outboundView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'demo-hint row', style: { gap: '10px' } },
        h('span', { class: 'sandbox-tag' }, 'SANDBOX'),
        h('span', {}, 'SMS/WhatsApp/Email flow through log adapters — full trail, no real sending in this environment. Statuses reflect the adapter contract.')),
      h('div', { class: 'card' }, table([
        { label: 'Channel', render: r => h('span', { class: 'badge-soft mono' }, r.channel) },
        { label: 'To', render: r => h('div', {}, h('div', { class: 't-main mono tiny' }, r.to_addr || '—'), h('div', { class: 't-sub' }, r.recipient_kind)) },
        { label: 'Message', render: r => h('span', { class: 'tiny', style: { maxWidth: '420px', display: 'inline-block', overflowWrap: 'anywhere' } }, r.body) },
        { label: 'Event', render: r => h('span', { class: 'tiny mono faint' }, r.event_type || '—') },
        { label: 'Status', render: r => pill(r.status) },
        { label: 'When', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
      ], state.outbound || [], { emptyTitle: 'No outbound messages', ico: 'send' })));
  }

  function rulesView() {
    const canManage = store.can('alerts.manage');
    return h('div', { class: 'stack' },
      h('div', { class: 'row end' }, canManage ? btn('New rule', { cls: 'primary', ico: 'plus', onClick: ruleModal }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Rule', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, r.event)) },
        { label: 'Channel', render: r => h('span', { class: 'badge-soft' }, r.channel) },
        { label: 'Recipient', render: r => h('span', { class: 'tiny' }, (r.recipient_role || '—').replace(/_/g, ' ')) },
        { label: 'Template', render: r => h('span', { class: 'tiny muted mono' }, r.template) },
        { label: 'Priority', render: r => pill(r.priority === 'HIGH' || r.priority === 'URGENT' ? 'warn' : 'neutral', { raw: true }) },
        { label: 'State', render: r => pill(r.enabled ? 'ENABLED' : 'DISABLED') },
        { label: '', align: 'r', width: '1%', render: r => canManage ? (() => {
            const sw = h('span', { class: `switch${r.enabled ? ' on' : ''}`, onClick: async () => {
              try { await api.patch(`/api/v1/alerts/rules/${r.id}`, { enabled: !r.enabled }); await load(); paint(); } catch (e) { presentError(e); }
            } });
            return sw;
          })() : null },
      ], state.rules, { emptyTitle: 'No alert rules', ico: 'bolt' })));
  }

  function ruleModal() {
    const name = input({ placeholder: 'e.g. Low stock warning' });
    const event = select(['SaleCompleted', 'PaymentVerified', 'StockLow', 'GoodsReceived', 'QuoteAccepted', 'LeadConverted', 'WorkerPayrollApproved', 'CampaignSent']);
    const channel = select(['IN_APP', 'SMS', 'WHATSAPP', 'EMAIL']);
    const role = select(['OWNER', 'FINANCE_MANAGER', 'STOREKEEPER', 'MANAGER', 'ALL']);
    const template = input({ placeholder: 'e.g. Sale {{number}} completed — {{total}}' });
    const submit = btn('Create rule', { cls: 'primary', ico: 'bolt' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim() || !template.value.trim()) return toast.warn('Name and template required');
      try {
        await api.post('/api/v1/alerts/rules', { name: name.value.trim(), event: event.value, channel: channel.value, recipient_role: role.value, template: template.value.trim() });
        toast.ok('Alert rule armed');
        document.getElementById('overlays').replaceChildren();
        await load(); paint();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New alert rule', ico: 'bolt', width: 'narrow',
      body: h('div', {},
        field('NAME', name), h('div', { class: 'form-row' }, field('EVENT', event), field('CHANNEL', channel)),
        h('div', { class: 'form-row' }, field('RECIPIENT ROLE', role), field('TEMPLATE', template)),
        h('p', { class: 'tiny faint' }, 'Templates interpolate event fields, e.g. {{number}}, {{total}}, {{amount}}.')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(pageHead('Alerts & Inbox', 'Event bus → rules → notifications'), tabBar, bodyEl);
  await load(); paint();
}
