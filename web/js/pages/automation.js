/** Automation — rules that PREPARE work for humans; never act alone. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtDT, toast, presentError, modal, field, input, select, iconEl, kv } from '../ui.js';

export async function render(el) {
  let rules = [];
  const bodyEl = h('div', {});
  const canManage = store.can('alerts.manage', 'automation.manage');

  async function load() {
    try { rules = await api.get('/api/v1/automation/rules'); paint(); } catch (e) { presentError(e); }
  }

  function paint() {
    bodyEl.replaceChildren(
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('shield-check', 15),
        h('span', {}, 'Automation prepares — humans approve. Every rule that touches money, stock or suppliers requires_approval = true.')),
      h('div', { class: 'row end' }, canManage ? btn('New rule', { cls: 'primary', ico: 'plus', onClick: ruleModal }) : null),
      h('div', { class: 'grid c2' }, rules.map(r => h('div', { class: 'card' },
        h('div', { class: 'card-h' },
          h('span', { style: { color: 'var(--brand)', display: 'grid' } }, iconEl('automation', 17)),
          h('div', { class: 'grow' }, h('h3', {}, r.name), h('div', { class: 'h-sub mono' }, `ON ${r.trigger_event}`)),
          pill(r.enabled ? 'ENABLED' : 'DISABLED')),
        h('div', { class: 'card-b stack sm' },
          kv([
            ['Action', (r.action_type || '').replace(/_/g, ' ')],
            ['Requires approval', r.requires_approval ? 'Yes — human gate' : 'Notify only'],
            ['Last fired', r.last_fired_at ? fmtDT(r.last_fired_at) : 'never'],
          ]),
          r.last_fired_at ? h('span', { class: 'tiny faint' }, 'Fired recently — check AI Action Log for prepared drafts.') : h('span', { class: 'tiny faint' }, 'Waiting for trigger.'),
        )))),
      !rules.length ? h('div', { class: 'card' }, h('div', { class: 'empty' }, h('div', { class: 'e-ico' }, iconEl('automation', 22)), h('div', { class: 'e-title' }, 'No automation rules'), h('div', { class: 'e-msg' }, 'e.g. StockLow → draft purchase requisition assigned to procurement.'))) : null);
  }

  function ruleModal() {
    const name = input({ placeholder: 'e.g. Low stock → purchase draft' });
    const trigger = select(['StockLow', 'SaleCompleted', 'PaymentFailed', 'SupplierInvoiceOverdue', 'LeadCreated']);
    const action = select([{ value: 'CREATE_PURCHASE_RECOMMENDATION', label: 'Prepare purchase draft' }, { value: 'NOTIFY', label: 'Notify a role' }, { value: 'ESCALATE', label: 'Escalate to owner' }, { value: 'PREPARE_TASK', label: 'Prepare a task' }]);
    const submit = btn('Arm rule', { cls: 'primary', ico: 'automation' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim()) return toast.warn('Name required');
      try {
        await api.post('/api/v1/automation/rules', { name: name.value.trim(), trigger_event: trigger.value, action_type: action.value, action: { message: name.value.trim() }, requires_approval: true });
        toast.ok('Automation armed', 'It will prepare work whenever the trigger fires.');
        document.getElementById('overlays').replaceChildren();
        load();
      } catch (e) { presentError(e); }
    });
    modal({
      title: 'New automation rule', ico: 'automation', width: 'narrow',
      body: h('div', {}, field('NAME', name), field('TRIGGER EVENT', trigger), field('ACTION (ALWAYS DRAFT)', action)),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(pageHead('Automation', 'If-this-then-prepared-that'), bodyEl);
  await load();
}
