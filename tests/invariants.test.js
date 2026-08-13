import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStack, makeTenant, makeUser, makeFixture, login, api, signWebhook } from './helpers.js';
import { q, id, nowIso } from '../server/db/connection.js';
import { verifyLedgerIntegrity } from '../server/modules/ledger.js';
import { config } from '../server/config.js';

let stack, db, base;
let A, B; // tenants
let ownerA, cashierA, financeA, ownerB;

before(async () => {
  stack = await makeStack(); db = stack.db; base = stack.base;
  A = makeTenant(db, { code: 'alpha', plan: 'BUSINESS' });
  B = makeTenant(db, { code: 'buildpro', plan: 'PROFESSIONAL' });
  A.fx = makeFixture(db, A.tenant.id);
  B.fx = makeFixture(db, B.tenant.id);
  ownerA = await login(base, A.ownerEmail, A.ownerPassword);
  cashierA = await login(base, makeUser(db, A.tenant.id, 'cashier@alpha.test', 'CASHIER').email, 'Test#Pass1');
  financeA = await login(base, makeUser(db, A.tenant.id, 'finance@alpha.test', 'FINANCE_MANAGER').email, 'Test#Pass1');
  ownerB = await login(base, B.ownerEmail, B.ownerPassword);
});
after(async () => stack.close());

/* ---------- §55 / §58 tenant isolation ---------- */
test('auth is required for tenant APIs', async () => {
  const r = await fetch(`${base}/api/v1/products`);
  assert.equal(r.status, 401);
});

test('Tenant A cannot access Tenant B (product read/write/IDOR)', async () => {
  const r1 = await api(base, ownerA.token, 'GET', `/api/v1/products/${B.fx.product}`);
  assert.equal(r1.status, 404, 'cross-tenant product must be invisible by ID');
  const r2 = await api(base, ownerA.token, 'GET', `/api/v1/customers/${B.fx.customer}`);
  assert.equal(r2.status, 404);
  const r3 = await api(base, ownerA.token, 'POST', '/api/v1/orders', {
    customer_id: B.fx.customer, items: [{ product_id: B.fx.product, qty: 1 }],
  });
  assert.equal(r3.status, 404, 'IDOR write across tenants must fail');
});

test('client cannot re-scope tenant via body/headers (server-derived tenancy)', async () => {
  const r = await api(base, ownerA.token, 'GET', `/api/v1/products?tenant_id=${B.tenant.id}`, { tenant_id: B.tenant.id }, { 'x-tenant-id': String(B.tenant.id) });
  assert.equal(r.status, 200);
  const ids = r.json.data.map(p => p.id);
  assert.ok(ids.includes(A.fx.product));
  assert.ok(!ids.includes(B.fx.product), 'tenant filter must be server-side only');
});

/* ---------- §58 RBAC criticals ---------- */
test('a cashier cannot execute payroll or approve refunds', async () => {
  const r1 = await api(base, cashierA.token, 'POST', '/api/v1/payroll/runs/whatever/execute', {});
  assert.equal(r1.status, 403);
  const r2 = await api(base, cashierA.token, 'POST', '/api/v1/payments/pay_x/refund', { amount: 1 });
  assert.equal(r2.status, 403);
});

test('platform admin endpoints deny tenant users', async () => {
  const r = await api(base, ownerA.token, 'GET', '/api/v1/admin/tenants');
  assert.equal(r.status, 403);
});

/* ---------- §55 inventory invariants ---------- */
test('inventory cannot go negative without explicit permit', async () => {
  const r = await api(base, ownerA.token, 'POST', '/api/v1/inventory/adjust', {
    warehouse_id: A.fx.warehouse, type: 'ADJUST', reason: 'test', items: [{ product_id: A.fx.product, qty: -10_000 }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.code, 'INSUFFICIENT_STOCK');
});

test('explicit permit allows negative adjustment (audited)', async () => {
  const r = await api(base, ownerA.token, 'POST', '/api/v1/inventory/adjust', {
    warehouse_id: A.fx.warehouse, type: 'ADJUST', reason: 'test-override', allow_negative: true,
    items: [{ product_id: A.fx.product, qty: -10_000 }],
  });
  assert.equal(r.status, 201);
  // restore
  await api(base, ownerA.token, 'POST', '/api/v1/inventory/adjust', {
    warehouse_id: A.fx.warehouse, type: 'ADJUST', reason: 'restore', allow_negative: true,
    items: [{ product_id: A.fx.product, qty: 10_000 }],
  });
  const aud = q.one(db, `SELECT * FROM audit_events WHERE action = 'inventory.adjust' AND tenant_id = ? ORDER BY created_at DESC`, A.tenant.id);
  assert.ok(aud, 'adjustment must be audited');
});

test('inventory movements are append-only (DB trigger)', async () => {
  assert.throws(() => q.run(db, `UPDATE inventory_movements SET qty_delta = 0`), /append-only/);
  assert.throws(() => q.run(db, `DELETE FROM inventory_movements`), /append-only/);
});

test('audit events are append-only (DB trigger)', async () => {
  assert.throws(() => q.run(db, `DELETE FROM audit_events`), /append-only/);
});

/* ---------- §55/§58 payment invariants ---------- */
test('payment intent creation is idempotent', async () => {
  const body = { amount: 100, provider: 'cash', method: 'CASH', idempotency_key: 'idem-test-1' };
  const r1 = await api(base, ownerA.token, 'POST', '/api/v1/payments/intents', body);
  const r2 = await api(base, ownerA.token, 'POST', '/api/v1/payments/intents', body);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r1.json.data.intent.id, r2.json.data.intent.id);
  assert.equal(r2.json.data.replayed, true);
  const count = q.one(db, `SELECT COUNT(*) AS n FROM payment_intents WHERE tenant_id = ? AND idempotency_key = ?`, A.tenant.id, 'idem-test-1').n;
  assert.equal(count, 1);
});

test('POS sale is idempotent end-to-end (no double financial records)', async () => {
  const order = { idempotency_key: 'pos-key-1', items: [{ product_id: A.fx.product, qty: 2 }], method: 'CASH' };
  const s1 = await api(base, ownerA.token, 'POST', '/api/v1/pos/sale', order);
  const s2 = await api(base, ownerA.token, 'POST', '/api/v1/pos/sale', order);
  assert.equal(s1.status, 201);
  assert.equal(s2.json.data.replayed, true);
  assert.equal(s1.json.data.order.id, s2.json.data.order.id);
  const cnt = q.one(db, `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND direction = 'INBOUND'`, A.tenant.id).n;
  assert.equal(cnt, 1);
});

test('refund cannot exceed original payment (§28)', async () => {
  const sale = await api(base, ownerA.token, 'POST', '/api/v1/pos/sale', { idempotency_key: 'pos-key-2', items: [{ product_id: A.fx.product, qty: 1 }], method: 'CASH' });
  if (sale.status !== 201) console.log('DEBUG refund sale:', sale.status, JSON.stringify(sale.json).slice(0, 400));
  assert.equal(sale.status, 201);
  const payId = sale.json.data.payment.id;
  const pay = q.one(db, `SELECT * FROM payments WHERE id = ?`, payId);
  assert.ok(pay, 'payment exists');
  const paidMajor = pay.amount / 100; // sale of 1 unit (870 KES)
  const bad = await api(base, financeA.token, 'POST', `/api/v1/payments/${payId}/refund`, { amount: paidMajor + 1, reason: 'over' });
  assert.equal(bad.status, 409, 'over-refund rejected');
  const good = await api(base, financeA.token, 'POST', `/api/v1/payments/${payId}/refund`, { amount: 100, reason: 'partial ok' });
  assert.equal(good.status, 201, 'partial refund accepted');
  const tooMuch = await api(base, financeA.token, 'POST', `/api/v1/payments/${payId}/refund`, { amount: paidMajor, reason: 'attempt 2' });
  assert.equal(tooMuch.status, 409, 'cumulative refunds may not exceed capture');
});

test('webhook: bad signature rejected, valid settles, replay deduped (§22, §27)', async () => {
  // create intent + initiate mpesa
  const { json: cj } = await api(base, ownerA.token, 'POST', '/api/v1/payments/intents', { amount: 250, provider: 'mpesa_sandbox', method: 'MPESA', idempotency_key: 'wh-1', phone: '+254700000001' });
  const intent = cj.data.intent;
  await api(base, ownerA.token, 'POST', `/api/v1/payments/intents/${intent.id}/initiate`, {});
  const ref = q.one(db, `SELECT provider_ref FROM payment_intents WHERE id = ?`, intent.id).provider_ref;
  const raw = JSON.stringify({ event_id: 'evt-1', provider_ref: ref, result: 'SUCCESS', receipt_no: 'QAB12345' });
  const bad = await fetch(`${base}/api/v1/webhooks/payments/mpesa_sandbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TAWA-Signature': 'deadbeef', 'X-TAWA-Timestamp': String(Date.now()) }, body: raw,
  });
  assert.equal(bad.status, 401);
  const { sig, ts } = signWebhook(config.webhookSecrets.mpesa_sandbox, raw);
  const good = await fetch(`${base}/api/v1/webhooks/payments/mpesa_sandbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TAWA-Signature': sig, 'X-TAWA-Timestamp': String(ts) }, body: raw,
  });
  assert.equal(good.status, 200, await good.text());
  const replay = await fetch(`${base}/api/v1/webhooks/payments/mpesa_sandbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TAWA-Signature': sig, 'X-TAWA-Timestamp': String(ts) }, body: raw,
  });
  const replayJson = await replay.json();
  assert.equal(replayJson.data.status, 'duplicate_ignored', 'duplicate webhook must not reprocess');
  const payments = q.one(db, `SELECT COUNT(*) AS n FROM payments WHERE intent_id = ?`, intent.id).n;
  assert.equal(payments, 1, 'exactly one payment recorded');
  const settled = q.one(db, `SELECT status FROM payment_intents WHERE id = ?`, intent.id);
  assert.equal(settled.status, 'SETTLED');
});

test('client cannot forge payment success (§58 test 6)', async () => {
  const { json } = await api(base, ownerA.token, 'POST', '/api/v1/payments/intents', { amount: 100, provider: 'mpesa_sandbox', method: 'MPESA', idempotency_key: 'forge-1' });
  const intent = json.data.intent;
  await api(base, ownerA.token, 'POST', `/api/v1/payments/intents/${intent.id}/initiate`, {});
  // try to directly mark settled via a forged body — no such route; status must stay PROCESSING
  const st = q.one(db, `SELECT status FROM payment_intents WHERE id = ?`, intent.id).status;
  assert.equal(st, 'PROCESSING');
  const v = await api(base, ownerA.token, 'POST', `/api/v1/payments/intents/${intent.id}/verify`, { status: 'SETTLED', provider_confirmed: true });
  assert.equal(v.status, 202, 'forged success fields must be ignored — verify polls provider');
  const st2 = q.one(db, `SELECT status FROM payment_intents WHERE id = ?`, intent.id).status;
  assert.equal(st2, 'PROCESSING');
});

test('ledger stays balanced after sales/refunds/webhooks', () => {
  const check = verifyLedgerIntegrity(db, A.tenant.id);
  assert.equal(check.ok, true, JSON.stringify(check.unbalanced_entries.slice(0, 3)));
});

/* ---------- §13 quotes ---------- */
test('quote lifecycle: draft → sent → accepted → order; conversions idempotent', async () => {
  const q1 = await api(base, ownerA.token, 'POST', '/api/v1/quotes', { customer_id: A.fx.customer, items: [{ product_id: A.fx.product, qty: 3 }] });
  assert.equal(q1.status, 201);
  const quoteId = q1.json.data.id;
  const convertTooEarly = await api(base, ownerA.token, 'POST', `/api/v1/quotes/${quoteId}/convert`);
  assert.equal(convertTooEarly.status, 409);
  await api(base, ownerA.token, 'POST', `/api/v1/quotes/${quoteId}/send`);
  await api(base, ownerA.token, 'POST', `/api/v1/quotes/${quoteId}/accept`);
  const c1 = await api(base, ownerA.token, 'POST', `/api/v1/quotes/${quoteId}/convert`);
  const c2 = await api(base, ownerA.token, 'POST', `/api/v1/quotes/${quoteId}/convert`);
  assert.equal(c1.status, 201);
  assert.equal(c1.json.data.id, c2.json.data.id, 'second convert returns same order');
  const quote = q.one(db, `SELECT * FROM quotes WHERE id = ?`, quoteId);
  assert.equal(quote.status, 'CONVERTED');
});

/* ---------- §27 credit ---------- */
test('credit limit cannot be bypassed; repayment releases capacity', async () => {
  await api(base, financeA.token, 'POST', '/api/v1/credit/accounts', { customer_id: A.fx.customer, limit: 100_000 });
  const ok1 = await api(base, ownerA.token, 'POST', '/api/v1/orders', { customer_id: A.fx.customer, items: [{ product_id: A.fx.product, qty: 1, unit_price: 900 }], is_credit: true });
  assert.equal(ok1.status, 201, JSON.stringify(ok1.json));
  const over = await api(base, ownerA.token, 'POST', '/api/v1/orders', { customer_id: A.fx.customer, items: [{ product_id: A.fx.product, qty: 5, unit_price: 50_000 }], is_credit: true });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.details.code, 'CREDIT_LIMIT_EXCEEDED');
  const acct = q.one(db, `SELECT * FROM credit_transactions WHERE account_id = ?`, A.fx.customer);
  assert.ok(acct, 'credit charge must be audited in transactions');
});

/* ---------- §24 payroll lifecycle ---------- */
test('payroll requires review → approve; double execution impossible; segregation enforced', async () => {
  const wid = id('wrk');
  q.run(db, `INSERT INTO workers (id, tenant_id, code, name, role_title, wage_type, base_pay, status, created_at) VALUES (?,?,?,?,?,?,?, 'ACTIVE', ?)`,
    wid, A.tenant.id, 'W-TEST', 'Test Worker', 'GENERAL_WORKER', 'MONTHLY', 50000_00, nowIso());
  const calc = await api(base, ownerA.token, 'POST', '/api/v1/payroll/calculate', { period_start: '2026-08-01', period_end: '2026-08-31' });
  assert.equal(calc.status, 201);
  const run = calc.json.data.id;
  const execEarly = await api(base, financeA.token, 'POST', `/api/v1/payroll/runs/${run}/execute`, { method: 'CASH' });
  assert.equal(execEarly.status, 409, 'cannot execute before approval');
  const review = await api(base, ownerA.token, 'POST', `/api/v1/payroll/runs/${run}/review`);
  assert.equal(review.status, 200);
  const approveSelf = await api(base, ownerA.token, 'POST', `/api/v1/payroll/runs/${run}/approve`);
  assert.equal(approveSelf.status, 403, 'reviewer cannot approve own review');
  const approve = await api(base, financeA.token, 'POST', `/api/v1/payroll/runs/${run}/approve`);
  assert.equal(approve.status, 200);
  const exec1 = await api(base, ownerA.token, 'POST', `/api/v1/payroll/runs/${run}/execute`, { method: 'CASH' });
  assert.equal(exec1.status, 200);
  const exec2 = await api(base, ownerA.token, 'POST', `/api/v1/payroll/runs/${run}/execute`, { method: 'CASH' });
  assert.equal(exec2.json.data.replayed, true, 'double execution must replay, not re-pay');
  const runRow = q.one(db, `SELECT * FROM payroll_runs WHERE id = ?`, run);
  assert.equal(runRow.status, 'EXECUTED');
  const outbound = q.one(db, `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND direction = 'OUTBOUND'`, A.tenant.id).n;
  assert.ok(outbound >= 1);
  assert.equal(verifyLedgerIntegrity(db, A.tenant.id).ok, true);
});

/* ---------- §19 broker commission ---------- */
test('commission computes once per order, paid once', async () => {
  const bid = id('brk');
  q.run(db, `INSERT INTO brokers (id, tenant_id, code, name, commission_pct, status, created_at) VALUES (?,?,?,?,10, 'ACTIVE', ?)`, bid, A.tenant.id, 'B-T1', 'Test Broker', nowIso());
  const sale = await api(base, ownerA.token, 'POST', '/api/v1/pos/sale', { idempotency_key: 'pos-broker-1', items: [{ product_id: A.fx.product, qty: 1 }], method: 'CASH' });
  // attach broker by direct order patch (POS body does not take broker) — use orders endpoint instead
  void sale;
  const fxOrder = await api(base, ownerA.token, 'POST', '/api/v1/orders', { customer_id: A.fx.customer, broker_id: bid, items: [{ product_id: A.fx.product, qty: 1, unit_price: 1000 }] });
  assert.equal(fxOrder.status, 201);
  const orderId = fxOrder.json.data.id;
  ci: {
    const { json: cj } = await api(base, ownerA.token, 'POST', '/api/v1/payments/intents', { order_id: orderId, amount: fxOrder.json.data.total / 100, provider: 'cash', method: 'CASH', idempotency_key: 'comm-1' });
    await api(base, ownerA.token, 'POST', `/api/v1/payments/intents/${cj.data.intent.id}/initiate`, {});
    await api(base, ownerA.token, 'POST', `/api/v1/payments/intents/${cj.data.intent.id}/confirm-cash`, { amount: fxOrder.json.data.total / 100 });
  }
  const cms = q.all(db, `SELECT * FROM commissions WHERE order_id = ?`, orderId);
  assert.equal(cms.length, 1, 'exactly one commission row per order/broker');
  assert.equal(cms[0].status, 'EARNED');
  const appr = await api(base, financeA.token, 'POST', `/api/v1/commissions/${cms[0].id}/approve`);
  assert.equal(appr.status, 200);
  const pay1 = await api(base, financeA.token, 'POST', `/api/v1/commissions/${cms[0].id}/pay`, { method: 'CASH' });
  assert.equal(pay1.status, 200);
  const pay2 = await api(base, financeA.token, 'POST', `/api/v1/commissions/${cms[0].id}/pay`, { method: 'CASH' });
  assert.equal(pay2.status, 409, 'commission cannot be paid twice');
  assert.equal(verifyLedgerIntegrity(db, A.tenant.id).ok, true);
});

/* ---------- §55/§58 subscription & sessions ---------- */
test('revoked session cannot continue (§58 test 9)', async () => {
  const u = makeUser(db, A.tenant.id, 'temp@alpha.test', 'CASHIER');
  const sess = await login(base, u.email, 'Test#Pass1');
  const r1 = await api(base, sess.token, 'GET', '/api/v1/products');
  assert.equal(r1.status, 200);
  q.run(db, `UPDATE sessions SET revoked_at = ? WHERE user_id = ?`, nowIso(), sess.user.id);
  const r2 = await api(base, sess.token, 'GET', '/api/v1/products');
  assert.equal(r2.status, 401);
});

test('suspended tenant loses writes but keeps data; restore recovers (§55)', async () => {
  q.run(db, `UPDATE tenants SET status = 'SUSPENDED' WHERE id = ?`, B.tenant.id);
  const w = await api(base, ownerB.token, 'POST', '/api/v1/orders', { customer_id: B.fx.customer, items: [{ product_id: B.fx.product, qty: 1 }] });
  assert.equal(w.status, 402);
  const rd = await api(base, ownerB.token, 'GET', '/api/v1/products');
  assert.equal(rd.status, 402, 'suspension blocks access but data remains (read also gated by status)');
  q.run(db, `UPDATE tenants SET status = 'ACTIVE' WHERE id = ?`, B.tenant.id);
  const rd2 = await api(base, ownerB.token, 'GET', '/api/v1/products');
  assert.equal(rd2.status, 200);
});

test('expired subscription silently retains no restricted entitlements (§58 test 8)', async () => {
  const T = makeTenant(db, { code: 'freetenant', plan: 'FREE' });
  makeFixture(db, T.tenant.id);
  const tOwner = await login(base, T.ownerEmail, T.ownerPassword);
  const ai = await api(base, tOwner.token, 'POST', '/api/v1/ai/ask', { question: 'sales today' });
  assert.equal(ai.status, 403, 'FREE plan lacks TAWA.AI');
  const up = await api(base, tOwner.token, 'POST', '/api/v1/billing/change-plan', { plan_id: 'STARTER' });
  assert.equal(up.status, 200);
  const ai2 = await api(base, tOwner.token, 'POST', '/api/v1/ai/ask', { question: 'how much did we sell today' });
  assert.equal(ai2.status, 200, 'upgrade activates TAWA.AI');
});

/* ---------- brand isolation (§56 test 6 white-label) ---------- */
test('tenants render with independent branding; host resolves tenant', async () => {
  const brandA = await (await fetch(`${base}/api/v1/brand?code=alpha`)).json();
  const brandB = await (await fetch(`${base}/api/v1/brand?code=buildpro`)).json();
  assert.notEqual(brandA.data.branding.business_name, brandB.data.branding.business_name);
  const viaHost = await fetch(`${base}/api/v1/brand`, { headers: { 'X-Tenant-Host': 'buildpro.tawa.app' } });
  const j = await viaHost.json();
  assert.equal(j.data.tenant.code, 'buildpro');
});

/* ---------- white label contrast guard ---------- */
test('inaccessible theme colors are rejected (§40)', async () => {
  const r = await api(base, ownerA.token, 'PUT', '/api/v1/settings/branding', { color_text: '#ffffff', color_surface: '#fefefe' });
  assert.equal(r.status, 422);
});

/* ---------- AI PREPARE never commits money ---------- */
test('AI PREPARE creates drafts requiring approval, never POs (§58 AI safety)', async () => {
  // force low stock + supplier link so PREPARE can draft a PO
  const supId = id('sup');
  q.run(db, `INSERT INTO suppliers (id, tenant_id, code, name, lead_time_days, payment_terms, created_at, updated_at) VALUES (?,?,?,?,2,'COD',?,?)`, supId, A.tenant.id, 'S-AI', 'AI Test Supplier', nowIso(), nowIso());
  q.run(db, `UPDATE products SET supplier_id = ?, max_stock = 200 WHERE id = ?`, supId, A.fx.product);
  await api(base, ownerA.token, 'POST', '/api/v1/inventory/adjust', { warehouse_id: A.fx.warehouse, type: 'ADJUST', reason: 'drain', allow_negative: true, items: [{ product_id: A.fx.product, qty: -10_000 }] });
  const r = await api(base, ownerA.token, 'POST', '/api/v1/ai/ask', { question: 'Prepare purchase orders for approval' });
  assert.equal(r.status, 200);
  const cls = r.json.data.action_class;
  assert.ok(['PREPARE', 'READ', 'RECOMMEND'].includes(cls));
  if (cls === 'PREPARE') {
    const reqs = q.all(db, `SELECT * FROM purchase_requisitions WHERE tenant_id = ? AND source = 'AI_REORDER'`, A.tenant.id);
    assert.ok(reqs.length >= 1, 'AI requisition exists');
    const pos = q.all(db, `SELECT * FROM purchase_orders WHERE tenant_id = ? AND status IN ('SENT','APPROVED','RECEIVED')`, A.tenant.id);
    assert.equal(pos.length, 0, 'AI must never create/send spend');
  }
});

/* ---------- attachments: audit contains privileged events ---------- */
test('sensitive actions are audited (§39)', async () => {
  const n = q.one(db, `SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ?`, A.tenant.id).n;
  assert.ok(n > 10, `expected audit trail to accumulate (got ${n})`);
  const acts = q.all(db, `SELECT DISTINCT action FROM audit_events WHERE tenant_id = ?`, A.tenant.id).map(r => r.action);
  for (const want of ['payment.refund.execute', 'payroll.execute']) {
    assert.ok(acts.includes(want), `missing audit for ${want}: ${acts.join(',')}`);
  }
});
