import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqOneOf } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { emitEvent } from '../core/events.js';
import { docNo, trialBalance, profitAndLoss, balanceSheet, verifyLedgerIntegrity, accountByCode, postExpenseApproved } from '../modules/ledger.js';
import { createOutboundPayout } from '../modules/payouts.js';
import { fmtMoney } from '../modules/payments.js';
import { csv } from './relationships.js';

export function registerMoney(router, db) {
  /* ---------------- Expenses (§28): SUBMIT → REVIEW → APPROVE → PAY → LEDGER ---------------- */
  router.get('/api/v1/expenses', (req, res) => {
    mustPerm(req, 'expenses.view');
    ok(res, q.all(db, `SELECT e.*, u.name AS submitted_by_name, ua.name AS approved_by_name FROM expenses e
      LEFT JOIN users u ON u.id = e.submitted_by LEFT JOIN users ua ON ua.id = e.approved_by
      WHERE e.tenant_id = ? ORDER BY e.created_at DESC LIMIT 200`, req.tenantId));
  });
  router.post('/api/v1/expenses', async (req, res) => {
    mustPerm(req, 'expenses.submit');
    const body = await readBody(req);
    const eid = id('exp');
    q.run(db, `INSERT INTO expenses (id, tenant_id, number, category, description, amount, status, payee, submitted_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?, 'SUBMITTED', ?,?,?,?)`,
      eid, req.tenantId, `EX-${docNo(db, req.tenantId, 'expense')}`,
      reqOneOf(reqStr(body.category, 'category'), 'category', ['RENT', 'ELECTRICITY', 'WATER', 'INTERNET', 'FUEL', 'DELIVERY', 'REPAIRS', 'SALARIES', 'SUPPLIER', 'MARKETING', 'TAXES', 'MISC']),
      optStr(body.description, 'description'),
      Math.round(reqNum(body.amount, 'amount', { min: 0.01 }) * 100),
      optStr(body.payee, 'payee'), req.auth.user.id, nowIso(), nowIso());
    created(res, q.one(db, `SELECT * FROM expenses WHERE id = ?`, eid));
  });
  router.post('/api/v1/expenses/:id/approve', (req, res) => {
    mustPerm(req, 'expenses.approve');
    const ex = mustExpense(db, req.tenantId, req.params.id);
    if (ex.status !== 'SUBMITTED') throw err.conflict(`Expense is ${ex.status}`);
    tx(db, () => {
      q.run(db, `UPDATE expenses SET status = 'APPROVED', approved_by = ?, updated_at = ? WHERE id = ?`, req.auth.user.id, nowIso(), ex.id);
      postExpenseApproved(db, req.tenantId, { amount: ex.amount, refId: ex.id, actorId: req.auth.user.id });
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'expense.approve', resource: 'expense', resourceId: ex.id, metadata: { amount: ex.amount } });
    ok(res, q.one(db, `SELECT * FROM expenses WHERE id = ?`, ex.id));
  });
  router.post('/api/v1/expenses/:id/reject', (req, res) => {
    mustPerm(req, 'expenses.approve');
    const ex = mustExpense(db, req.tenantId, req.params.id);
    if (ex.status !== 'SUBMITTED') throw err.conflict(`Expense is ${ex.status}`);
    q.run(db, `UPDATE expenses SET status = 'REJECTED', updated_at = ? WHERE id = ?`, nowIso(), ex.id);
    ok(res, q.one(db, `SELECT * FROM expenses WHERE id = ?`, ex.id));
  });
  router.post('/api/v1/expenses/:id/pay', async (req, res) => {
    mustPerm(req, 'expenses.pay');
    const ex = mustExpense(db, req.tenantId, req.params.id);
    if (ex.status === 'PAID') return ok(res, { expense: ex, replayed: true });
    if (ex.status !== 'APPROVED') throw err.conflict('Expense must be approved before payment');
    const body = await readBody(req);
    const method = body.method || 'MPESA';
    const out = tx(db, () => {
      const result = createOutboundPayout(db, { tenantId: req.tenantId, payeeType: 'EXPENSE', payeeId: ex.payee, purpose: 'EXPENSE', amount: ex.amount, method, actorId: req.auth.user.id, refId: ex.id, description: ex.description });
      q.run(db, `UPDATE expenses SET status = 'PAID', method = ?, paid_ref = ?, updated_at = ? WHERE id = ?`, method, result.reference, nowIso(), ex.id);
      return result;
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'expense.pay', resource: 'expense', resourceId: ex.id, metadata: { amount: ex.amount, method } });
    emitEvent(db, req.tenantId, 'ExpensePaid', { expense_id: ex.id, amount: fmtMoney(ex.amount) });
    ok(res, { payment: out });
  });

  /* ---------------- Accounting (§29) ---------------- */
  router.get('/api/v1/accounting/accounts', (req, res) => {
    mustPerm(req, 'accounting.view');
    ok(res, q.all(db, `SELECT * FROM ledger_accounts WHERE tenant_id = ? ORDER BY code`, req.tenantId));
  });
  router.get('/api/v1/accounting/journal', (req, res) => {
    mustPerm(req, 'accounting.view');
    const rows = q.all(db, `SELECT e.*, u.name AS actor_name FROM journal_entries e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.tenant_id = ? ORDER BY e.posted_at DESC LIMIT 300`, req.tenantId);
    for (const e of rows) e.lines = q.all(db, `SELECT l.debit, l.credit, a.code, a.name FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, e.id);
    ok(res, rows);
  });
  router.get('/api/v1/accounting/trial-balance', (req, res) => {
    mustPerm(req, 'accounting.view');
    ok(res, trialBalance(db, req.tenantId, { from: req.query.from || null, to: req.query.to || null }));
  });
  router.get('/api/v1/accounting/pnl', (req, res) => {
    mustPerm(req, 'accounting.view');
    ok(res, profitAndLoss(db, req.tenantId, { from: req.query.from || null, to: req.query.to || null }));
  });
  router.get('/api/v1/accounting/balance-sheet', (req, res) => {
    mustPerm(req, 'accounting.view');
    ok(res, balanceSheet(db, req.tenantId));
  });
  router.get('/api/v1/accounting/integrity', (req, res) => {
    mustPerm(req, 'accounting.view');
    ok(res, verifyLedgerIntegrity(db, req.tenantId));
  });
  router.get('/api/v1/accounting/journal.csv', (req, res) => {
    mustPerm(req, 'reports.export');
    const rows = q.all(db, `SELECT e.entry_no, e.posted_at, e.ref_type, e.memo, a.code, a.name, l.debit, l.credit
      FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN ledger_accounts a ON a.id = l.account_id
      WHERE e.tenant_id = ? ORDER BY e.posted_at DESC LIMIT 5000`, req.tenantId)
      .map(r => ({ ...r, debit: (r.debit / 100).toFixed(2), credit: (r.credit / 100).toFixed(2) }));
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'reports.export', metadata: { report: 'journal' } });
    csv(res, 'journal.csv', ['entry_no', 'posted_at', 'ref_type', 'memo', 'code', 'name', 'debit', 'credit'], rows);
  });
  router.get('/api/v1/accounting/reconcile', (req, res) => {
    mustPerm(req, 'accounting.view');
    const cash = accountByCode(db, req.tenantId, '1000');
    const mpesa = accountByCode(db, req.tenantId, '1020');
    const inbound = q.one(db, `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE tenant_id = ? AND direction = 'INBOUND' AND status != 'REVERSED'`, req.tenantId).s;
    const outbound = q.one(db, `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE tenant_id = ? AND direction = 'OUTBOUND' AND status != 'REVERSED'`, req.tenantId).s;
    const cashPos = q.one(db, `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS b FROM journal_lines WHERE account_id IN (?,?) AND tenant_id = ?`, cash.id, mpesa.id, req.tenantId).b;
    ok(res, {
      cash_and_mpesa_ledger_balance: cashPos,
      payments_inbound_total: inbound, payments_outbound_total: outbound,
      note: 'Position merges POs/expenses/payroll postings — compare against provider statements for full recon.',
    });
  });
}

function mustExpense(db, tenantId, eid) {
  const ex = q.one(db, `SELECT * FROM expenses WHERE id = ? AND tenant_id = ?`, eid, tenantId);
  if (!ex) throw err.notFound('Expense not found');
  return ex;
}
