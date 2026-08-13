import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, pageParams, send } from '../core/http.js';
import { mustPerm, hasPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { createQuote, getQuote, transitionQuote, convertQuoteToOrder, createOrder, getOrder, fulfilOrder, cancelOrder } from '../modules/sales.js';
import { createIntent, initiateIntent, verifyAndSettle, fmtMoney } from '../modules/payments.js';
import { getProvider } from '../adapters/payments.js';
import { invoiceDoc, receiptDoc, quoteDoc, deliveryNoteDoc, nextDocumentNumber } from '../modules/documents.js';
import { emitEvent } from '../core/events.js';
import { meter } from '../core/entitlements.js';
import { sendNotification } from '../adapters/messaging.js';
import { postSaleReceipt } from '../modules/ledger.js';

export function registerSales(router, db) {
  /* ---------------- Quotations (§13) ---------------- */
  router.get('/api/v1/quotes', (req, res) => {
    mustPerm(req, 'quotes.view');
    const { limit, offset } = pageParams(req);
    const rows = q.all(db, `SELECT qt.*, c.name AS customer_name, c.type AS customer_type FROM quotes qt JOIN customers c ON c.id = qt.customer_id
      WHERE qt.tenant_id = ? ${req.query.status ? 'AND qt.status = ?' : ''} ORDER BY qt.created_at DESC LIMIT ? OFFSET ?`,
      ...(req.query.status ? [req.tenantId, req.query.status] : [req.tenantId]), limit, offset);
    ok(res, rows);
  });
  router.get('/api/v1/quotes/:id', (req, res) => { mustPerm(req, 'quotes.view'); ok(res, getQuote(db, req.tenantId, req.params.id)); });
  router.post('/api/v1/quotes', async (req, res) => {
    mustPerm(req, 'quotes.create');
    const body = await readBody(req);
    const quote = tx(db, () => createQuote(db, {
      tenantId: req.tenantId, customerId: reqStr(body.customer_id, 'customer_id'),
      items: normalizeItems(body), project: optStr(body.project, 'project'),
      validDays: reqNum(body.valid_days ?? 14, 'valid_days', { min: 1, max: 365 }),
      salespersonId: body.salesperson_id || req.auth.user.id, brokerId: body.broker_id || null,
      branchId: body.branch_id || null, notes: optStr(body.notes, 'notes'),
    }));
    created(res, quote);
  });
  router.post('/api/v1/quotes/:id/send', (req, res) => {
    mustPerm(req, 'quotes.send');
    const quote = tx(db, () => transitionQuote(db, req.tenantId, req.params.id, 'SENT', req.auth.user.id));
    const customer = q.one(db, `SELECT * FROM customers WHERE id = ?`, quote.customer_id);
    if (customer?.phone) {
      sendNotification(db, {
        tenantId: req.tenantId, channel: 'SMS', recipientKind: 'CUSTOMER', recipientId: customer.id, toAddr: customer.phone,
        body: `${brandName(db, req.tenantId)}: Quotation ${quote.number} for ${fmtMoney(quote.total)} is ready. Valid until ${new Date(quote.valid_until).toLocaleDateString('en-KE')}.`,
        eventType: 'QuoteSent', refType: 'quote', refId: quote.id,
      });
    }
    ok(res, quote);
  });
  router.post('/api/v1/quotes/:id/accept', (req, res) => {
    // Digital customer approval (§13).
    if (!hasPerm(req, 'quotes.approve') && !hasPerm(req, 'quotes.create')) throw err.forbidden('Missing permission: quotes.approve');
    const quote = tx(db, () => transitionQuote(db, req.tenantId, req.params.id, 'ACCEPTED', req.auth.user.id));
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'quote.accept', resource: 'quote', resourceId: quote.id, metadata: { total: quote.total } });
    ok(res, quote);
  });
  router.post('/api/v1/quotes/:id/reject', async (req, res) => {
    mustPerm(req, 'quotes.create');
    ok(res, tx(db, () => transitionQuote(db, req.tenantId, req.params.id, 'REJECTED', req.auth.user.id)));
  });
  router.post('/api/v1/quotes/:id/convert', (req, res) => {
    mustPerm(req, 'orders.create');
    const order = tx(db, () => convertQuoteToOrder(db, req.tenantId, req.params.id, req.auth.user.id));
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'quote.convert', resource: 'order', resourceId: order.id });
    created(res, order);
  });
  router.get('/api/v1/quotes/:id/document', (req, res) => {
    mustPerm(req, 'quotes.view');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(quoteDoc(db, req.tenantId, req.params.id));
  });

  /* ---------------- Orders (§11) ---------------- */
  router.get('/api/v1/orders', (req, res) => {
    mustPerm(req, 'orders.view');
    const { limit, offset, page } = pageParams(req);
    const filters = ['o.tenant_id = ?']; const params = [req.tenantId];
    if (req.query.status) { filters.push('o.status = ?'); params.push(req.query.status); }
    if (req.query.payment_status) { filters.push('o.payment_status = ?'); params.push(req.query.payment_status); }
    if (req.query.customer_id) { filters.push('o.customer_id = ?'); params.push(req.query.customer_id); }
    const where = filters.join(' AND ');
    const total = q.one(db, `SELECT COUNT(*) AS n FROM orders o WHERE ${where}`, ...params).n;
    const rows = q.all(db, `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    ok(res, rows, { total, page });
  });
  router.get('/api/v1/orders/:id', (req, res) => { mustPerm(req, 'orders.view'); ok(res, orderView(db, req.tenantId, req.params.id)); });

  router.post('/api/v1/orders', async (req, res) => {
    mustPerm(req, 'orders.create');
    const body = await readBody(req);
    const order = tx(db, () => createOrder(db, {
      tenantId: req.tenantId, customerId: body.customer_id || null,
      items: normalizeItems(body), source: body.source || 'PHONE',
      actorId: req.auth.user.id, notes: optStr(body.notes, 'notes'),
      branchId: body.branch_id || null, warehouseId: body.warehouse_id || null,
      deliveryFee: body.delivery_fee != null ? Math.round(Number(body.delivery_fee) * 100) : 0,
      address: optStr(body.address, 'address'), isCredit: body.is_credit === true,
      idempotencyKey: body.idempotency_key || null,
      brokerId: body.broker_id || null,
    }));
    meter(db, req.tenantId, 'orders');
    created(res, order);
  });

  router.post('/api/v1/orders/:id/fulfil', (req, res) => {
    mustPerm(req, 'orders.fulfil');
    created(res, tx(db, () => fulfilOrder(db, req.tenantId, req.params.id, req.auth.user.id)));
  });
  router.post('/api/v1/orders/:id/cancel', async (req, res) => {
    mustPerm(req, 'orders.cancel');
    const body = await readBody(req);
    const order = tx(db, () => cancelOrder(db, req.tenantId, req.params.id, req.auth.user.id, optStr(body.reason, 'reason')));
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'order.cancel', resource: 'order', resourceId: order.id });
    ok(res, order);
  });
  router.get('/api/v1/orders/:id/invoice', (req, res) => {
    mustPerm(req, 'orders.view');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(invoiceDoc(db, req.tenantId, req.params.id));
  });

  /**
   * POS checkout (§12): order + reservation + payment + fulfilment + receipt
   * in one atomic transaction. Idempotent by idempotency_key (§21, §45).
   * Offline-safe: clients retry with the same key; server replays.
   */
  router.post('/api/v1/pos/sale', async (req, res) => {
    mustPerm(req, 'pos.use');
    const body = await readBody(req);
    const idemKey = reqStr(body.idempotency_key, 'idempotency_key', { max: 120 });
    // Full replay: identical key returns the original receipt.
    const prior = q.one(db, `SELECT id FROM orders WHERE tenant_id = ? AND idempotency_key = ?`, req.tenantId, idemKey);
    if (prior) {
      const order = orderView(db, req.tenantId, prior.id);
      const payment = q.one(db, `SELECT p.* FROM payments p JOIN payment_intents i ON i.id = p.intent_id WHERE i.order_id = ?`, prior.id);
      return ok(res, { order, payment, receipt_no: payment?.reference || null, replayed: true });
    }
    const method = reqStr(body.method, 'method');
    if (!['CASH', 'MPESA', 'CARD', 'BANK'].includes(method)) throw err.unprocessable('Unsupported POS payment method');
    const provider = { CASH: 'cash', MPESA: 'mpesa_sandbox', CARD: 'card_sandbox', BANK: 'bank_manual' }[method];
    const result = tx(db, () => {
      const order = createOrder(db, {
        tenantId: req.tenantId, customerId: body.customer_id || null,
        items: normalizeItems(body), source: 'POS', actorId: req.auth.user.id,
        warehouseId: body.warehouse_id || null, idempotencyKey: idemKey,
        deliveryFee: body.delivery_fee != null ? Math.round(Number(body.delivery_fee) * 100) : 0,
      });
      const { intent } = createIntent(db, {
        tenantId: req.tenantId, orderId: order.id, customerId: order.customer_id,
        amount: order.total, provider, method, phone: body.phone || null,
        idempotencyKey: `${idemKey}-pay`, meta: { pos: true },
      });
      initiateIntent(db, req.tenantId, intent.id, { card_token: body.card_token });
      if (method === 'CASH') {
        const okConfirm = getProvider('cash').confirmReceived(db, getIntentById(db, req.tenantId, intent.id), order.total, req.auth.user.id);
        if (!okConfirm.ok) throw err.conflict(okConfirm.reason);
      }
      const settled = verifyAndSettle(db, req.tenantId, intent.id, req.auth.user.id);
      if (settled.processing) {
        // Order persists with a PENDING payment — complete via /pos/complete
        // after server-side provider verification. Never assume success.
        return { order: orderView(db, req.tenantId, order.id), payment: null, intent_id: intent.id, pending: true, replayed: false };
      }
      fulfilOrder(db, req.tenantId, order.id, req.auth.user.id);
      q.run(db, `UPDATE orders SET status = 'COMPLETED', updated_at = ? WHERE id = ?`, nowIso(), order.id);
      meter(db, req.tenantId, 'orders');
      return { order: orderView(db, req.tenantId, order.id), payment: settled.payment, replayed: false };
    });
    if (result.pending) {
      audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'pos.sale_pending', resource: 'order', resourceId: result.order.id });
      return send(res, 202, { data: result });
    }
    emitEvent(db, req.tenantId, 'SaleCompleted', { order_id: result.order.id, number: result.order.number, total: result.order.total, method, ref_type: 'order', ref_id: result.order.id }, req.auth.user.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'pos.sale', resource: 'order', resourceId: result.order.id, metadata: { total: result.order.total, method } });
    created(res, { ...result, receipt_no: result.payment?.reference, replayed: false });
  });

  /** Complete a pending POS payment after a PENDING conflict. */
  router.post('/api/v1/pos/complete', async (req, res) => {
    mustPerm(req, 'pos.use');
    const body = await readBody(req);
    const intentId = reqStr(body.intent_id, 'intent_id');
    const result = tx(db, () => {
      const settled = verifyAndSettle(db, req.tenantId, intentId, req.auth.user.id);
      const intent = getIntentById(db, req.tenantId, intentId);
      if (intent.order_id) {
        const order = q.one(db, `SELECT * FROM orders WHERE id = ?`, intent.order_id);
        if (order && order.status === 'CONFIRMED' && order.payment_status === 'PAID') {
          fulfilOrder(db, req.tenantId, order.id, req.auth.user.id);
          q.run(db, `UPDATE orders SET status = 'COMPLETED', updated_at = ? WHERE id = ?`, nowIso(), order.id);
        }
      }
      return settled;
    });
    ok(res, result);
  });

  router.get('/api/v1/receipts/:paymentId', (req, res) => {
    mustPerm(req, 'payments.view');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(receiptDoc(db, req.tenantId, req.params.paymentId));
  });
  router.get('/api/v1/deliveries/:id/note', (req, res) => {
    mustPerm(req, 'deliveries.view');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(deliveryNoteDoc(db, req.tenantId, req.params.id));
  });

  /** Daily sales summary for POS header. */
  router.get('/api/v1/sales/today', (req, res) => {
    mustPerm(req, 'sales.view');
    const start = new Date().toISOString().slice(0, 10);
    const row = q.one(db, `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS total, COALESCE(SUM(amount_paid),0) AS collected
      FROM orders WHERE tenant_id = ? AND status != 'CANCELLED' AND created_at >= ?`, req.tenantId, start);
    ok(res, row);
  });
  void postSaleReceipt; void nextDocumentNumber;
}

function getIntentById(db, tenantId, intentId) {
  const intent = q.one(db, `SELECT * FROM payment_intents WHERE id = ? AND tenant_id = ?`, intentId, tenantId);
  if (!intent) throw err.notFound('Payment intent not found');
  return intent;
}

function normalizeItems(body) {
  if (!Array.isArray(body.items) || !body.items.length) throw err.unprocessable('items[] required');
  return body.items.map(it => ({
    product_id: reqStr(it.product_id, 'product_id'),
    qty: reqNum(it.qty, 'qty', { min: 0.0001 }),
    unit_price: it.unit_price != null ? Math.round(Number(it.unit_price) * 100) : undefined,
    discount: it.discount != null ? Math.round(Number(it.discount) * 100) : 0,
  }));
}

function orderView(db, tenantId, orderId) {
  const order = getOrder(db, tenantId, orderId);
  order.customer = order.customer_id ? q.one(db, `SELECT id, name, phone, type FROM customers WHERE id = ?`, order.customer_id) : null;
  order.payments = q.all(db, `SELECT p.* FROM payments p JOIN payment_intents i ON i.id = p.intent_id WHERE i.order_id = ?`, orderId);
  order.delivery = q.one(db, `SELECT * FROM deliveries WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`, orderId) || null;
  return order;
}

function brandName(db, tenantId) {
  return q.one(db, `SELECT business_name FROM tenant_branding WHERE tenant_id = ?`, tenantId)?.business_name || 'TAWA';
}
