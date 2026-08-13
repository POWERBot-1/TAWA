import { q, id, nowIso } from '../db/connection.js';
import { err } from '../core/http.js';

/**
 * Double-entry accounting (§29). Every financial event posts a balanced
 * journal entry. Journals are append-only (DB triggers). Totals are NEVER
 * UI counters — the ledger is the financial truth (§49 payments spec).
 */

export const COA = [
  ['1000', 'Cash on Hand', 'ASSET'],
  ['1010', 'Bank Account', 'ASSET'],
  ['1020', 'M-Pesa Float', 'ASSET'],
  ['1100', 'Accounts Receivable', 'ASSET'],
  ['1200', 'Inventory Asset', 'ASSET'],
  ['2000', 'Accounts Payable', 'LIABILITY'],
  ['2100', 'VAT Payable', 'LIABILITY'],
  ['2200', 'Wages Payable', 'LIABILITY'],
  ['2300', 'Commissions Payable', 'LIABILITY'],
  ['3000', "Owner's Equity", 'EQUITY'],
  ['3100', 'Retained Earnings', 'EQUITY'],
  ['4000', 'Sales Revenue', 'REVENUE'],
  ['4100', 'Delivery Income', 'REVENUE'],
  ['4900', 'Discounts & Refunds (contra)', 'REVENUE'],
  ['5000', 'Cost of Goods Sold', 'EXPENSE'],
  ['6000', 'Operating Expenses', 'EXPENSE'],
  ['6100', 'Payroll Expense', 'EXPENSE'],
  ['6200', 'Broker Commissions Expense', 'EXPENSE'],
  ['7000', 'Payment Processing Fees', 'EXPENSE'],
];

export function seedCoa(db, tenantId) {
  for (const [code, name, type] of COA) {
    q.run(db, `INSERT INTO ledger_accounts (id, tenant_id, code, name, type) VALUES (?,?,?,?,?)
               ON CONFLICT(tenant_id, code) DO NOTHING`, id('acct'), tenantId, code, name, type);
  }
}

export function accountByCode(db, tenantId, code) {
  const acct = q.one(db, `SELECT * FROM ledger_accounts WHERE tenant_id = ? AND code = ?`, tenantId, code);
  if (!acct) throw err.conflict(`Ledger account ${code} missing for tenant`);
  return acct;
}

function nextDocNo(db, tenantId, kind, pad = 6) {
  const row = q.one(db,
    `INSERT INTO doc_counters (tenant_id, kind, next) VALUES (?,?,2)
     ON CONFLICT(tenant_id, kind) DO UPDATE SET next = next + 1
     RETURNING next`, tenantId, kind);
  return String(row ? row.next - 1 : 1).padStart(pad, '0');
}
export const docNo = nextDocNo;

/**
 * Post a balanced journal entry. MUST be called inside a transaction.
 * Invariant: Σdebit == Σcredit, each line > 0, accounts exist in-tenant.
 */
export function postEntry(db, { tenantId, refType, refId, memo, lines, actorId = null }) {
  if (!lines || lines.length < 2) throw err.unprocessable('Journal needs at least two lines');
  let dr = 0, cr = 0;
  for (const l of lines) {
    const d = Number(l.debit || 0), c = Number(l.credit || 0);
    if (d < 0 || c < 0 || (d === 0 && c === 0) || (d > 0 && c > 0)) throw err.unprocessable('Invalid journal line: one of debit/credit must be positive');
    dr += d; cr += c;
  }
  if (dr !== cr || dr === 0) throw err.unprocessable(`Unbalanced journal entry: debits ${dr} ≠ credits ${cr}`);
  const entryId = id('je');
  const entryNo = nextDocNo(db, tenantId, 'journal');
  q.run(db, `INSERT INTO journal_entries (id, tenant_id, entry_no, ref_type, ref_id, memo, actor_id, posted_at)
             VALUES (?,?,?,?,?,?,?,?)`, entryId, tenantId, entryNo, refType || null, refId || null, memo || null, actorId, nowIso());
  for (const l of lines) {
    const acct = accountByCode(db, tenantId, l.account);
    q.run(db, `INSERT INTO journal_lines (id, entry_id, tenant_id, account_id, debit, credit) VALUES (?,?,?,?,?,?)`,
      id('jl'), entryId, tenantId, acct.id, Math.round(l.debit || 0), Math.round(l.credit || 0));
  }
  return { id: entryId, entry_no: entryNo };
}

/* ---------- Standard postings ---------- */
const METHOD_ACCOUNT = { CASH: '1000', BANK: '1010', MPESA: '1020', MOBILE_MONEY: '1020', CARD: '1010', CREDIT: '1100' };

export function postSaleReceipt(db, tenantId, { method, gross, net, vat, refId, actorId, memo }) {
  const lines = [{ account: METHOD_ACCOUNT[method] || '1020', debit: gross }];
  if (net > 0) lines.push({ account: '4000', credit: net });
  if (vat > 0) lines.push({ account: '2100', credit: vat });
  return postEntry(db, { tenantId, refType: 'payment', refId, memo: memo || 'Sale receipt', lines, actorId });
}

export function postCogs(db, tenantId, { cogs, refId, actorId }) {
  if (cogs <= 0) return null;
  return postEntry(db, { tenantId, refType: 'sale_cogs', refId, memo: 'COGS on fulfilment', actorId, lines: [
    { account: '5000', debit: cogs }, { account: '1200', credit: cogs },
  ] });
}

export function postCreditSale(db, tenantId, { gross, net, vat, refId, actorId }) {
  const lines = [{ account: '1100', debit: gross }];
  if (net > 0) lines.push({ account: '4000', credit: net });
  if (vat > 0) lines.push({ account: '2100', credit: vat });
  return postEntry(db, { tenantId, refType: 'credit', refId, memo: 'Credit sale — AR recognized', lines, actorId });
}

export function postCreditPayment(db, tenantId, { method, amount, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'payment', refId, memo: 'Credit settlement', actorId, lines: [
    { account: METHOD_ACCOUNT[method] || '1020', debit: amount }, { account: '1100', credit: amount },
  ] });
}

export function postExpenseApproved(db, tenantId, { amount, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'expense', refId, memo: 'Expense approved', actorId, lines: [
    { account: '6000', debit: amount }, { account: '2000', credit: amount },
  ] });
}
export function postExpensePaid(db, tenantId, { amount, method, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'expense_pay', refId, memo: 'Expense payment', actorId, lines: [
    { account: '2000', debit: amount }, { account: METHOD_ACCOUNT[method] || '1020', credit: amount },
  ] });
}

export function postSupplierInvoice(db, tenantId, { amount, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'supplier_invoice', refId, memo: 'Supplier invoice — inventory/AP', actorId, lines: [
    { account: '1200', debit: amount }, { account: '2000', credit: amount },
  ] });
}
export function postSupplierPayment(db, tenantId, { amount, method, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'supplier_payment', refId, memo: 'Supplier payment', actorId, lines: [
    { account: '2000', debit: amount }, { account: METHOD_ACCOUNT[method] || '1020', credit: amount },
  ] });
}

export function postPayrollApproved(db, tenantId, { total, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'payroll', refId, memo: 'Payroll approved — wages payable', actorId, lines: [
    { account: '6100', debit: total }, { account: '2200', credit: total },
  ] });
}
export function postPayrollExecuted(db, tenantId, { total, method, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'payroll_pay', refId, memo: 'Payroll executed', actorId, lines: [
    { account: '2200', debit: total }, { account: METHOD_ACCOUNT[method] || '1020', credit: total },
  ] });
}

export function postCommissionAccrued(db, tenantId, { amount, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'commission', refId, memo: 'Broker commission accrued', actorId, lines: [
    { account: '6200', debit: amount }, { account: '2300', credit: amount },
  ] });
}
export function postCommissionPaid(db, tenantId, { amount, method, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'commission_pay', refId, memo: 'Broker commission paid', actorId, lines: [
    { account: '2300', debit: amount }, { account: METHOD_ACCOUNT[method] || '1020', credit: amount },
  ] });
}

export function postRefund(db, tenantId, { amount, method, refId, actorId }) {
  return postEntry(db, { tenantId, refType: 'refund', refId, memo: 'Customer refund', actorId, lines: [
    { account: '4900', debit: amount }, { account: METHOD_ACCOUNT[method] || '1020', credit: amount },
  ] });
}

/* ---------- Statements ---------- */
export function trialBalance(db, tenantId, { from = null, to = null } = {}) {
  const rows = q.all(db, `
    SELECT a.code, a.name, a.type,
      COALESCE(SUM(l.debit),0) AS debits, COALESCE(SUM(l.credit),0) AS credits
    FROM ledger_accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    LEFT JOIN journal_entries e ON e.id = l.entry_id
      AND (? IS NULL OR e.posted_at >= ?) AND (? IS NULL OR e.posted_at <= ?)
    WHERE a.tenant_id = ? AND a.is_active = 1
    GROUP BY a.id ORDER BY a.code`, from, from, to, to, tenantId);
  let td = 0, tc = 0;
  for (const r of rows) { td += r.debits; tc += r.credits; r.balance = r.debits - r.credits; }
  return { accounts: rows, total_debits: td, total_credits: tc, balanced: td === tc };
}

export function profitAndLoss(db, tenantId, range = {}) {
  const tb = trialBalance(db, tenantId, range);
  const rev = tb.accounts.filter(a => a.type === 'REVENUE');
  const exp = tb.accounts.filter(a => a.type === 'EXPENSE');
  const revenue = rev.filter(a => !a.code.startsWith('49')).reduce((s, a) => s + (a.credits - a.debits), 0);
  const contra = rev.filter(a => a.code.startsWith('49')).reduce((s, a) => s + (a.debits - a.credits), 0);
  const cogs = exp.filter(a => a.code === '5000').reduce((s, a) => s + (a.debits - a.credits), 0);
  const opex = exp.filter(a => a.code !== '5000').reduce((s, a) => s + (a.debits - a.credits), 0);
  return {
    revenue, discounts_refunds: contra, net_revenue: revenue - contra,
    cogs, gross_profit: (revenue - contra) - cogs,
    opex, net_profit: (revenue - contra) - cogs - opex,
    lines: tb.accounts.filter(a => a.type === 'REVENUE' || a.type === 'EXPENSE'),
  };
}

export function balanceSheet(db, tenantId) {
  const tb = trialBalance(db, tenantId, {});
  const assets = tb.accounts.filter(a => a.type === 'ASSET').map(a => ({ ...a, value: a.debits - a.credits }));
  const liabs = tb.accounts.filter(a => a.type === 'LIABILITY').map(a => ({ ...a, value: a.credits - a.debits }));
  const eq = tb.accounts.filter(a => a.type === 'EQUITY').map(a => ({ ...a, value: a.credits - a.debits }));
  const pnl = profitAndLoss(db, tenantId);
  const totalAssets = assets.reduce((s, a) => s + a.value, 0);
  const totalLiabs = liabs.reduce((s, a) => s + a.value, 0);
  const totalEquity = eq.reduce((s, a) => s + a.value, 0) + pnl.net_profit;
  return { assets, liabilities: liabs, equity: [...eq, { code: 'P&L', name: 'Current period earnings', value: pnl.net_profit, type: 'EQUITY' }], total_assets: totalAssets, total_liabilities: totalLiabs, total_equity: totalEquity, balanced: totalAssets === totalLiabs + totalEquity };
}

/** Ledger integrity check: every entry balanced + overall balanced (§67). */
export function verifyLedgerIntegrity(db, tenantId) {
  const bad = q.all(db, `
    SELECT e.id, e.entry_no, SUM(l.debit) AS d, SUM(l.credit) AS c
    FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.tenant_id = ? GROUP BY e.id HAVING d != c`, tenantId);
  const tb = trialBalance(db, tenantId);
  return { ok: bad.length === 0 && tb.balanced, unbalanced_entries: bad, balanced: tb.balanced };
}
