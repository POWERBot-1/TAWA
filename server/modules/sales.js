import { q, id, nowIso } from '../db/connection.js';
import { err } from '../core/http.js';
import { docNo, postCogs, postCreditSale } from './ledger.js';
import { reserveStock, fulfilReserved, releaseReservations, stockAlerts, postMovement } from './inventory.js';
import { emitEvent } from '../core/events.js';

/**
 * Sales service (§11-13): quotes → orders → reservation → fulfilment.
 * Sales workflow is a controlled process; every step emits domain events.
 */

export const TAX_RATES = { VAT16: 0.16, ZERO: 0, EXEMPT: 0 };

export function priceForCustomer(product, customerType) {
  switch (customerType) {
    case 'WHOLESALE': return product.price_wholesale || product.price_retail;
    case 'CONTRACTOR': return product.price_contractor || product.price_retail;
    case 'CORPORATE': return product.price_contractor || product.price_retail;
    default: return product.price_retail;
  }
}

/** Compute totals for a set of priced items. All minor units. */
export function computeTotals(items) {
  let subtotal = 0, discount = 0, tax = 0;
  const lines = items.map(it => {
    const gross = Math.round(it.qty * it.unit_price);
    const lineDiscount = Math.round(it.discount || 0);
    const base = gross - lineDiscount;
    const rate = TAX_RATES[it.tax_category] ?? 0;
    const lineTax = Math.round(base * rate);
    subtotal += gross; discount += lineDiscount; tax += lineTax;
    return { ...it, unit_price: Math.round(it.unit_price), discount: lineDiscount, tax: lineTax, total: base + lineTax };
  });
  return { lines, subtotal, discount, tax, total: subtotal - discount + tax };
}

export function getQuote(db, tenantId, quoteId) {
  const quote = q.one(db, `SELECT * FROM quotes WHERE id = ? AND tenant_id = ?`, quoteId, tenantId);
  if (!quote) throw err.notFound('Quote not found');
  quote.items = q.all(db, `SELECT * FROM quote_items WHERE quote_id = ?`, quoteId);
  return quote;
}

export function createQuote(db, { tenantId, customerId, items, project = null, validDays = 14, salespersonId = null, brokerId = null, branchId = null, notes = null }) {
  const customer = q.one(db, `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`, customerId, tenantId);
  if (!customer) throw err.notFound('Customer not found');
  const priced = items.map(it => {
    const p = q.one(db, `SELECT * FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1`, it.product_id, tenantId);
    if (!p) throw err.notFound(`Product ${it.product_id} not found`);
    if (it.qty <= 0) throw err.unprocessable('Quantity must be positive');
    return {
      product_id: p.id, name_snap: p.name, qty: it.qty, unit: p.unit,
      unit_price: it.unit_price != null ? Math.round(it.unit_price) : priceForCustomer(p, customer.type),
      discount: Math.round(it.discount || 0), tax_category: p.tax_category,
    };
  });
  const totals = computeTotals(priced);
  const quoteId = id('qt');
  const number = `Q-${docNo(db, tenantId, 'quote')}`;
  const validUntil = new Date(Date.now() + validDays * 86400_000).toISOString();
  q.run(db, `INSERT INTO quotes (id, tenant_id, number, customer_id, project, status, valid_until, salesperson_id, broker_id, branch_id, subtotal, discount, tax, total, notes, created_at, updated_at)
             VALUES (?,?,?,?,?, 'DRAFT', ?,?,?,?,?,?,?,?,?,?,?)`,
    quoteId, tenantId, number, customerId, project, validUntil, salespersonId, brokerId, branchId,
    totals.subtotal, totals.discount, totals.tax, totals.total, notes, nowIso(), nowIso());
  for (const l of totals.lines) {
    q.run(db, `INSERT INTO quote_items (id, quote_id, product_id, name_snap, qty, unit, unit_price, discount, tax, total)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id('qi'), quoteId, l.product_id, l.name_snap, l.qty, l.unit, l.unit_price, l.discount, l.tax, l.total);
  }
  emitEvent(db, tenantId, 'QuoteCreated', { quote_id: quoteId, number, customer: customer.name, total: totals.total, ref_type: 'quote', ref_id: quoteId });
  return getQuote(db, tenantId, quoteId);
}

export function transitionQuote(db, tenantId, quoteId, to, actorId = null) {
  const quote = getQuote(db, tenantId, quoteId);
  const allowed = {
    DRAFT: ['REVIEW', 'SENT', 'CANCELLED'],
    REVIEW: ['SENT', 'DRAFT'],
    SENT: ['VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED'],
    VIEWED: ['ACCEPTED', 'REJECTED', 'EXPIRED'],
  };
  if (quote.status === 'ACCEPTED' && to === 'ACCEPTED') return quote; // idempotent
  if (!(allowed[quote.status] || []).includes(to)) {
    throw err.conflict(`Quote cannot move from ${quote.status} to ${to}`);
  }
  if (to === 'ACCEPTED' && quote.valid_until && quote.valid_until < nowIso()) {
    q.run(db, `UPDATE quotes SET status = 'EXPIRED', updated_at = ? WHERE id = ?`, nowIso(), quoteId);
    throw err.conflict('Quote has expired and can no longer be accepted');
  }
  q.run(db, `UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?`, to, nowIso(), quoteId);
  emitEvent(db, tenantId, `Quote${to === 'ACCEPTED' ? 'Accepted' : to === 'REJECTED' ? 'Rejected' : to === 'SENT' ? 'Sent' : 'Updated'}`,
    { quote_id: quoteId, number: quote.number, total: quote.total, quote_status: to.toLowerCase(), ref_type: 'quote', ref_id: quoteId }, actorId);
  return getQuote(db, tenantId, quoteId);
}

/** Accepted quote → order, no re-entry of data (§13). Idempotent. */
export function convertQuoteToOrder(db, tenantId, quoteId, actorId = null) {
  const quote = getQuote(db, tenantId, quoteId);
  if (quote.order_id) return getOrder(db, tenantId, quote.order_id); // idempotent
  if (quote.status !== 'ACCEPTED') throw err.conflict('Only accepted quotes can be converted to orders');
  const order = createOrder(db, {
    tenantId, customerId: quote.customer_id, quoteId,
    items: quote.items.map(i => ({ product_id: i.product_id, qty: i.qty, unit_price: i.unit_price, discount: i.discount })),
    source: 'WEB', actorId, notes: quote.notes, branchId: quote.branch_id,
    salespersonId: quote.salesperson_id, brokerId: quote.broker_id,
    autoReserve: true,
  });
  q.run(db, `UPDATE quotes SET status = 'CONVERTED', order_id = ?, updated_at = ? WHERE id = ?`, order.id, nowIso(), quoteId);
  return order;
}

export function getOrder(db, tenantId, orderId) {
  const order = q.one(db, `SELECT * FROM orders WHERE id = ? AND tenant_id = ?`, orderId, tenantId);
  if (!order) throw err.notFound('Order not found');
  order.items = q.all(db, `SELECT * FROM order_items WHERE order_id = ?`, orderId);
  return order;
}

export function createOrder(db, { tenantId, customerId = null, quoteId = null, items, source = 'POS', actorId = null, notes = null, branchId = null, warehouseId = null, salespersonId = null, brokerId = null, deliveryFee = 0, address = null, autoReserve = true, isCredit = false, idempotencyKey = null }) {
  if (idempotencyKey) {
    const existing = q.one(db, `SELECT id FROM orders WHERE tenant_id = ? AND idempotency_key = ?`, tenantId, idempotencyKey);
    if (existing) return getOrder(db, tenantId, existing.id);
  }
  let customerType = 'RETAIL';
  let customerName = 'Walk-in customer';
  if (customerId) {
    const c = q.one(db, `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`, customerId, tenantId);
    if (!c) throw err.notFound('Customer not found');
    customerType = c.type; customerName = c.name;
  }
  if (!warehouseId) {
    const wh = q.one(db, `SELECT id FROM warehouses WHERE tenant_id = ? AND is_active = 1 ORDER BY code LIMIT 1`, tenantId);
    if (!wh) throw err.conflict('No active warehouse configured');
    warehouseId = wh.id;
  }
  const priced = items.map(it => {
    const p = q.one(db, `SELECT * FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1`, it.product_id, tenantId);
    if (!p) throw err.notFound(`Product ${it.product_id} not found`);
    if (it.qty <= 0) throw err.unprocessable('Quantity must be positive');
    const price = it.unit_price != null ? Math.round(it.unit_price) : priceForCustomer(p, customerType);
    if (p.price_min > 0 && price < p.price_min) throw err.unprocessable(`Price for ${p.name} is below minimum (${p.price_min / 100})`);
    return {
      product_id: p.id, name_snap: p.name, qty: it.qty, unit: p.unit, unit_price: price,
      cost_price: p.cost_price, discount: Math.round(it.discount || 0), tax_category: p.tax_category,
    };
  });
  const totals = computeTotals(priced);
  const fee = Math.round(deliveryFee || 0);
  const orderId = id('ord');
  const number = `O-${docNo(db, tenantId, 'order')}`;
  q.run(db, `INSERT INTO orders (id, tenant_id, number, customer_id, quote_id, source, status, payment_status, salesperson_id, broker_id, branch_id, warehouse_id, subtotal, discount, tax, delivery_fee, total, address, notes, is_credit, idempotency_key, created_at, updated_at)
             VALUES (?,?,?,?,?,?, 'CONFIRMED', 'UNPAID', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    orderId, tenantId, number, customerId, quoteId, source, salespersonId, brokerId, branchId, warehouseId,
    totals.subtotal, totals.discount, totals.tax, fee, totals.total + fee, address, notes, isCredit ? 1 : 0, idempotencyKey, nowIso(), nowIso());
  for (const l of totals.lines) {
    q.run(db, `INSERT INTO order_items (id, order_id, product_id, name_snap, qty, unit, unit_price, cost_price, discount, tax, total)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id('oi'), orderId, l.product_id, l.name_snap, l.qty, l.unit, l.unit_price, l.cost_price, l.discount, l.tax, l.total);
  }
  if (autoReserve) {
    reserveStock(db, { tenantId, orderId, warehouseId, items: totals.lines.map(l => ({ product_id: l.product_id, qty: l.qty })), actorId });
  }
  emitEvent(db, tenantId, 'OrderCreated', {
    order_id: orderId, number, customer: customerName, total: totals.total + fee,
    source, ref_type: 'order', ref_id: orderId,
  }, actorId);
  if (isCredit) applyCreditSale(db, tenantId, orderId, actorId);
  return getOrder(db, tenantId, orderId);
}

/** Credit sale: enforce limit + authorization trail (§27). */
function applyCreditSale(db, tenantId, orderId, actorId) {
  const order = q.one(db, `SELECT * FROM orders WHERE id = ? AND tenant_id = ?`, orderId, tenantId);
  if (!order.customer_id) throw err.unprocessable('Credit sale requires a registered customer');
  const acct = q.one(db, `SELECT * FROM credit_accounts WHERE customer_id = ? AND tenant_id = ?`, order.customer_id, tenantId);
  if (!acct || !acct.is_active) throw err.conflict('Customer has no active credit account');
  const available = acct.limit_amount - acct.balance;
  if (order.total > available) {
    throw err.conflict('CREDIT_LIMIT_EXCEEDED', {
      code: 'CREDIT_LIMIT_EXCEEDED', limit: acct.limit_amount, balance: acct.balance,
      available, required: order.total,
      message: `Credit limit exceeded: available ${(available / 100).toFixed(2)}, required ${(order.total / 100).toFixed(2)}`,
    });
  }
  const balanceAfter = acct.balance + order.total;
  q.run(db, `UPDATE credit_accounts SET balance = ?, updated_at = ? WHERE customer_id = ?`, balanceAfter, nowIso(), order.customer_id);
  q.run(db, `INSERT INTO credit_transactions (id, tenant_id, account_id, type, amount, balance_after, ref_type, ref_id, actor_id, created_at)
             VALUES (?,?,?,'CHARGE',?,?, 'order', ?,?,?)`,
    id('ctx'), tenantId, order.customer_id, order.total, balanceAfter, orderId, actorId, nowIso());
  const vat = order.tax;
  postCreditSale(db, tenantId, { gross: order.total, net: order.total - vat, vat, refId: orderId, actorId });
  emitEvent(db, tenantId, 'CreditCharged', { order_id: orderId, customer_id: order.customer_id, amount: order.total, ref_type: 'order', ref_id: orderId }, actorId);
}

/** Fulfil an order's items from its warehouse: issue stock + COGS. Idempotent. */
export function fulfilOrder(db, tenantId, orderId, actorId = null) {
  const order = q.one(db, `SELECT * FROM orders WHERE id = ? AND tenant_id = ?`, orderId, tenantId);
  if (!order) throw err.notFound('Order not found');
  if (['DELIVERED', 'COMPLETED', 'DELIVERING'].includes(order.status)) return getOrder(db, tenantId, orderId);
  if (order.status === 'CANCELLED') throw err.conflict('Cancelled order cannot be fulfilled');
  const items = q.all(db, `SELECT * FROM order_items WHERE order_id = ?`, orderId);
  fulfilReserved(db, { tenantId, orderId, warehouseId: order.warehouse_id, items, actorId });
  const cogs = items.reduce((s, i) => s + Math.round(i.cost_price * i.qty), 0);
  postCogs(db, tenantId, { cogs, refId: orderId, actorId });
  q.run(db, `UPDATE orders SET status = 'DELIVERING', updated_at = ? WHERE id = ?`, nowIso(), orderId);
  for (const i of items) stockAlerts(db, tenantId, i.product_id);
  emitEvent(db, tenantId, 'OrderFulfilled', { order_id: orderId, number: order.number, ref_type: 'order', ref_id: orderId }, actorId);
  return getOrder(db, tenantId, orderId);
}

export function cancelOrder(db, tenantId, orderId, actorId = null, reason = null) {
  const order = q.one(db, `SELECT * FROM orders WHERE id = ? AND tenant_id = ?`, orderId, tenantId);
  if (!order) throw err.notFound('Order not found');
  if (['DELIVERED', 'COMPLETED'].includes(order.status)) throw err.conflict('Delivered order cannot be cancelled; use returns');
  if (order.payment_status === 'PAID') throw err.conflict('Paid order requires refund processing before cancellation');
  releaseReservations(db, { tenantId, orderId, actorId });
  q.run(db, `UPDATE orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, nowIso(), orderId);
  emitEvent(db, tenantId, 'OrderCancelled', { order_id: orderId, number: order.number, reason, ref_type: 'order', ref_id: orderId }, actorId);
  return getOrder(db, tenantId, orderId);
}
