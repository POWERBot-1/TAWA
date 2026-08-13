import { q, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqOneOf, pageParams } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { createIntent, initiateIntent, verifyAndSettle, handleWebhook, refundPayment, reconcile, getIntent, fmtMoney } from '../modules/payments.js';
import { getProvider, providerHealth } from '../adapters/payments.js';

export function registerPayments(router, db) {
  /* ---------------- Intents ---------------- */
  router.get('/api/v1/payments/intents', (req, res) => {
    mustPerm(req, 'payments.view');
    const { limit, offset } = pageParams(req);
    const rows = q.all(db, `SELECT i.*, o.number AS order_number FROM payment_intents i LEFT JOIN orders o ON o.id = i.order_id
      WHERE i.tenant_id = ? ${req.query.status ? 'AND i.status = ?' : ''} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
      ...(req.query.status ? [req.tenantId, req.query.status] : [req.tenantId]), limit, offset);
    ok(res, rows);
  });

  router.post('/api/v1/payments/intents', async (req, res) => {
    mustPerm(req, 'payments.create');
    const body = await readBody(req);
    const amountMinor = body.amount_minor != null ? Math.round(Number(body.amount_minor)) : Math.round(reqNum(body.amount, 'amount', { min: 0.01 }) * 100);
    const { intent, replayed } = createIntent(db, {
      tenantId: req.tenantId, orderId: body.order_id || null, customerId: body.customer_id || null,
      purpose: body.purpose || 'SALE', payeeType: body.payee_type || 'TENANT', payeeId: body.payee_id || null,
      amount: amountMinor, currency: body.currency || req.tenant.currency,
      provider: reqStr(body.provider, 'provider'), method: reqStr(body.method, 'method'),
      phone: optStr(body.phone, 'phone'),
      idempotencyKey: reqStr(body.idempotency_key, 'idempotency_key'),
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'payment.intent.create', resource: 'payment_intent', resourceId: intent.id, metadata: { amount: intent.amount, provider: intent.provider, replayed } });
    (replayed ? ok : created)(res, { intent, replayed });
  });

  router.post('/api/v1/payments/intents/:id/initiate', async (req, res) => {
    mustPerm(req, 'payments.create');
    const body = await readBody(req);
    const intent = tx(db, () => initiateIntent(db, req.tenantId, req.params.id, body));
    ok(res, intent);
  });

  /** Server-side verification — polls the provider. Safe to call repeatedly. */
  router.post('/api/v1/payments/intents/:id/verify', (req, res) => {
    mustPerm(req, 'payments.verify');
    const result = tx(db, () => verifyAndSettle(db, req.tenantId, req.params.id, req.auth.user.id));
    if (result.processing) return sendJson(res, 202, { data: { ...result, message: 'Provider has not confirmed yet' } });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'payment.verify', resource: 'payment_intent', resourceId: req.params.id, metadata: { status: result.intent.status } });
    ok(res, result);
  });

  /** Cash confirmation (till verification). */
  router.post('/api/v1/payments/intents/:id/confirm-cash', async (req, res) => {
    mustPerm(req, 'payments.verify');
    const body = await readBody(req);
    const intent = getIntent(db, req.tenantId, req.params.id);
    if (intent.provider !== 'cash') throw err.unprocessable('Only cash intents can be confirmed this way');
    const amount = Math.round(reqNum(body.amount, 'amount', { min: 0.01 }) * 100);
    const result = getProvider('cash').confirmReceived(db, intent, amount, req.auth.user.id);
    if (!result.ok) throw err.conflict(result.reason);
    ok(res, tx(db, () => verifyAndSettle(db, req.tenantId, intent.id, req.auth.user.id)));
  });

  /** Bank manual verification with bank reference. */
  router.post('/api/v1/payments/intents/:id/confirm-bank', async (req, res) => {
    mustPerm(req, 'payments.verify');
    const body = await readBody(req);
    const intent = getIntent(db, req.tenantId, req.params.id);
    if (intent.provider !== 'bank_manual') throw err.unprocessable('Only bank intents can be confirmed this way');
    getProvider('bank_manual').confirmBank(db, intent, reqStr(body.bank_reference, 'bank_reference'));
    ok(res, tx(db, () => verifyAndSettle(db, req.tenantId, intent.id, req.auth.user.id)));
  });

  /* ---------------- Payments ledger view ---------------- */
  router.get('/api/v1/payments', (req, res) => {
    mustPerm(req, 'payments.view');
    const { limit, offset } = pageParams(req);
    const rows = q.all(db, `SELECT p.*, i.order_id, i.customer_id, o.number AS order_number, c.name AS customer_name
      FROM payments p JOIN payment_intents i ON i.id = p.intent_id
      LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = i.customer_id
      WHERE p.tenant_id = ? ORDER BY p.received_at DESC LIMIT ? OFFSET ?`, req.tenantId, limit, offset);
    const total = q.one(db, `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ?`, req.tenantId).n;
    ok(res, rows, { total });
  });

  router.post('/api/v1/payments/:id/refund', async (req, res) => {
    mustPerm(req, 'payments.refund');
    const body = await readBody(req);
    const amount = body.amount_minor != null ? Math.round(Number(body.amount_minor)) : Math.round(reqNum(body.amount, 'amount', { min: 0.01 }) * 100);
    const refund = tx(db, () => refundPayment(db, req.tenantId, req.params.id, amount, optStr(body.reason, 'reason'), req.auth.user.id, { asRequest: body.approve === false }));
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'payment.refund.execute', resource: 'refund', resourceId: refund.id, metadata: { amount } });
    created(res, refund);
  });

  router.get('/api/v1/payments/reconcile', (req, res) => {
    mustPerm(req, 'payments.view');
    ok(res, reconcile(db, req.tenantId, { from: req.query.from || null, to: req.query.to || null }));
  });

  router.get('/api/v1/payments/providers', (req, res) => {
    mustPerm(req, 'integrations.manage');
    ok(res, providerHealth());
  });

  /* ---------------- Webhooks (§22, §27) ---------------- */
  router.post('/api/v1/webhooks/payments/:provider', async (req, res) => {
    // Raw body needed for HMAC — readBody preserves it before parse.
    await readBody(req);
    const result = handleWebhook(db, req.params.provider, req.rawBody,
      String(req.headers['x-tawa-signature'] || req.headers['x-signature'] || ''),
      String(req.headers['x-tawa-timestamp'] || req.headers['x-signature-timestamp'] || ''));
    ok(res, result);
  });

  /* ---------------- Sandbox console (explicitly test-only) ---------------- */
  router.post('/api/v1/sandbox/mpesa/outcome', async (req, res) => {
    if (!req.headers['x-sandbox-mode']) throw err.forbidden('Sandbox console requires X-Sandbox-Mode header');
    const body = await readBody(req);
    const ref = reqStr(body.provider_ref, 'provider_ref');
    const outcome = reqOneOf(body.outcome, 'outcome', ['SUCCESS', 'FAILED']);
    const rec = q.one(db, `SELECT * FROM sandbox_provider_records WHERE provider_ref = ?`, ref);
    if (!rec) throw err.notFound('Unknown sandbox transaction');
    q.run(db, `UPDATE sandbox_provider_records SET status = ?, receipt_no = ?, updated_at = ? WHERE provider_ref = ?`,
      outcome, outcome === 'SUCCESS' ? `SBX${Math.random().toString(36).slice(2, 8).toUpperCase()}` : null, nowIso(), ref);
    ok(res, { provider_ref: ref, status: outcome, note: 'sandbox only — TAWA still verifies server-side' });
  });
  void fmtMoney;
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
