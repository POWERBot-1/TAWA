import crypto from 'node:crypto';
import { q, id, nowIso } from '../db/connection.js';
import { err } from '../core/http.js';
import { getProvider } from '../adapters/payments.js';
import { emitEvent } from '../core/events.js';
import { audit } from '../core/audit.js';
import { postSaleReceipt, postCreditPayment, postRefund } from './ledger.js';
import { sendNotification } from '../adapters/messaging.js';
import { meter } from '../core/entitlements.js';

/**
 * Payment Engine (§25, payment gateway spec §16-31).
 * INTENT → PROVIDER → SERVER-SIDE VERIFICATION → LEDGER → RECONCILIATION.
 * A payment NEVER becomes settled because the client says so.
 * All creation/verification is idempotent.
 */

// Legal state machine (§19). Client input can never force a transition.
const TRANSITIONS = {
  CREATED: ['REQUIRES_ACTION', 'PROCESSING', 'CANCELLED', 'EXPIRED'],
  REQUIRES_ACTION: ['PROCESSING', 'VERIFIED', 'CANCELLED', 'EXPIRED'],
  PROCESSING: ['PROVIDER_CONFIRMED', 'VERIFIED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PROVIDER_CONFIRMED: ['VERIFIED', 'SETTLED', 'FAILED'],
  VERIFIED: ['SETTLED', 'FAILED'],
  SETTLED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  FAILED: [], CANCELLED: [], EXPIRED: [], REFUNDED: [],
};

function transition(intent, to) {
  if (!(TRANSITIONS[intent.status] || []).includes(to)) {
    throw err.conflict(`Illegal payment state transition ${intent.status} → ${to}`);
  }
}

export function getIntent(db, tenantId, intentId) {
  const intent = q.one(db, `SELECT * FROM payment_intents WHERE id = ? AND tenant_id = ?`, intentId, tenantId);
  if (!intent) throw err.notFound('Payment intent not found');
  return intent;
}

/** Create a payment intent. Idempotent via (tenant_id, idempotency_key). */
export function createIntent(db, { tenantId, orderId = null, customerId = null, purpose = 'SALE', payeeType = 'TENANT', payeeId = null, amount, currency = 'KES', provider, method, phone = null, idempotencyKey, meta = {}, expiresInMinutes = 60 }) {
  if (!idempotencyKey) throw err.unprocessable('idempotency_key is required');
  const existing = q.one(db, `SELECT * FROM payment_intents WHERE tenant_id = ? AND idempotency_key = ?`, tenantId, idempotencyKey);
  if (existing) return { intent: existing, replayed: true };
  if (!getProvider(provider)) throw err.unprocessable(`Unknown provider: ${provider}`);
  // Tenant payment isolation (§32): a tenant may disable a provider entirely — fail closed everywhere.
  const pcfg = q.one(db, `SELECT enabled FROM payments_config WHERE tenant_id = ? AND provider = ?`, tenantId, provider);
  if (pcfg && !pcfg.enabled) throw err.unprocessable(`Provider ${provider} is disabled for this business`);
  if (!Number.isInteger(amount) || amount <= 0) throw err.unprocessable('amount must be a positive integer (minor units)');
  const intentId = id('pi');
  q.run(db, `INSERT INTO payment_intents
    (id, tenant_id, order_id, customer_id, payee_type, payee_id, purpose, amount, currency, provider, method, status, idempotency_key, phone, meta, expires_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'CREATED', ?,?,?,?,?,?)`,
    intentId, tenantId, orderId, customerId, payeeType, payeeId, purpose, amount, currency, provider, method,
    idempotencyKey, phone, JSON.stringify(meta || {}),
    new Date(Date.now() + expiresInMinutes * 60_000).toISOString(), nowIso(), nowIso());
  logPaymentEvent(db, tenantId, intentId, 'PaymentCreated', provider, null, { amount });
  return { intent: getIntent(db, tenantId, intentId), replayed: false };
}

function logPaymentEvent(db, tenantId, intentId, type, provider, providerEventId, payload) {
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
  q.run(db, `INSERT INTO payment_events (id, tenant_id, intent_id, type, provider, provider_event_id, payload_hash, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
    id('pe'), tenantId, intentId, type, provider || null, providerEventId || null, payloadHash, nowIso());
  emitEvent(db, tenantId, type, { intent_id: intentId, ...(payload || {}), ref_type: 'payment', ref_id: intentId });
}

/** Initialize with provider (STK push / card charge / instructions). */
export function initiateIntent(db, tenantId, intentId, params = {}) {
  const intent = getIntent(db, tenantId, intentId);
  if (!['CREATED'].includes(intent.status)) return intent; // idempotent: already initiated
  const provider = getProvider(intent.provider);
  if (intent.expires_at && intent.expires_at < nowIso()) {
    transition(intent, 'EXPIRED');
    q.run(db, `UPDATE payment_intents SET status = 'EXPIRED', updated_at = ? WHERE id = ?`, nowIso(), intentId);
    throw err.conflict('Payment intent has expired');
  }
  const result = provider.initializePayment(db, intent, params);
  const next = result.status === 'PROCESSING' ? 'PROCESSING' : 'REQUIRES_ACTION';
  transition(intent, next);
  q.run(db, `UPDATE payment_intents SET status = ?, provider_ref = ?, updated_at = ? WHERE id = ?`,
    next, result.provider_ref, nowIso(), intentId);
  logPaymentEvent(db, tenantId, intentId, next === 'PROCESSING' ? 'PaymentProcessing' : 'PaymentRequiresAction', intent.provider, null, { provider_ref: result.provider_ref });
  return getIntent(db, tenantId, intentId);
}

/**
 * Server-side verification & settlement (§20). Calls the PROVIDER.
 * On success: record payment, post ledger, update order, notify — atomically.
 */
export function verifyAndSettle(db, tenantId, intentId, actorId = null) {
  const intent = getIntent(db, tenantId, intentId);
  if (intent.status === 'SETTLED' || intent.status === 'VERIFIED') return { intent, payment: q.one(db, `SELECT * FROM payments WHERE intent_id = ?`, intentId), replayed: true };
  if (['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(intent.status)) {
    throw err.conflict(`Payment intent is ${intent.status}`);
  }
  const provider = getProvider(intent.provider);
  const status = provider.verifyPayment(db, intent);
  if (status.status === 'PROCESSING') {
    return { intent: getIntent(db, tenantId, intentId), payment: null, replayed: false, processing: true };
  }
  if (status.status === 'FAILED') {
    transition(intent, 'FAILED');
    q.run(db, `UPDATE payment_intents SET status = 'FAILED', updated_at = ? WHERE id = ?`, nowIso(), intentId);
    logPaymentEvent(db, tenantId, intentId, 'PaymentFailed', intent.provider, null, { reason: status.reason || 'Provider declined' });
    throw err.conflict(status.reason || 'Payment failed at provider');
  }
  // VERIFIED at provider. Critical guard: provider amount must match intent amount.
  if (status.amount != null && Math.round(status.amount) !== intent.amount) {
    transition(intent, 'FAILED');
    q.run(db, `UPDATE payment_intents SET status = 'FAILED', updated_at = ? WHERE id = ?`, nowIso(), intentId);
    logPaymentEvent(db, tenantId, intentId, 'PaymentFailed', intent.provider, null, { reason: 'amount_mismatch', intent_amount: intent.amount, provider_amount: status.amount });
    throw err.conflict('Provider amount does not match payment intent — marked failed');
  }
  return settleVerifiedPayment(db, tenantId, intent, status, actorId);
}

/** Internal: settle after provider verification (shared by webhook + poll). */
function settleVerifiedPayment(db, tenantId, intent, providerStatus, actorId) {
  transition(intent, 'VERIFIED');
  const receiptNo = providerStatus.receipt_no || `${intent.provider.toUpperCase()}-${intent.id.slice(-8).toUpperCase()}`;
  // Unique(provider, reference) gives duplicate-settlement protection at DB layer.
  try {
    q.run(db, `INSERT INTO payments (id, tenant_id, intent_id, amount, fee, net, currency, method, provider, reference, status, direction, received_at, created_at)
               VALUES (?,?,?,?,0,?,?,?,?,?, 'SETTLED', ?, ?, ?)`,
      id('pay'), tenantId, intent.id, intent.amount, intent.amount, intent.currency, intent.method, intent.provider,
      receiptNo, intent.payee_type === 'TENANT' ? 'INBOUND' : 'OUTBOUND', nowIso(), nowIso());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return { intent: getIntent(db, tenantId, intent.id), payment: q.one(db, `SELECT * FROM payments WHERE intent_id = ?`, intent.id), replayed: true };
    }
    throw e;
  }
  transition({ ...intent, status: 'VERIFIED' }, 'SETTLED');
  q.run(db, `UPDATE payment_intents SET status = 'SETTLED', updated_at = ? WHERE id = ?`, nowIso(), intent.id);
  const payment = q.one(db, `SELECT * FROM payments WHERE intent_id = ?`, intent.id);

  // Ledger impact — financial truth (§49).
  if (intent.direction !== 'OUTBOUND' && intent.payee_type === 'TENANT') {
    if (intent.purpose === 'CREDIT_PAYMENT' && intent.customer_id) {
      postCreditPayment(db, tenantId, { method: intent.method, amount: intent.amount, refId: intent.id, actorId });
      applyCreditRepayment(db, tenantId, intent, actorId);
    } else if (intent.order_id) {
      const order = q.one(db, `SELECT * FROM orders WHERE id = ? AND tenant_id = ? AND tenant_id = ?`, intent.order_id, tenantId, tenantId);
      if (order) {
        const vatShare = order.total > 0 ? Math.round(order.tax * (intent.amount / order.total)) : 0;
        postSaleReceipt(db, tenantId, {
          method: intent.method, gross: intent.amount, net: intent.amount - vatShare, vat: vatShare,
          refId: intent.id, actorId, memo: `Receipt for order ${order.number}`,
        });
        const paid = order.amount_paid + intent.amount;
        const payStatus = paid >= order.total ? 'PAID' : 'PARTIAL';
        q.run(db, `UPDATE orders SET amount_paid = ?, payment_status = ?, updated_at = ? WHERE id = ?`,
          Math.min(paid, order.total), payStatus, nowIso(), order.id);
        if (payStatus === 'PAID' && order.broker_id) earnCommission(db, tenantId, order, actorId);
      }
    }
  }
  meter(db, tenantId, 'transactions');
  logPaymentEvent(db, tenantId, intent.id, 'PaymentVerified', intent.provider, null, { amount: intent.amount, reference: receiptNo });
  logPaymentEvent(db, tenantId, intent.id, 'PaymentSettled', intent.provider, null, { amount: intent.amount, reference: receiptNo });
  if (payment.direction === 'INBOUND') {
    notifyParties(db, tenantId, intent, payment);
    applyLoyalty(db, tenantId, intent);
  }
  return { intent: getIntent(db, tenantId, intent.id), payment, replayed: false };
}

function applyCreditRepayment(db, tenantId, intent, actorId) {
  const acct = q.one(db, `SELECT * FROM credit_accounts WHERE customer_id = ? AND tenant_id = ?`, intent.customer_id, tenantId);
  if (!acct) return;
  const applied = Math.min(intent.amount, acct.balance);
  const balanceAfter = acct.balance - applied;
  q.run(db, `UPDATE credit_accounts SET balance = ?, updated_at = ? WHERE customer_id = ?`, balanceAfter, nowIso(), intent.customer_id);
  q.run(db, `INSERT INTO credit_transactions (id, tenant_id, account_id, type, amount, balance_after, ref_type, ref_id, actor_id, created_at)
             VALUES (?,?,?,'PAYMENT',?,?, 'payment', ?,?,?)`,
    id('ctx'), tenantId, intent.customer_id, -applied, balanceAfter, intent.id, actorId, nowIso());
  if (acct.balance - applied === 0) {
    const oo = q.one(db, `SELECT id FROM orders WHERE tenant_id = ? AND customer_id = ? AND is_credit = 1 AND payment_status != 'PAID' ORDER BY created_at LIMIT 1`, tenantId, intent.customer_id);
    if (oo) q.run(db, `UPDATE orders SET payment_status = 'PAID', amount_paid = total, updated_at = ? WHERE id = ?`, nowIso(), oo.id);
  }
}

function applyLoyalty(db, tenantId, intent) {
  if (!intent.customer_id || intent.direction === 'OUTBOUND') return;
  const points = Math.floor(intent.amount / 1000); // 100 KES => 10 pts
  if (points <= 0) return;
  const tiers = q.all(db, `SELECT * FROM loyalty_tiers WHERE tenant_id = ? ORDER BY min_points DESC`, tenantId);
  const c = q.one(db, `SELECT loyalty_points FROM customers WHERE id = ? AND tenant_id = ?`, intent.customer_id, tenantId);
  if (!c) return;
  const total = c.loyalty_points + points;
  const tier = tiers.find(t => total >= t.min_points)?.name || 'BRONZE';
  q.run(db, `UPDATE customers SET loyalty_points = ?, loyalty_tier = ?, updated_at = ? WHERE id = ?`, total, tier, nowIso(), intent.customer_id);
}

function businessName(db, tenantId) {
  return q.one(db, `SELECT business_name FROM tenant_branding WHERE tenant_id = ?`, tenantId)?.business_name || 'TAWA';
}

/** Broker commission earned when an order is fully paid (§19). Unique per order. */
function earnCommission(db, tenantId, order, actorId) {
  const broker = q.one(db, `SELECT * FROM brokers WHERE id = ? AND tenant_id = ?`, order.broker_id, tenantId);
  if (!broker) return;
  const amount = Math.round((order.total - order.tax) * (broker.commission_pct / 100));
  q.run(db, `INSERT INTO commissions (id, tenant_id, broker_id, order_id, amount, status, created_at, updated_at)
             VALUES (?,?,?,?,?, 'EARNED', ?, ?)
             ON CONFLICT(order_id, broker_id) DO NOTHING`,
    id('cm'), tenantId, broker.id, order.id, amount, nowIso(), nowIso());
  const existing = q.one(db, `SELECT id FROM commissions WHERE order_id = ? AND broker_id = ?`, order.id, broker.id);
  emitEvent(db, tenantId, 'BrokerCommissionEarned', { commission_id: existing?.id, broker: broker.name, amount, order_id: order.id, ref_type: 'commission', ref_id: existing?.id }, actorId);
  if (broker.phone) {
    sendNotification(db, {
      tenantId, channel: 'SMS', recipientKind: 'BROKER', recipientId: broker.id, toAddr: broker.phone,
      body: `${businessName(db, tenantId)}: You earned commission of ${fmtMoney(amount)} on order ${order.number}. Pending approval.`,
      eventType: 'BrokerCommissionEarned', refType: 'commission', refId: existing?.id,
    });
  }
}

function notifyParties(db, tenantId, intent, payment) {
  if (intent.customer_id) {
    const c = q.one(db, `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`, intent.customer_id, tenantId);
    if (c?.phone && c.notify_prefs && JSON.parse(c.notify_prefs).payment !== false) {
      sendNotification(db, {
        tenantId, channel: 'SMS', recipientKind: 'CUSTOMER', recipientId: c.id, toAddr: c.phone,
        body: `${businessName(db, tenantId)}: Payment of ${fmtMoney(intent.amount, intent.currency)} received. Ref: ${payment.reference}. Thank you.`,
        priority: 'NORMAL', kind: 'TRANSACTIONAL', eventType: 'PaymentVerified', refType: 'payment', refId: payment.id,
      });
    }
  }
  sendNotification(db, {
    tenantId, channel: 'IN_APP', recipientKind: 'ROLE', recipientId: 'CASHIER',
    body: `Payment verified: ${fmtMoney(intent.amount, intent.currency)} (${intent.method}, ref ${payment.reference}).`,
    priority: 'NORMAL', kind: 'OPERATIONAL', eventType: 'PaymentSettled', refType: 'payment', refId: payment.id,
    extra: { role_recipient: 'CASHIER' },
  });
}

export const fmtMoney = (minor, currency = 'KES') => `${currency} ${(minor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

/**
 * Webhook entry (§22, §27 webhooks security).
 * Signature verification + timestamp + replay protection + DB dedupe.
 */
export function handleWebhook(db, providerCode, rawBody, signature, timestampHeader) {
  const provider = getProvider(providerCode);
  if (!provider) throw err.notFound('Unknown provider');
  const secret = provider.webhookSecret?.();
  if (!secret) throw err.badRequest('This provider does not accept webhooks');
  if (!signature) throw err.unauthorized('Missing webhook signature');
  // Timestamp validation: 5-minute window blocks replay of stale events.
  const ts = Number(timestampHeader || 0);
  if (!ts || Math.abs(Date.now() - ts) > 5 * 60_000) throw err.unauthorized('Stale or missing webhook timestamp');
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const sigBuf = Buffer.from(String(signature));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw err.unauthorized('Invalid webhook signature');
  }
  const payload = JSON.parse(rawBody);
  // Dedupe: replayed provider event ids are acknowledged but NOT reprocessed (§22).
  const dupe = q.one(db, `SELECT id FROM payment_events WHERE provider = ? AND provider_event_id = ?`, providerCode, payload.event_id);
  if (dupe) return { status: 'duplicate_ignored' };
  const result = provider.handleWebhook(db, payload);
  if (!result.matched) {
    logPaymentEvent(db, null, null, 'PaymentWebhookUnmatched', providerCode, payload.event_id, { reason: 'unknown provider_ref' });
    return { status: 'unmatched' };
  }
  const intent = q.one(db, `SELECT * FROM payment_intents WHERE id = ?`, result.intent_id);
  if (result.status === 'SUCCESS' && intent && intent.status !== 'SETTLED') {
    return txWebhook(db, intent.tenant_id, () => {
      const verified = provider.verifyPayment(db, intent);
      if (verified.status === 'VERIFIED') {
        const out = settleVerifiedPayment(db, intent.tenant_id, intent, verified, null);
        logPaymentEvent(db, intent.tenant_id, intent.id, 'PaymentWebhookProcessed', providerCode, payload.event_id, {});
        return { status: 'processed', payment_id: out.payment?.id };
      }
      return { status: 'pending_verification' };
    });
  }
  if (result.status === 'FAILED' && intent && !['FAILED', 'SETTLED'].includes(intent.status)) {
    q.run(db, `UPDATE payment_intents SET status = 'FAILED', updated_at = ? WHERE id = ? AND status != 'SETTLED'`, nowIso(), intent.id);
    logPaymentEvent(db, intent.tenant_id, intent.id, 'PaymentFailed', providerCode, payload.event_id, { via: 'webhook' });
  }
  logPaymentEvent(db, intent?.tenant_id ?? null, intent?.id ?? null, 'PaymentWebhookProcessed', providerCode, payload.event_id, { result: result.status });
  return { status: 'processed' };
}

import { tx } from '../db/connection.js';
function txWebhook(db, tenantId, fn) { void tenantId; return tx(db, fn); }

/**
 * Refund (§28). Authorization required upstream (payments.refund).
 * Hard cap: total refunds can never exceed captured amount (§55 invariants).
 */
export function refundPayment(db, tenantId, paymentId, amount, reason, actorId, { asRequest = false } = {}) {
  const payment = q.one(db, `SELECT * FROM payments WHERE id = ? AND tenant_id = ?`, paymentId, tenantId);
  if (!payment) throw err.notFound('Payment not found');
  if (!Number.isInteger(amount) || amount <= 0) throw err.unprocessable('Refund amount must be positive minor units');
  const refunded = q.one(db, `SELECT COALESCE(SUM(amount),0) AS total FROM refunds WHERE payment_id = ? AND status IN ('AUTHORIZED','PROCESSED')`, paymentId).total;
  if (refunded + amount > payment.amount) {
    throw err.conflict('Refund would exceed captured amount', { captured: payment.amount, already_refunded: refunded, requested: amount });
  }
  const provider = getProvider(payment.provider);
  const status = asRequest ? 'REQUESTED' : 'PROCESSED';
  let providerRef = null;
  if (!asRequest) {
    const res = provider.refundPayment(db, payment, amount);
    if (!res.ok) throw err.conflict(res.reason || 'Refund declined by provider');
    providerRef = res.refund_ref;
  }
  const refundId = id('rfd');
  q.run(db, `INSERT INTO refunds (id, tenant_id, payment_id, amount, reason, status, requested_by, authorized_by, provider_ref, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    refundId, tenantId, paymentId, amount, reason || null, status, actorId, asRequest ? null : actorId, providerRef, nowIso(), nowIso());
  if (!asRequest) {
    postRefund(db, tenantId, { amount, method: payment.method, refId: refundId, actorId });
    const totalRefunded = refunded + amount;
    const intent = q.one(db, `SELECT * FROM payment_intents WHERE id = ?`, payment.intent_id);
    const nextStatus = totalRefunded >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    q.run(db, `UPDATE payment_intents SET status = ?, updated_at = ? WHERE id = ?`, nextStatus, nowIso(), intent.id);
    if (intent.order_id) {
      const order = q.one(db, `SELECT * FROM orders WHERE id = ?`, intent.order_id);
      const newPaid = Math.max(order.amount_paid - amount, 0);
      q.run(db, `UPDATE orders SET amount_paid = ?, payment_status = ?, updated_at = ? WHERE id = ?`,
        newPaid, newPaid === 0 ? 'UNPAID' : newPaid >= order.total ? 'PAID' : 'PARTIAL', nowIso(), order.id);
    }
    emitEvent(db, tenantId, 'PaymentRefunded', { payment_id: paymentId, amount, reference: payment.reference, ref_type: 'payment', ref_id: paymentId }, actorId);
    audit(db, { tenantId, actorId, action: 'payment.refund', resource: 'payment', resourceId: paymentId, metadata: { amount, reason, provider_ref: providerRef } });
  }
  return q.one(db, `SELECT * FROM refunds WHERE id = ?`, refundId);
}

/** Reconciliation (§23): internal payments vs provider records. */
export function reconcile(db, tenantId, { from = null, to = null } = {}) {
  const pays = q.all(db, `SELECT * FROM payments WHERE tenant_id = ? AND (? IS NULL OR received_at >= ?) AND (? IS NULL OR received_at <= ?) ORDER BY received_at DESC LIMIT 500`,
    tenantId, from, from, to, to);
  const findings = [];
  for (const p of pays) {
    if (p.provider === 'cash') continue; // till cash reconciles against drawer counts
    const rec = q.one(db, `SELECT * FROM sandbox_provider_records WHERE receipt_no = ? OR provider_ref = ?`, p.reference, p.reference);
    if (!rec && !['bank_manual'].includes(p.provider)) {
      findings.push({ type: 'MISSING_PROVIDER_RECORD', payment_id: p.id, reference: p.reference, amount: p.amount });
    } else if (rec && rec.amount !== p.amount) {
      findings.push({ type: 'AMOUNT_MISMATCH', payment_id: p.id, reference: p.reference, internal: p.amount, provider: rec.amount });
    }
  }
  // Provider-side successes never captured internally (e.g. webhook lost, then verified late)
  const orphanProvider = q.all(db, `
    SELECT r.* FROM sandbox_provider_records r
    JOIN payment_intents i ON i.id = r.intent_id
    WHERE i.tenant_id = ? AND r.status = 'SUCCESS' AND i.status NOT IN ('SETTLED','REFUNDED','PARTIALLY_REFUNDED')`, tenantId);
  for (const r of orphanProvider) findings.push({ type: 'UNSETTLED_PROVIDER_SUCCESS', provider_ref: r.provider_ref, intent_id: r.intent_id, amount: r.amount });
  const totals = q.one(db, `SELECT COALESCE(SUM(amount),0) AS collected, COUNT(*) AS count FROM payments WHERE tenant_id = ? AND direction = 'INBOUND' AND status != 'REVERSED'`, tenantId);
  return { findings, payments_checked: pays.length, collected_total: totals.collected, payment_count: totals.count };
}
