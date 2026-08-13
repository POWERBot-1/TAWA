/** Workforce — workers, attendance, chore board (tasks), performance. */
import { api } from '../api.js';
import { store } from '../store.js';
import { h, pageHead, card, btn, table, pill, fmtMoney, fmtDT, fmtDate, fmtNum, toast, presentError, drawer, modal, field, input, select, kv, iconEl, tabs } from '../ui.js';

const TASK_STATES = ['PENDING', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED'];
const NEXT_ACTIONS = {
  PENDING: ['ACKNOWLEDGED', 'CANCELLED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'DECLINED'],
  IN_PROGRESS: ['COMPLETED', 'BLOCKED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['VERIFIED'],
};

export async function render(el) {
  const state = { tab: 'workers', workers: [], tasks: [] };
  const tabBar = h('div', {});
  const bodyEl = h('div', {});

  async function loadWorkers() { state.workers = await api.get('/api/v1/workers'); }
  async function loadTasks() { state.tasks = await api.get('/api/v1/tasks', { limit: 100 }); }

  function paint() {
    tabBar.replaceChildren(tabs([
      { id: 'workers', label: 'Workers', count: state.workers.length },
      { id: 'board', label: 'Chore board', count: state.tasks.filter(t => !['VERIFIED', 'CANCELLED', 'DECLINED'].includes(t.status)).length },
    ], state.tab, async (t) => { state.tab = t; t === 'board' ? await loadTasks() : await loadWorkers(); paint(); }));
    bodyEl.replaceChildren(state.tab === 'workers' ? workersView() : boardView());
  }

  function workersView() {
    return h('div', { class: 'stack' },
      h('div', { class: 'row end wrap' },
        store.can('workers.manage') ? btn('Mark today’s attendance', { ico: 'calendar', onClick: attendanceModal }) : null,
        store.can('workers.manage') ? btn('New worker', { cls: 'primary', ico: 'plus', onClick: workerModal }) : null),
      h('div', { class: 'card' }, table([
        { label: 'Worker', render: r => h('div', {}, h('div', { class: 't-main' }, r.name), h('div', { class: 't-sub mono' }, `${r.code} · ${r.role_title}`)) },
        { label: 'Phone', render: r => h('span', { class: 'tiny mono' }, r.phone || '—') },
        { label: 'Wage', render: r => h('span', { class: 'tiny' }, h('span', { class: 'mono' }, fmtMoney(r.base_pay)), ` / ${String(r.wage_type).toLowerCase()}`) },
        { label: 'Branch', render: r => h('span', { class: 'tiny muted' }, r.branch_name || '—') },
        { label: 'Open tasks', align: 'c', render: r => h('span', { class: 'mono', style: { color: r.open_tasks ? 'var(--warn)' : 'var(--text-3)' } }, fmtNum(r.open_tasks)) },
        { label: 'Verified', align: 'c', render: r => h('span', { class: 'mono', style: { color: 'var(--ok)' } }, fmtNum(r.verified_tasks)) },
        { label: 'Status', render: r => pill(r.status) },
      ], state.workers, { onRow: openWorker, emptyTitle: 'No workers', ico: 'workers' })));
  }

  async function openWorker(w) {
    let perf = null;
    try { perf = store.has('TAWA.PERFORMANCE') ? await api.get(`/api/v1/workers/${w.id}/performance`) : null; } catch { perf = null; }
    drawer({
      title: w.name, sub: `${w.code} · ${w.role_title}`, ico: 'workers',
      body: h('div', { class: 'stack' },
        card({ title: 'Record', body: kv([
          ['Wage', `${fmtMoney(w.base_pay)} / ${String(w.wage_type).toLowerCase()}`],
          ['Phone', w.phone || '—'],
          ['Branch', w.branch_name || '—'],
          ['Skills', safeArr(w.skills).join(', ') || '—'],
          ['Hired', w.hired_at ? fmtDate(w.hired_at) : '—'],
          ['Open tasks', fmtNum(w.open_tasks)],
        ]) }),
        perf ? card({
          title: 'Performance (30d)', sub: perf.explanation,
          body: h('div', { class: 'stack sm' },
            h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Attendance'), h('span', { class: 'num strong' }, `${perf.attendance_30d?.present ?? 0}/${perf.attendance_30d?.days ?? 0} days`)),
            h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Tasks verified'), h('span', { class: 'num strong' }, fmtNum(perf.verified_tasks ?? perf.verified ?? 0))),
            h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Score'), h('span', { class: 'num strong', style: { color: 'var(--brand)' } }, perf.score != null ? fmtNum(perf.score) : '—'))),
        }) : null),
    });
  }

  function attendanceModal() {
    const day = new Date().toISOString().slice(0, 10);
    const rows = state.workers.filter(w => w.status === 'ACTIVE').map(w => {
      const sel = select([{ value: 'PRESENT', label: 'Present' }, { value: 'HALF_DAY', label: 'Half day' }, { value: 'ABSENT', label: 'Absent' }], { value: 'PRESENT' });
      return { w, sel };
    });
    const submit = btn('Save attendance', { cls: 'primary', ico: 'approve' });
    submit.addEventListener('click', async () => {
      try {
        for (const { w, sel } of rows) await api.post(`/api/v1/workers/${w.id}/attendance`, { day, status: sel.value });
        toast.ok(`Attendance saved for ${rows.length} workers`, day);
        document.getElementById('overlays').replaceChildren();
      } catch (e) { presentError(e); }
    });
    modal({
      title: `Attendance — ${day}`, ico: 'calendar', width: 'narrow',
      body: h('div', { class: 'stack sm' }, rows.map(({ w, sel }) => h('div', { class: 'row between' }, h('span', {}, w.name), sel))),
      foot: h('div', { class: 'right' }, submit),
    });
  }

  function workerModal() {
    const name = input({ placeholder: 'Full name' });
    const phone = input({ placeholder: '+254…' });
    const role = select(['GENERAL_WORKER', 'STOREKEEPER', 'DRIVER', 'DELIVERY_WORKER', 'CASHIER', 'SUPERVISOR']);
    const wageType = select(['DAILY', 'WEEKLY', 'MONTHLY']);
    const pay = input({ type: 'number', min: '0', step: '0.01', value: '1200' });
    const submit = btn('Hire worker', { cls: 'primary', ico: 'plus' });
    submit.addEventListener('click', async () => {
      if (!name.value.trim()) return toast.warn('Name required');
      try {
        await api.post('/api/v1/workers', { name: name.value.trim(), phone: phone.value || undefined, role_title: role.value, wage_type: wageType.value, base_pay: +pay.value });
        toast.ok('Worker hired', name.value.trim());
        document.getElementById('overlays').replaceChildren();
        await loadWorkers(); paint();
      } catch (e) { presentError(e); }
    });
    modal({ title: 'New worker', ico: 'workers', width: 'narrow', body: h('div', {}, field('NAME', name), field('PHONE', phone), h('div', { class: 'form-row' }, field('ROLE', role), field('WAGE TYPE', wageType)), field('BASE PAY (KES)', pay, { hint: 'Per day/week/month per wage type' })), foot: h('div', { class: 'right' }, submit) });
  }

  /* ---------------- chore board ---------------- */
  function boardView() {
    const cols = [
      { id: 'PENDING', label: 'Pending', states: ['PENDING'] },
      { id: 'ACTIVE', label: 'Acknowledged', states: ['ACKNOWLEDGED', 'IN_PROGRESS'] },
      { id: 'REVIEW', label: 'Completed', states: ['COMPLETED', 'BLOCKED'] },
      { id: 'CLOSED', label: 'Verified', states: ['VERIFIED'] },
    ];
    return h('div', { class: 'stack' },
      h('div', { class: 'row end' }, store.can('tasks.assign') ? btn('New task', { cls: 'primary', ico: 'plus', onClick: taskModal }) : null),
      h('div', { class: 'board' }, cols.map(col =>
        h('div', { class: 'board-col' },
          h('h4', {}, col.label, h('span', { class: 'cnt mono', style: { marginLeft: 'auto' } }, String(state.tasks.filter(t => col.states.includes(t.status)).length))),
          state.tasks.filter(t => col.states.includes(t.status)).map(t => taskCard(t))))));
  }

  function taskCard(t) {
    return h('div', { class: 'task-card', onClick: () => taskDrawer(t) },
      h('div', { class: 'tc-t' }, t.title),
      h('div', { class: 'tc-m' }, t.assignee_name || 'Unassigned'),
      h('div', { class: 'tc-foot' },
        pill(t.status),
        t.priority ? h('span', { class: 'badge-soft tiny' }, t.priority) : null,
        t.due_at ? h('span', { class: 'tiny faint', style: { marginLeft: 'auto' } }, fmtDate(t.due_at)) : null));
  }

  function taskDrawer(t) {
    const actions = h('div', { class: 'row wrap' });
    const next = NEXT_ACTIONS[t.status] || [];
    for (const to of next) {
      if (to === 'VERIFIED' && !store.can('tasks.verify')) continue;
      actions.appendChild(btn(labelFor(to), { cls: to === 'VERIFIED' ? 'primary sm' : 'sm', onClick: () => move(t, to) }));
    }
    async function move(task, to) {
      try {
        await api.post(`/api/v1/tasks/${task.id}/transition`, { to });
        toast.ok(`Task ${String(to).toLowerCase()}`, task.title);
        document.getElementById('overlays').replaceChildren();
        await loadTasks(); paint();
      } catch (e) { presentError(e); }
    }
    drawer({
      title: t.title, sub: `${t.assignee_name || 'Unassigned'}`, ico: 'tasks',
      body: h('div', { class: 'stack' },
        kv([['Status', pill(t.status)], ['Priority', t.priority || 'NORMAL'], ['Due', t.due_at ? fmtDate(t.due_at) : '—'], ['Created', fmtDT(t.created_at)]]),
        t.description ? h('p', { class: 'muted', style: { margin: 0 } }, t.description) : null,
        actions,
        h('p', { class: 'tiny faint' }, 'Verification is a separate duty — only managers with tasks.verify can close a task as VERIFIED.')),
    });
  }

  function taskModal() {
    const title = input({ placeholder: 'e.g. Restock roofing aisle' });
    const desc = input({ placeholder: 'Details (optional)' });
    const assignee = select([{ value: '', label: 'Unassigned' }, ...state.workers.map(w => ({ value: w.id, label: w.name }))]);
    const priority = select(['NORMAL', 'HIGH', 'URGENT']);
    const submit = btn('Assign task', { cls: 'primary', ico: 'send' });
    submit.addEventListener('click', async () => {
      if (!title.value.trim()) return toast.warn('Title required');
      try {
        await api.post('/api/v1/tasks', { title: title.value.trim(), description: desc.value || undefined, assignee_id: assignee.value || undefined, priority: priority.value });
        toast.ok('Task created', title.value.trim());
        document.getElementById('overlays').replaceChildren();
        await loadTasks(); paint();
      } catch (e) { presentError(e); }
    });
    modal({ title: 'New task', ico: 'tasks', width: 'narrow', body: h('div', {}, field('TASK', title), field('DETAILS', desc), h('div', { class: 'form-row' }, field('ASSIGNEE', assignee), field('PRIORITY', priority))), foot: h('div', { class: 'right' }, submit) });
  }

  function labelFor(s) { return { ACKNOWLEDGED: 'Acknowledge', IN_PROGRESS: 'Start work', COMPLETED: 'Mark completed', VERIFIED: 'Verify & close', DECLINED: 'Decline', BLOCKED: 'Mark blocked', CANCELLED: 'Cancel' }[s] || s; }
  function safeArr(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

  el.replaceChildren(pageHead('Workforce', 'People, attendance, tasks & performance'), tabBar, bodyEl);
  await loadWorkers(); paint();
}
