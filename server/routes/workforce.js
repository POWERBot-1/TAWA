import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqOneOf, reqArr, pageParams } from '../core/http.js';
import { mustPerm, hasPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { emitEvent } from '../core/events.js';
import { docNo, postPayrollApproved } from '../modules/ledger.js';
import { createOutboundPayout, postPayrollRun } from '../modules/payouts.js';
import { sendNotification } from '../adapters/messaging.js';
import { fmtMoney } from '../modules/payments.js';

export function registerWorkforce(router, db) {
  /* ---------------- Workers (§22) ---------------- */
  router.get('/api/v1/workers', (req, res) => {
    mustPerm(req, 'workers.view');
    const rows = q.all(db, `SELECT w.*, b.name AS branch_name,
      (SELECT COUNT(*) FROM worker_tasks t WHERE t.assignee_id = w.id AND t.status IN ('ASSIGNED','ACKNOWLEDGED','IN_PROGRESS')) AS open_tasks,
      (SELECT COUNT(*) FROM worker_tasks t WHERE t.assignee_id = w.id AND t.status = 'VERIFIED') AS verified_tasks
      FROM workers w LEFT JOIN branches b ON b.id = w.branch_id WHERE w.tenant_id = ? ORDER BY w.name`, req.tenantId);
    ok(res, rows);
  });
  router.post('/api/v1/workers', async (req, res) => {
    mustPerm(req, 'workers.manage');
    const body = await readBody(req);
    const wid = id('wrk');
    q.run(db, `INSERT INTO workers (id, tenant_id, code, name, phone, role_title, branch_id, skills, wage_type, base_pay, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?)`,
      wid, req.tenantId, `W-${String(q.one(db, `SELECT COUNT(*) AS n FROM workers WHERE tenant_id = ?`, req.tenantId).n + 1).padStart(3, '0')}`,
      reqStr(body.name, 'name'), optStr(body.phone, 'phone'), optStr(body.role_title, 'role_title') || 'GENERAL_WORKER',
      body.branch_id || null, JSON.stringify(body.skills || []),
      reqOneOf(body.wage_type || 'DAILY', 'wage_type', ['MONTHLY', 'DAILY', 'WEEKLY', 'COMMISSION', 'CONTRACT']),
      Math.round(reqNum(body.base_pay ?? 0, 'base_pay', { min: 0 }) * 100), nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'worker.create', resource: 'worker', resourceId: wid });
    created(res, q.one(db, `SELECT * FROM workers WHERE id = ?`, wid));
  });

  router.get('/api/v1/workers/:id/performance', (req, res) => {
    mustPerm(req, 'workers.view');
    const w = q.one(db, `SELECT * FROM workers WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!w) throw err.notFound('Worker not found');
    const tasks = q.one(db, `SELECT
      COUNT(*) AS assigned,
      SUM(CASE WHEN status IN ('COMPLETED','VERIFIED') THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN status IN ('COMPLETED','VERIFIED') AND completed_at <= due_at THEN 1 ELSE 0 END) AS on_time
      FROM worker_tasks WHERE assignee_id = ? AND tenant_id = ?`, w.id, req.tenantId);
    const attendance = q.one(db, `SELECT COUNT(*) AS days, SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END) AS present
      FROM attendance WHERE worker_id = ? AND tenant_id = ? AND day >= ?`, w.id, req.tenantId, new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
    ok(res, {
      worker: { id: w.id, name: w.name, role_title: w.role_title },
      tasks: { ...tasks, on_time_rate: tasks.completed ? +(100 * (tasks.on_time || 0) / tasks.completed).toFixed(1) : null },
      attendance_30d: attendance,
      explanation: 'Metrics derive from verified task outcomes and attendance records only (§34, spec ext §34).',
    });
  });

  /* ---------------- Attendance ---------------- */
  router.post('/api/v1/workers/:id/attendance', async (req, res) => {
    mustPerm(req, 'workers.manage');
    const body = await readBody(req);
    const day = reqStr(body.day || new Date().toISOString().slice(0, 10), 'day');
    q.run(db, `INSERT INTO attendance (id, tenant_id, worker_id, day, status, hours, recorded_by, created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(worker_id, day) DO UPDATE SET status = excluded.status, hours = excluded.hours`,
      id('att'), req.tenantId, req.params.id, day,
      reqOneOf(body.status || 'PRESENT', 'status', ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE']),
      reqNum(body.hours ?? 8, 'hours', { min: 0, max: 24 }), req.auth.user.id, nowIso());
    created(res, { recorded: true, day });
  });

  /* ---------------- Tasks / Chore board (ext §24-31) ---------------- */
  router.get('/api/v1/tasks', (req, res) => {
    mustPerm(req, 'tasks.view');
    const filters = ['t.tenant_id = ?']; const params = [req.tenantId];
    if (req.query.assignee_id) { filters.push('t.assignee_id = ?'); params.push(req.query.assignee_id); }
    if (req.query.status) { filters.push('t.status = ?'); params.push(req.query.status); }
    // Drivers/workers see only their own tasks unless they can assign.
    if (!hasPerm(req, 'tasks.assign') && req.auth.user.linked_worker_id) { filters.push('t.assignee_id = ?'); params.push(req.auth.user.linked_worker_id); }
    ok(res, q.all(db, `SELECT t.*, w.name AS assignee_name, w.phone AS assignee_phone FROM worker_tasks t JOIN workers w ON w.id = t.assignee_id
      WHERE ${filters.join(' AND ')} ORDER BY CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, t.due_at LIMIT 200`, ...params));
  });

  router.post('/api/v1/tasks', async (req, res) => {
    mustPerm(req, 'tasks.assign');
    const body = await readBody(req);
    const taskId = id('tsk');
    const assignee = q.one(db, `SELECT * FROM workers WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`, reqStr(body.assignee_id, 'assignee_id'), req.tenantId);
    if (!assignee) throw err.notFound('Active worker not found');
    tx(db, () => {
      q.run(db, `INSERT INTO worker_tasks (id, tenant_id, title, description, category, priority, assignee_id, creator_id, branch_id, due_at, recurrence, ref_type, ref_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        taskId, req.tenantId, reqStr(body.title, 'title'), optStr(body.description, 'description'),
        optStr(body.category, 'category') || 'GENERAL',
        reqOneOf(body.priority || 'NORMAL', 'priority', ['LOW', 'NORMAL', 'HIGH', 'URGENT']),
        assignee.id, req.auth.user.id, body.branch_id || null, body.due_at || null, body.recurrence || null,
        body.ref_type || null, body.ref_id || null, nowIso(), nowIso());
    });
    // SMS channel — notification, never the source of truth (ext §23)
    if (body.notify_sms !== false && assignee.phone) {
      q.run(db, `UPDATE worker_tasks SET sms_notified = 1 WHERE id = ?`, taskId);
      sendNotification(db, {
        tenantId: req.tenantId, channel: 'SMS', recipientKind: 'WORKER', recipientId: assignee.id, toAddr: assignee.phone,
        body: `TASK ${taskId.slice(-8).toUpperCase()}: ${body.title}. Due: ${body.due_at ? new Date(body.due_at).toLocaleString('en-KE') : 'as soon as possible'}. Open TAWA to acknowledge.`,
        priority: body.priority === 'URGENT' ? 'HIGH' : 'NORMAL', kind: 'OPERATIONAL', eventType: 'TaskAssigned', refType: 'task', refId: taskId,
      });
    }
    emitEvent(db, req.tenantId, 'TaskCreated', { task_id: taskId, assignee: assignee.name }, req.auth.user.id);
    created(res, q.one(db, `SELECT * FROM worker_tasks WHERE id = ?`, taskId));
  });

  const TASK_FLOW = {
    ASSIGNED: ['ACKNOWLEDGED', 'DECLINED', 'CANCELLED'],
    ACKNOWLEDGED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'BLOCKED', 'CANCELLED'],
    COMPLETED: ['VERIFIED'],
    BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
    DECLINED: ['ASSIGNED'],
  };
  router.post('/api/v1/tasks/:id/transition', async (req, res) => {
    mustPerm(req, 'tasks.view');
    const body = await readBody(req);
    const to = reqOneOf(reqStr(body.to, 'to'), 'to', ['ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'DECLINED', 'BLOCKED', 'CANCELLED']);
    const t = q.one(db, `SELECT * FROM worker_tasks WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!t) throw err.notFound('Task not found');
    if (to === 'VERIFIED') mustPerm(req, 'tasks.verify');
    if (!(TASK_FLOW[t.status] || []).includes(to)) throw err.conflict(`Task cannot move from ${t.status} to ${to}`);
    const mine = req.auth.user.linked_worker_id === t.assignee_id;
    if (!mine && !hasPerm(req, 'tasks.assign') && to !== 'CANCELLED') throw err.forbidden('Only the assignee (or a manager) can update this task');
    tx(db, () => {
      q.run(db, `UPDATE worker_tasks SET status = ?, acknowledged_at = COALESCE(acknowledged_at, CASE WHEN ? = 'ACKNOWLEDGED' THEN ? END),
        completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END,
        verified_by = CASE WHEN ? = 'VERIFIED' THEN ? ELSE verified_by END, updated_at = ? WHERE id = ?`,
        to, to, nowIso(), to, nowIso(), to, req.auth.user.id, nowIso(), t.id);
      emitEvent(db, req.tenantId, `Task${to.charAt(0) + to.slice(1).toLowerCase()}`, { task_id: t.id, worker: t.assignee_id }, req.auth.user.id);
    });
    ok(res, q.one(db, `SELECT * FROM worker_tasks WHERE id = ?`, t.id));
  });

  /* ---------------- Payroll (§24) — CALCULATE → REVIEW → APPROVE → EXECUTE ---------------- */
  router.get('/api/v1/payroll/runs', (req, res) => {
    mustPerm(req, 'payroll.view');
    const rows = q.all(db, `SELECT * FROM payroll_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`, req.tenantId);
    for (const r of rows) r.items = q.all(db, `SELECT i.*, w.name AS worker_name, w.wage_type FROM payroll_items i JOIN workers w ON w.id = i.worker_id WHERE i.run_id = ?`, r.id);
    ok(res, rows);
  });

  router.post('/api/v1/payroll/calculate', async (req, res) => {
    mustPerm(req, 'payroll.calculate');
    const body = await readBody(req);
    const periodStart = reqStr(body.period_start, 'period_start');
    const periodEnd = reqStr(body.period_end, 'period_end');
    if (q.one(db, `SELECT id FROM payroll_runs WHERE tenant_id = ? AND period_start = ? AND period_end = ? AND status != 'CANCELLED'`, req.tenantId, periodStart, periodEnd)) {
      throw err.conflict('A payroll run for this period already exists');
    }
    const runId = id('pr');
    tx(db, () => {
      q.run(db, `INSERT INTO payroll_runs (id, tenant_id, number, period_start, period_end, status, total_gross, total_net, calculated_by, created_at, updated_at)
                 VALUES (?,?,?,?,?, 'CALCULATED', 0, 0, ?, ?, ?)`,
        runId, req.tenantId, `PAY-${docNo(db, req.tenantId, 'payroll')}`, periodStart, periodEnd, req.auth.user.id, nowIso(), nowIso());
      const workers = q.all(db, `SELECT * FROM workers WHERE tenant_id = ? AND status = 'ACTIVE'`, req.tenantId);
      const daysInPeriod = Math.max(1, Math.round((new Date(periodEnd) - new Date(periodStart)) / 86400_000) + 1);
      let totalGross = 0, totalNet = 0;
      for (const w of workers) {
        const att = q.one(db, `SELECT COUNT(*) AS present FROM attendance WHERE tenant_id = ? AND worker_id = ? AND day BETWEEN ? AND ? AND status IN ('PRESENT','HALF_DAY')`,
          req.tenantId, w.id, periodStart, periodEnd);
        let gross = w.base_pay;
        let daysWorked = daysInPeriod;
        if (w.wage_type === 'DAILY') { daysWorked = att.present || (body.assume_full ? daysInPeriod : 0); gross = w.base_pay * daysWorked; }
        if (w.wage_type === 'WEEKLY') { gross = w.base_pay * Math.ceil(daysInPeriod / 7); }
        const deductions = 0, advances = 0, allowances = 0, overtime = 0;
        const net = gross + allowances + overtime - deductions - advances;
        q.run(db, `INSERT INTO payroll_items (id, run_id, tenant_id, worker_id, days_worked, gross, allowances, overtime, deductions, advances, net)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          id('pri'), runId, req.tenantId, w.id, daysWorked, gross, allowances, overtime, deductions, advances, net);
        totalGross += gross; totalNet += net;
      }
      q.run(db, `UPDATE payroll_runs SET total_gross = ?, total_net = ?, updated_at = ? WHERE id = ?`, totalGross, totalNet, nowIso(), runId);
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'payroll.calculate', resource: 'payroll_run', resourceId: runId });
    created(res, q.one(db, `SELECT * FROM payroll_runs WHERE id = ?`, runId));
  });

  function moveRun(req, runId, from, to, perm, field) {
    const run = q.one(db, `SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?`, runId, req.tenantId);
    if (!run) throw err.notFound('Payroll run not found');
    if (run.status !== from) throw err.conflict(`Payroll run is ${run.status}; expected ${from}`);
    q.run(db, `UPDATE payroll_runs SET status = ?, ${field} = ?, updated_at = ? WHERE id = ?`, to, req.auth.user.id, nowIso(), runId);
    return run;
  }

  router.post('/api/v1/payroll/runs/:id/review', (req, res) => {
    mustPerm(req, 'payroll.review');
    moveRun(req, req.params.id, 'CALCULATED', 'REVIEWED', 'payroll.review', 'reviewed_by');
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'payroll.review', resource: 'payroll_run', resourceId: req.params.id });
    ok(res, q.one(db, `SELECT * FROM payroll_runs WHERE id = ?`, req.params.id));
  });

  router.post('/api/v1/payroll/runs/:id/approve', (req, res) => {
    mustPerm(req, 'payroll.approve'); // segregation of duties: approve ≠ calculate ≠ execute
    const run = q.one(db, `SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!run) throw err.notFound('Payroll run not found');
    if (run.status !== 'REVIEWED') throw err.conflict(`Payroll run is ${run.status}; expected REVIEWED`);
    if (run.reviewed_by === req.auth.user.id) throw err.forbidden('Same person cannot review and approve (segregation of duties)');
    tx(db, () => {
      q.run(db, `UPDATE payroll_runs SET status = 'APPROVED', approved_by = ?, updated_at = ? WHERE id = ?`, req.auth.user.id, nowIso(), run.id);
      postPayrollApproved(db, req.tenantId, { total: run.total_net, refId: run.id, actorId: req.auth.user.id });
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'payroll.approve', resource: 'payroll_run', resourceId: run.id, metadata: { total_net: run.total_net } });
    emitEvent(db, req.tenantId, 'WorkerPayrollApproved', { run_id: run.id, total: fmtMoney(run.total_net) });
    ok(res, q.one(db, `SELECT * FROM payroll_runs WHERE id = ?`, run.id));
  });

  /** Execute: AUTHORIZE PAYMENT → EXECUTE → LEDGER → notify each worker (§24). Idempotent. */
  router.post('/api/v1/payroll/runs/:id/execute', async (req, res) => {
    mustPerm(req, 'payroll.execute');
    const body = await readBody(req);
    const run = q.one(db, `SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!run) throw err.notFound('Payroll run not found');
    if (run.status === 'EXECUTED') return ok(res, { run, replayed: true });
    if (run.status !== 'APPROVED') throw err.conflict(`Payroll run is ${run.status}; must be APPROVED before execution`);
    if (run.approved_by === req.auth.user.id && !hasPerm(req, 'billing.manage')) {
      throw err.forbidden('Approver cannot execute their own approval (segregation of duties)');
    }
    const method = body.method || 'MPESA';
    tx(db, () => {
      const items = q.all(db, `SELECT i.*, w.name AS worker_name, w.phone FROM payroll_items i JOIN workers w ON w.id = i.worker_id WHERE i.run_id = ? AND i.status = 'PENDING'`, run.id);
      for (const item of items) {
        if (item.net <= 0) { q.run(db, `UPDATE payroll_items SET status = 'PAID', paid_ref = 'ZERO-NET' WHERE id = ?`, item.id); continue; }
        const out = createOutboundPayout(db, {
          tenantId: req.tenantId, payeeType: 'WORKER', payeeId: item.worker_id, purpose: 'WORKER_PAYMENT',
          amount: item.net, method, actorId: req.auth.user.id, refId: `${run.id}:${item.worker_id}`, description: `Payroll ${run.number}`,
        });
        q.run(db, `UPDATE payroll_items SET status = 'PAID', paid_ref = ? WHERE id = ?`, out.reference, item.id);
        if (item.phone) sendNotification(db, {
          tenantId: req.tenantId, channel: 'SMS', recipientKind: 'WORKER', recipientId: item.worker_id, toAddr: item.phone,
          body: `Payment of ${fmtMoney(item.net)} for payroll ${run.number} has been processed. Ref: ${out.reference}.`,
          eventType: 'WorkerPaymentVerified', refType: 'payroll', refId: run.id,
        });
      }
      q.run(db, `UPDATE payroll_runs SET status = 'EXECUTED', executed_by = ?, executed_at = ?, updated_at = ? WHERE id = ?`, req.auth.user.id, nowIso(), nowIso(), run.id);
      postPayrollRun(db, req.tenantId, { total: run.total_net, method, runId: run.id, actorId: req.auth.user.id });
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'payroll.execute', resource: 'payroll_run', resourceId: run.id, metadata: { total_net: run.total_net, method } });
    emitEvent(db, req.tenantId, 'PayrollExecuted', { run_id: run.id, total: fmtMoney(run.total_net) });
    ok(res, q.one(db, `SELECT * FROM payroll_runs WHERE id = ?`, run.id));
  });
}
