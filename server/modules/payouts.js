import { q, nowIso } from '../db/connection.js';
import { err } from '../core/http.js';
import { createIntent, initiateIntent, verifyAndSettle } from './payments.js';
import { postSupplierPayment, postPayrollExecuted, postCommissionPaid, postExpensePaid } from './ledger.js';

/**
 * Outbound payout helper (§26): supplier payments, worker payroll,
 * broker commissions, expense payments.
 * Caller performs the authorization (permission-checked upstream); every
 * execution records intent + authorization + provider ref + ledger + audit.
 * Sandbox provider auto-disburses and is clearly marked sandbox.
 */
const PROVIDER_FOR = { MPESA: 'mpesa_sandbox', CASH: 'cash', BANK: 'bank_manual', CARD: 'card_sandbox' };

export function createOutboundPayout(db, { tenantId, payeeType, payeeId, purpose, amount, method = 'MPESA', actorId, refId = null, description = null }) {
  if (!Number.isInteger(amount) || amount <= 0) throw err.unprocessable('amount must be positive minor units');
  const provider = PROVIDER_FOR[method];
  if (!provider) throw err.unprocessable(`Unsupported payout method: ${method}`);
  const idem = `payout-${purpose}-${refId || `${Date.now()}`}`;
  const { intent } = createIntent(db, {
    tenantId, purpose, payeeType, payeeId, amount,
    provider, method, idempotencyKey: idem, meta: { outbound: true, description },
  });
  q.run(db, `UPDATE payment_intents SET authorized_by = ?, authorized_at = ? WHERE id = ? AND authorized_by IS NULL`,
    actorId, nowIso(), intent.id);
  initiateIntent(db, tenantId, intent.id);
  // Sandbox disbursement: in sandbox the provider completes immediately.
  const current = q.one(db, `SELECT * FROM payment_intents WHERE id = ?`, intent.id);
  if (current.provider === 'mpesa_sandbox' && current.provider_ref) {
    q.run(db, `UPDATE sandbox_provider_records SET status = 'SUCCESS', receipt_no = ?, updated_at = ?
               WHERE provider_ref = ? AND status = 'PENDING'`,
      `B2C${Math.random().toString(36).slice(2, 8).toUpperCase()}`, nowIso(), current.provider_ref);
  }
  if (current.provider === 'cash') {
    const { getProvider } = adapters();
    getProvider('cash').confirmReceived(db, current, amount, actorId);
  }
  if (current.provider === 'bank_manual') {
    q.run(db, `UPDATE sandbox_provider_records SET status = 'SUCCESS', receipt_no = ?, updated_at = ? WHERE provider_ref = ?`,
      `BNK${Math.random().toString(36).slice(2, 8).toUpperCase()}`, nowIso(), current.provider_ref);
  }
  const settled = verifyAndSettle(db, tenantId, intent.id, actorId);
  if (!settled.payment) throw err.conflict('Payout could not be verified with provider');
  // Ledger by purpose
  const posts = {
    BROKER_COMMISSION: () => postCommissionPaid(db, tenantId, { amount, method, refId: refId || intent.id, actorId }),
    WORKER_PAYMENT: () => { /* payroll run posts aggregate entry at execution */ },
    SUPPLIER_PAYMENT: () => postSupplierPayment(db, tenantId, { amount, method, refId: refId || intent.id, actorId }),
    EXPENSE: () => postExpensePaid(db, tenantId, { amount, method, refId: refId || intent.id, actorId }),
  };
  posts[purpose]?.();
  return { payment_id: settled.payment.id, reference: settled.payment.reference, amount };
}

/** Payroll execution posts one aggregate journal for the run. */
export function postPayrollRun(db, tenantId, { total, method, runId, actorId }) {
  return postPayrollExecuted(db, tenantId, { total, method, refId: runId, actorId });
}
function adapters() { return adaptersModule; }
import * as adaptersModule from '../adapters/payments.js';
