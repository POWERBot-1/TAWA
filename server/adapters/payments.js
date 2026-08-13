import crypto from 'node:crypto';
import { q, nowIso } from '../db/connection.js';
import { config } from '../config.js';

/**
 * Payment provider abstraction (§16-17 payment gateway spec).
 * Every provider implements the universal contract. Business logic talks
 * ONLY to this interface — providers are never hard-coded into flows.
 *
 * Environment honesty: sandbox adapters simulate provider behavior with a
 * durable provider-side ledger (sandbox_provider_records). They are marked
 * as sandbox everywhere they surface. Production integrations require real
 * credentials and must pass webhook signature verification.
 */

export const PAYMENT_PROVIDERS = {};

function providerRecord(db, provider_ref) {
  return q.one(db, `SELECT * FROM sandbox_provider_records WHERE provider_ref = ?`, provider_ref);
}

/* ---------------- M-Pesa sandbox (§17 MpesaAdapter) ---------------- */
PAYMENT_PROVIDERS.mpesa_sandbox = {
  code: 'mpesa_sandbox', label: 'M-Pesa (Sandbox)', environment: 'sandbox',
  methods: ['MPESA'], currencies: ['KES'], countries: ['KE'],
  production: false,
  /** Sandbox STK push: parks a PENDING provider record awaiting customer PIN. */
  initializePayment(db, intent) {
    const ref = `WS_CO_${crypto.randomBytes(8).toString('hex').slice(0, 12).toUpperCase()}`;
    q.run(db, `INSERT INTO sandbox_provider_records (provider_ref, intent_id, provider, status, amount, phone, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)`,
      ref, intent.id, 'mpesa_sandbox', 'PENDING', intent.amount, intent.phone || null, nowIso(), nowIso());
    return { provider_ref: ref, status: 'PROCESSING', instructions: 'STK push sent (sandbox). Confirm via sandbox console or webhook.' };
  },
  /** Server-side verification (§20): asks PROVIDER state, never the client. */
  verifyPayment(db, intent) {
    const rec = providerRecord(db, intent.provider_ref);
    if (!rec) return { status: 'PROCESSING' };
    if (rec.status === 'SUCCESS') {
      return { status: 'VERIFIED', receipt_no: rec.receipt_no, amount: rec.amount };
    }
    if (rec.status === 'FAILED') return { status: 'FAILED', reason: 'Customer declined or timeout (sandbox)' };
    return { status: 'PROCESSING' };
  },
  refundPayment(db, payment, amount) {
    const rec = providerRecord(db, payment.reference);
    if (!rec || rec.status !== 'SUCCESS') return { ok: false, reason: 'Original transaction not refundable' };
    if (amount > payment.amount) return { ok: false, reason: 'Refund exceeds captured amount' };
    return { ok: true, refund_ref: `WS_RE_${crypto.randomBytes(6).toString('hex').toUpperCase()}` };
  },
  getPaymentStatus(db, intent) { return this.verifyPayment(db, intent); },
  handleWebhook(db, payload) {
    const rec = providerRecord(db, payload.provider_ref);
    if (!rec) return { matched: false };
    rec.status = payload.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
    if (rec.status === 'SUCCESS') rec.receipt_no = payload.receipt_no || `SBX${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    rec.updated_at = nowIso();
    q.run(db, `UPDATE sandbox_provider_records SET status = ?, receipt_no = ?, updated_at = ? WHERE provider_ref = ?`,
      rec.status, rec.receipt_no, rec.updated_at, rec.provider_ref);
    return { matched: true, intent_id: rec.intent_id, status: rec.status };
  },
  healthCheck() { return { status: 'ONLINE', environment: 'sandbox' }; },
  webhookSecret: () => config.webhookSecrets.mpesa_sandbox,
};

/* ---------------- Cash (till) ---------------- */
PAYMENT_PROVIDERS.cash = {
  code: 'cash', label: 'Cash (Till)', environment: 'production-capable',
  methods: ['CASH'], currencies: ['KES', 'USD', 'EUR'], countries: ['*'],
  production: true,
  initializePayment(db, intent) {
    return { provider_ref: `CASH-${intent.id.slice(-8).toUpperCase()}`, status: 'REQUIRES_ACTION', instructions: 'Collect cash and confirm with exact amount.' };
  },
  verifyPayment(_db, intent) {
    // Cash "provider" is the till: verification = cashier confirmation, recorded server-side.
    return this._confirmed?.has(intent.id)
      ? { status: 'VERIFIED', receipt_no: `TILL-${Date.now()}`, amount: intent.amount }
      : { status: 'PROCESSING' };
  },
  confirmReceived(db, intent, confirmedAmount, actorId) {
    if (confirmedAmount !== intent.amount) return { ok: false, reason: `Amount mismatch: expected ${intent.amount}, received ${confirmedAmount}` };
    this._confirmed = this._confirmed || new Set();
    this._confirmed.add(intent.id);
    q.run(db, `INSERT INTO sandbox_provider_records (provider_ref, intent_id, provider, status, amount, receipt_no, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider_ref) DO UPDATE SET status='SUCCESS', updated_at=excluded.updated_at`,
      intent.provider_ref || `CASH-${intent.id.slice(-8).toUpperCase()}`, intent.id, 'cash', 'SUCCESS', intent.amount, `TILL-${Date.now()}`, nowIso(), nowIso());
    return { ok: true };
  },
  refundPayment(_db, payment, amount) {
    if (amount > payment.amount) return { ok: false, reason: 'Refund exceeds captured amount' };
    return { ok: true, refund_ref: `TILL-R-${Date.now()}` };
  },
  getPaymentStatus(db, intent) { return this.verifyPayment(db, intent); },
  handleWebhook() { return { matched: false }; },
  healthCheck() { return { status: 'ONLINE', environment: 'internal-till' }; },
  webhookSecret: () => null,
};

/* ---------------- Card sandbox ---------------- */
PAYMENT_PROVIDERS.card_sandbox = {
  code: 'card_sandbox', label: 'Cards (Sandbox)', environment: 'sandbox',
  methods: ['CARD'], currencies: ['KES', 'USD', 'EUR', 'GBP'], countries: ['*'],
  production: false,
  initializePayment(db, intent, params = {}) {
    const ref = `CS_${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    const token = String(params.card_token || '');
    const status = token.startsWith('tok_ok') ? 'SUCCESS' : token.startsWith('tok_insufficient') ? 'FAILED' : 'PENDING';
    const receipt = status === 'SUCCESS' ? `CH_${crypto.randomBytes(5).toString('hex').toUpperCase()}` : null;
    q.run(db, `INSERT INTO sandbox_provider_records (provider_ref, intent_id, provider, status, amount, receipt_no, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)`,
      ref, intent.id, 'card_sandbox', status, intent.amount, receipt, nowIso(), nowIso());
    return { provider_ref: ref, status: status === 'PENDING' ? 'PROCESSING' : undefined, instructions: status === 'PENDING' ? 'Awaiting 3DS (sandbox)' : undefined };
  },
  verifyPayment(db, intent) {
    const rec = providerRecord(db, intent.provider_ref);
    if (!rec) return { status: 'PROCESSING' };
    if (rec.status === 'SUCCESS') return { status: 'VERIFIED', receipt_no: rec.receipt_no, amount: rec.amount };
    if (rec.status === 'FAILED') return { status: 'FAILED', reason: 'Declined (sandbox)' };
    return { status: 'PROCESSING' };
  },
  refundPayment(_db, payment, amount) {
    if (amount > payment.amount) return { ok: false, reason: 'Refund exceeds captured amount' };
    return { ok: true, refund_ref: `RE_${crypto.randomBytes(5).toString('hex').toUpperCase()}` };
  },
  getPaymentStatus(db, intent) { return this.verifyPayment(db, intent); },
  handleWebhook(db, payload) {
    const rec = providerRecord(db, payload.provider_ref);
    if (!rec) return { matched: false };
    const status = payload.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
    q.run(db, `UPDATE sandbox_provider_records SET status = ?, receipt_no = ?, updated_at = ? WHERE provider_ref = ?`,
      status, payload.receipt_no || rec.receipt_no, nowIso(), rec.provider_ref);
    return { matched: true, intent_id: rec.intent_id, status };
  },
  healthCheck() { return { status: 'ONLINE', environment: 'sandbox' }; },
  webhookSecret: () => config.webhookSecrets.card_sandbox,
};

/* ---------------- Bank transfer (manual verification) ---------------- */
PAYMENT_PROVIDERS.bank_manual = {
  code: 'bank_manual', label: 'Bank Transfer (Manual)', environment: 'production-capable',
  methods: ['BANK'], currencies: ['KES', 'USD', 'EUR'], countries: ['*'],
  production: true,
  initializePayment(db, intent) {
    const ref = `BANK-${intent.id.slice(-8).toUpperCase()}`;
    q.run(db, `INSERT INTO sandbox_provider_records (provider_ref, intent_id, provider, status, amount, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider_ref) DO NOTHING`,
      ref, intent.id, 'bank_manual', 'PENDING', intent.amount, nowIso(), nowIso());
    return { provider_ref: ref, status: 'REQUIRES_ACTION', instructions: 'Share bank details; finance verifies with bank reference.' };
  },
  verifyPayment(db, intent) {
    const rec = providerRecord(db, intent.provider_ref);
    if (rec?.status === 'SUCCESS') return { status: 'VERIFIED', receipt_no: rec.receipt_no, amount: rec.amount };
    return { status: 'PROCESSING' };
  },
  confirmBank(db, intent, bankRef) {
    q.run(db, `UPDATE sandbox_provider_records SET status='SUCCESS', receipt_no=?, updated_at=? WHERE provider_ref=? AND intent_id=?`,
      bankRef, nowIso(), intent.provider_ref, intent.id);
    return { ok: true };
  },
  refundPayment(_db, payment, amount) {
    if (amount > payment.amount) return { ok: false, reason: 'Refund exceeds captured amount' };
    return { ok: true, refund_ref: `BANK-R-${Date.now()}` };
  },
  getPaymentStatus(db, intent) { return this.verifyPayment(db, intent); },
  handleWebhook() { return { matched: false }; },
  healthCheck() { return { status: 'ONLINE', environment: 'manual' }; },
  webhookSecret: () => null,
};

export function getProvider(code) {
  return PAYMENT_PROVIDERS[code] || null;
}

export function providerHealth() {
  return Object.values(PAYMENT_PROVIDERS).map(p => ({
    code: p.code, label: p.label, environment: p.environment,
    production: p.production, methods: p.methods, ...p.healthCheck(),
  }));
}
