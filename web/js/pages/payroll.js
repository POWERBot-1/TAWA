/** Payroll — calculate → review → approve → execute (segregated duties, idempotent execution). */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, iconEl, timeline } from '../ui.js';

export async function render(el) {
  let runs = [];
  const bodyEl = h('div', {});

  async function load() {
    try { runs = await api.get('/api/v1/payroll/runs'); paint(); } catch (e) { presentError(e); }
  }

  function paint() {
    bodyEl.replaceChildren(
      h('div', { class: 'demo-hint row', style: { gap: '10px' } }, iconEl('shield-check', 15),
        h('span', {}, 'Pipeline: CALCULATED → REVIEWED → APPROVED → EXECUTED. No two steps may be executed by the same person; execution is idempotent.')),
      h('div', { class: 'card' }, table([
        { label: 'Run', render: r => h('div', {}, h('div', { class: 't-main mono' }, r.number), h('div', { class: 't-sub' }, `${fmtDate(r.period_start)} → ${fmtDate(r.period_end)}`)) },
        { label: 'Workers', align: 'c', render: r => h('span', { class: 'mono' }, fmtNum((r.items || []).length)) },
        { label: 'Gross', align: 'r', render: r => h('span', { class: 'num' }, fmtMoney(r.total_gross)) },
        { label: 'Net payable', align: 'r', render: r => h('span', { class: 'num strong' }, fmtMoney(r.total_net)) },
        { label: 'Status', render: r => pill(r.status) },
        { label: 'Created', render: r => h('span', { class: 'tiny muted' }, fmtDT(r.created_at)) },
      ], runs, { onRow: openRun, emptyTitle: 'No payroll runs', emptyMsg: 'Calculate a run for a period — attendance drives daily-wage computation.', ico: 'payroll' })));
  }

  function openRun(r) {
    const bodyEl = h('div', { class: 'stack' });
    const paintDetail = () => {
      const items = r.items || [];
      bodyEl.replaceChildren(
        kv([['Period', `${fmtDate(r.period_start)} → ${fmtDate(r.period_end)}`], ['Gross', fmtMoney(r.total_gross)], ['Net', fmtMoney(r.total_net)], ['Status', pill(r.status)]]),
        h('div', { class: 'row wrap' },
          r.status === 'CALCULATED' && store.can('payroll.review') ? btn('Mark reviewed', { cls: 'sm', ico: 'eye', onClick: () => step('review', 'Review recorded') }) : null,
          r.status === 'REVIEWED' && store.can('payroll.approve') ? btn('Approve run', { cls: 'primary sm', ico: 'approve', onClick: () => step('approve', 'Approved — payroll liability posted') }) : null,
          r.status === 'APPROVED' && store.can('payroll.execute') ? btn('Execute payments', { cls: 'primary sm', ico: 'bolt', onClick: executeModal }) : null,
          r.status === 'EXECUTED' ? h('span', { class: 'pill ok' }, h('span', { class: 'pdot' }), 'SETTLED') : null),
        card({
          title: `Payslips (${items.length})`, flush: true,
          body: table([
            { label: 'Worker', render: i => h('div', {}, h('div', { class: 't-main' }, i.worker_name), h('div', { class: 't-sub mono' }, i.wage_type)) },
            { label: 'Days', align: 'c', render: i => h('span', { class: 'mono' }, fmtNum(i.days_worked)) },
            { label: 'Gross', align: 'r', render: i => h('span', { class: 'num' }, fmtMoney(i.gross)) },
            { label: 'Net', align: 'r', render: i => h('span', { class: 'num strong' }, fmtMoney(i.net)) },
            { label: 'Status', render: i => pill(i.status) },
            { label: 'Paid ref', render: i => h('span', { class: 'tiny mono muted' }, i.paid_ref || '—') },
          ], items),
        }),
        h('p', { class: 'tiny faint', style: { margin: 0 } }, 'Approval posts payroll liability (credit 2010 · debit payroll expense). Execution pays workers via outbound payouts and clears the liability.'));
    };
    async function step(kind, msg) {
      try {
        r = await api.post(`/api/v1/payroll/runs/${r.id}/${kind}`, {});
        toast.ok(msg, r.number);
        r.items = (await api.get('/api/v1/payroll/runs')).find(x => x.id === r.id)?.items || [];
        paintDetail(); load();
      } catch (e) { presentError(e, 'Transition rejected'); }
    }
    function executeModal() {
      const method = select([{ value: 'MPESA', label: 'M-Pesa (sandbox)' }, { value: 'CASH', label: 'Cash' }, { value: 'BANK', label: 'Bank' }]);
      const submit = btn(`Execute ${fmtMoney(r.total_net)}`, { cls: 'primary', ico: 'bolt' });
      submit.addEventListener('click', async () => {
        try {
          const res = await api.post(`/api/v1/payroll/runs/${r.id}/execute`, { method: method.value });
          toast.ok(res.replayed ? 'Already executed — replayed safely' : 'Payroll executed', 'Workers notified (sandbox SMS).');
          document.getElementById('overlays').replaceChildren();
          r = res.run || r;
          r.items = (await api.get('/api/v1/payroll/runs')).find(x => x.id === r.id)?.items || [];
          paintDetail(); load();
        } catch (e) { presentError(e, 'Execution refused'); }
      });
      modal({
        title: 'Execute payroll', sub: r.number, ico: 'bolt', width: 'narrow',
        body: h('div', {}, field('PAYOUT METHOD', method),
          h('p', { class: 'tiny faint' }, 'Each worker receives an outbound payout with a unique reference. Re-running is safe — the run settles exactly once.')),
        foot: h('div', { class: 'right' }, submit),
      });
    }
    paintDetail();
    drawer({ title: r.number, sub: 'Payroll run', ico: 'payroll', body: bodyEl });
  }

  function calculateModal() {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    const end = today.toISOString().slice(0, 10);
    const ps = input({ type: 'date', value: start });
    const pe = input({ type: 'date', value: end });
    const assume = h('input', { type: 'checkbox', checked: true });
    const submit = btn('Calculate run', { cls: 'primary', ico: 'payroll' });
    submit.addEventListener('click', async () => {
      try {
        const run = await api.post('/api/v1/payroll/calculate', { period_start: ps.value, period_end: pe.value, assume_full: assume.checked });
        toast.ok('Run calculated', run.number);
        document.getElementById('overlays').replaceChildren();
        await load();
        const full = runs.find(x => x.id === run.id);
        if (full) openRun(full);
      } catch (e) { presentError(e, 'Could not calculate'); }
    });
    modal({
      title: 'New payroll run', ico: 'payroll', width: 'narrow',
      body: h('div', {},
        h('div', { class: 'form-row' }, field('PERIOD START', ps), field('PERIOD END', pe)),
        h('label', { class: 'checkbox' }, assume, 'Assume full attendance for daily-wage workers (otherwise attendance drives pay)')),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  el.replaceChildren(
    pageHead('Payroll', 'Calculate → review → approve → execute',
      store.can('payroll.calculate') ? btn('Calculate payroll', { cls: 'primary', ico: 'plus', onClick: calculateModal }) : null),
    bodyEl);
  await load();
}
