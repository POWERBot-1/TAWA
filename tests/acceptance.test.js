import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStack, makeTenant, makeUser, makeFixture, login, api } from './helpers.js';
import { q, id, nowIso } from '../server/db/connection.js';
import { verifyLedgerIntegrity } from '../server/modules/ledger.js';

let stack, db, base;
let owner, cashier, keeper, finance, driver;
let A;

before(async () => {
  stack = await makeStack(); db = stack.db; base = stack.base;
  A = makeTenant(db, { code: 'hwflow', plan: 'BUSINESS' });
  A.fx = makeFixture(db, A.tenant.id, { stock: 500 });
  owner = await login(base, A.ownerEmail, A.ownerPassword);
  cashier = await login(base, makeUser(db, A.tenant.id, 'c1@x.test', 'CASHIER').email, 'Test#Pass1');
  keeper = await login(base, makeUser(db, A.tenant.id, 'k1@x.test', 'STOREKEEPER').email, 'Test#Pass1');
  finance = await login(base, makeUser(db, A.tenant.id, 'f1@x.test', 'FINANCE_MANAGER').email, 'Test#Pass1');
  driver = await login(base, makeUser(db, A.tenant.id, 'd1@x.test', 'DRIVER').email, 'Test#Pass1');
});
after(async () => stack.close());

/** TEST 1 (§56): full hardware sale workflow → ledger → notification. */
test('TEST 1 — hardware sale end-to-end', async () => {
  // Product search
  const search = await api(base, cashier.token, 'GET', '/api/v1/products?q=cement');
  assert.equal(search.status, 200);
  const product = search.json.data[0];
  assert.ok(product, 'product searchable');

  // Quote
  const q1 = await api(base, owner.token, 'POST', '/api/v1/quotes', { customer_id: A.fx.customer, items: [{ product_id: product.id, qty: 5 }], valid_days: 7 });
  assert.equal(q1.status, 201);
  const quote = q1.json.data;
  assert.equal(quote.status, 'DRAFT');

  await api(base, owner.token, 'POST', `/api/v1/quotes/${quote.id}/send`);
  const accepted = await api(base, owner.token, 'POST', `/api/v1/quotes/${quote.id}/accept`);
  assert.equal(accepted.json.data.status, 'ACCEPTED');

  // Accepted quote → order without re-entry
  const converted = await api(base, owner.token, 'POST', `/api/v1/quotes/${quote.id}/convert`);
  assert.equal(converted.status, 201);
  const order = converted.json.data;
  assert.equal(order.quote_id, quote.id);
  assert.equal(order.items.length, 1);

  // Reservation happened
  const rsv = q.one(db, `SELECT * FROM stock_reservations WHERE order_id = ? AND status = 'ACTIVE'`, order.id);
  assert.ok(rsv, 'stock reserved against order');

  // Payment (cash, server-confirmed + verified)
  const { json: cj } = await api(base, cashier.token, 'POST', '/api/v1/payments/intents', { order_id: order.id, customer_id: A.fx.customer, amount: order.total / 100, provider: 'cash', method: 'CASH', idempotency_key: `acc1-pay` });
  await api(base, cashier.token, 'POST', `/api/v1/payments/intents/${cj.data.intent.id}/initiate`, {});
  const settled = await api(base, cashier.token, 'POST', `/api/v1/payments/intents/${cj.data.intent.id}/confirm-cash`, { amount: order.total / 100 });
  assert.equal(settled.json.data.intent.status, 'SETTLED');
  const payment = settled.json.data.payment;
  assert.ok(payment.reference);

  // Order now PAID
  const o2 = q.one(db, `SELECT * FROM orders WHERE id = ?`, order.id);
  assert.equal(o2.payment_status, 'PAID');

  // Fulfil
  const fulfilled = await api(base, keeper.token, 'POST', `/api/v1/orders/${order.id}/fulfil`);
  assert.equal(fulfilled.status, 201);

  // Delivery with OTP → dispatch → complete
  const driverWorker = id('wrk');
  q.run(db, `INSERT INTO workers (id, tenant_id, code, name, role_title, wage_type, base_pay, status, created_at) VALUES (?,?,?,?, 'DRIVER','DAILY',150000,'ACTIVE',?)`, driverWorker, A.tenant.id, 'W-DRV', 'Driver One', nowIso());
  const del = await api(base, owner.token, 'POST', '/api/v1/deliveries', { order_id: order.id, address: 'Site 12, Ruiru' });
  const delivery = del.json.data;
  await api(base, owner.token, 'POST', `/api/v1/deliveries/${delivery.id}/assign`, { driver_id: driverWorker });
  const otp = q.one(db, `SELECT otp_code FROM deliveries WHERE id = ?`, delivery.id).otp_code;
  await api(base, owner.token, 'POST', `/api/v1/deliveries/${delivery.id}/advance`, { to: 'DISPATCHED' });
  await api(base, owner.token, 'POST', `/api/v1/deliveries/${delivery.id}/advance`, { to: 'IN_TRANSIT' });
  // wrong OTP rejected
  const badOtp = await api(base, owner.token, 'POST', `/api/v1/deliveries/${delivery.id}/complete`, { otp: '0000' });
  assert.equal(badOtp.status, 409);
  const good = await api(base, driver.token, 'POST', `/api/v1/deliveries/${delivery.id}/complete`, { otp });
  assert.equal(good.json.data.status, 'DELIVERED');

  // Receipt doc (branded)
  const receipt = await fetch(`${base}/api/v1/receipts/${payment.id}`, { headers: { Authorization: `Bearer ${cashier.token}` } });
  const html = await receipt.text();
  assert.ok(html.includes('HWFLOW TEST'), 'receipt carries tenant branding');

  // Ledger reflected & balanced
  const orderJournals = q.all(db, `SELECT * FROM journal_entries WHERE tenant_id = ? AND ref_id = ?`, A.tenant.id, cj.data.intent.id);
  assert.ok(orderJournals.length >= 1);
  assert.equal(verifyLedgerIntegrity(db, A.tenant.id).ok, true);

  // Customer SMS (sandbox) for payment verified
  const sms = q.one(db, `SELECT * FROM notifications WHERE tenant_id = ? AND ref_type = 'payment' AND channel = 'SMS' ORDER BY created_at DESC`, A.tenant.id);
  assert.ok(sms, 'customer payment SMS queued via sandbox adapter');
  assert.match(sms.body, /Payment of KES/);
});

/** TEST 2 (§56): procurement workflow. */
test('TEST 2 — procurement end-to-end', async () => {
  const sup = id('sup');
  q.run(db, `INSERT INTO suppliers (id, tenant_id, code, name, lead_time_days, payment_terms, created_at, updated_at) VALUES (?,?,?,?,2,'NET30',?,?)`,
    sup, A.tenant.id, 'S-PROC', 'Proc Test Supplier', nowIso(), nowIso());
  q.run(db, `UPDATE products SET supplier_id = ?, max_stock = 500, reorder_point = 100 WHERE id = ?`, sup, A.fx.product2);

  // low stock signal on product2 (fixture: 500 in stock) — drain to 2
  const drain = await api(base, keeper.token, 'POST', '/api/v1/inventory/adjust', { warehouse_id: A.fx.warehouse, type: 'ADJUST', reason: 'simulate sales', allow_negative: false, items: [{ product_id: A.fx.product2, qty: -498 }] });
  assert.equal(drain.status, 201);

  // AI reorder analysis sees it
  const reorder = await api(base, owner.token, 'GET', '/api/v1/ai/reorder');
  assert.equal(reorder.status, 200);
  const rec = reorder.json.data.find(r => r.product_id === A.fx.product2);
  assert.ok(rec && rec.suggested_qty > 0, `AI suggests reorder for drained product (${JSON.stringify(rec)}).`);

  // Requisition (can be AI-prepared or manual)
  const req1 = await api(base, keeper.token, 'POST', '/api/v1/procurement/requisitions', { reason: 'Replenish sheet stock', items: [{ product_id: A.fx.product2, qty: rec.suggested_qty, est_cost: rec.est_cost }] });
  assert.equal(req1.status, 201);
  const reqn = await api(base, owner.token, 'POST', `/api/v1/procurement/requisitions/${req1.json.data.id}/approve`);
  assert.equal(reqn.json.data.status, 'APPROVED');

  // Convert to PO → approve → send
  const po1 = await api(base, owner.token, 'POST', '/api/v1/procurement/pos', { supplier_id: sup, requisition_id: req1.json.data.id, warehouse_id: A.fx.warehouse });
  assert.equal(po1.status, 201);
  const po = po1.json.data;
  await api(base, owner.token, 'POST', `/api/v1/procurement/pos/${po.id}/approve`);
  const sent = await api(base, owner.token, 'POST', `/api/v1/procurement/pos/${po.id}/send`);
  assert.equal(sent.json.data.status, 'SENT');

  // GRN — stock updated
  const before2 = q.one(db, `SELECT on_hand FROM inventory_items WHERE product_id = ? AND warehouse_id = ?`, A.fx.product2, A.fx.warehouse).on_hand;
  const grn = await api(base, keeper.token, 'POST', `/api/v1/procurement/pos/${po.id}/receive`, { items: [{ product_id: A.fx.product2, qty: rec.suggested_qty }] });
  assert.equal(grn.status, 201);
  const after2 = q.one(db, `SELECT on_hand FROM inventory_items WHERE product_id = ? AND warehouse_id = ?`, A.fx.product2, A.fx.warehouse).on_hand;
  assert.equal(after2, before2 + rec.suggested_qty, 'GRN incremented stock atomically');

  // Supplier invoice → AP ledger → pay
  const inv = await api(base, finance.token, 'POST', '/api/v1/procurement/invoices', { supplier_id: sup, po_id: po.id, amount: po.total / 100 });
  assert.equal(inv.status, 201);
  const pay = await api(base, finance.token, 'POST', `/api/v1/procurement/invoices/${inv.json.data.id}/pay`, { method: 'CASH' });
  assert.equal(pay.status, 200);
  const inv2 = q.one(db, `SELECT * FROM supplier_invoices WHERE id = ?`, inv.json.data.id);
  assert.equal(inv2.status, 'PAID');
  assert.equal(verifyLedgerIntegrity(db, A.tenant.id).ok, true);

  // PO is now fully received
  assert.equal(q.one(db, `SELECT status FROM purchase_orders WHERE id = ?`, po.id).status, 'RECEIVED');
});

/** TEST 5-lite (§56): AI analysis flows (READ/ANALYSE/RECOMMEND classes). */
test('TEST 5 — AI answers with data + class boundaries', async () => {
  for (const [qs, cls] of [
    ['How much did we sell today?', 'READ'],
    ['Which customers owe us money?', 'READ'],
    ['What should I reorder?', 'RECOMMEND'],
    ['Which products are dead stock?', 'RECOMMEND'],
  ]) {
    const r = await api(base, owner.token, 'POST', '/api/v1/ai/ask', { question: qs });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.action_class, cls, `${qs} → ${cls}`);
    assert.ok(r.json.data.answer.length > 10);
  }
  // audit of AI actions
  const log = q.one(db, `SELECT COUNT(*) AS n FROM ai_action_log WHERE tenant_id = ?`, A.tenant.id);
  assert.ok(log.n >= 4);
});

/** Order rejection on negative-attempted oversale without permit. */
test('Overselling beyond stock is rejected (no silent oversell)', async () => {
  const r = await api(base, cashier.token, 'POST', '/api/v1/pos/sale', { idempotency_key: `oversell-${Date.now()}`, items: [{ product_id: A.fx.product2, qty: 1e6 }], method: 'CASH' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.details.code, 'INSUFFICIENT_STOCK');
});
