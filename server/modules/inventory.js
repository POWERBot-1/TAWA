import { q, id, nowIso } from '../db/connection.js';
import { err } from '../core/http.js';

/**
 * Inventory engine (§9). Movements are immutable audit events — the only
 * way stock changes. Never silently mutate inventory.
 * Invariant: stock cannot go negative unless the tenant explicitly permits.
 */
const STOCK_EFFECT = {
  RECEIVE: +1, TRANSFER_IN: +1, RETURN: +1, ADJUST: 0, COUNT: 0,
  ISSUE: -1, TRANSFER_OUT: -1, DAMAGE: -1,
};

export function positionFor(db, tenantId, productId, warehouseId) {
  let row = q.one(db, `SELECT * FROM inventory_items WHERE tenant_id = ? AND product_id = ? AND warehouse_id = ?`,
    tenantId, productId, warehouseId);
  if (!row) {
    q.run(db, `INSERT INTO inventory_items (tenant_id, product_id, warehouse_id, on_hand, reserved, damaged, updated_at)
               VALUES (?,?,?,0,0,0,?)`, tenantId, productId, warehouseId, nowIso());
    row = q.one(db, `SELECT * FROM inventory_items WHERE tenant_id = ? AND product_id = ? AND warehouse_id = ?`,
      tenantId, productId, warehouseId);
  }
  return row;
}

/**
 * Post a stock movement. MUST be called inside tx().
 * qty: positive magnitude. ADJUST/COUNT use signed qtyDelta directly.
 */
export function postMovement(db, { tenantId, productId, warehouseId, type, qty, qtyDelta = null, reason = null, refType = null, refId = null, actorId = null, allowNegative = false }) {
  const delta = qtyDelta !== null ? qtyDelta : (STOCK_EFFECT[type] ?? 0) * Math.abs(qty);
  if (delta === 0 && !['COUNT'].includes(type)) throw err.unprocessable(`Movement type ${type} cannot have zero quantity`);
  const pos = positionFor(db, tenantId, productId, warehouseId);
  const after = pos.on_hand + delta;
  if (after < 0 && !allowNegative) {
    throw err.conflict('INSUFFICIENT_STOCK', {
      code: 'INSUFFICIENT_STOCK', product_id: productId,
      on_hand: pos.on_hand, requested: Math.abs(delta),
      message: `Insufficient stock: on hand ${pos.on_hand}, requested ${Math.abs(delta)}`,
    });
  }
  const moveId = id('mov');
  q.run(db, `INSERT INTO inventory_movements
    (id, tenant_id, product_id, warehouse_id, type, qty_delta, on_hand_after, reason, ref_type, ref_id, actor_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    moveId, tenantId, productId, warehouseId, type, delta, after, reason, refType, refId, actorId, nowIso());
  q.run(db, `UPDATE inventory_items SET on_hand = ?, updated_at = ? WHERE tenant_id = ? AND product_id = ? AND warehouse_id = ?`,
    after, nowIso(), tenantId, productId, warehouseId);
  return { id: moveId, on_hand_after: after };
}

/** Reserve stock against an order (does not change on_hand). */
export function reserveStock(db, { tenantId, orderId, warehouseId, items, actorId }) {
  for (const item of items) {
    const pos = positionFor(db, tenantId, item.product_id, warehouseId);
    const available = pos.on_hand - pos.reserved;
    if (available < item.qty) {
      throw err.conflict('INSUFFICIENT_STOCK', {
        code: 'INSUFFICIENT_STOCK', product_id: item.product_id,
        available, requested: item.qty,
        message: `Cannot reserve: available ${available}, requested ${item.qty}`,
      });
    }
  }
  for (const item of items) {
    q.run(db, `INSERT INTO stock_reservations (id, tenant_id, order_id, product_id, warehouse_id, qty, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?, 'ACTIVE', ?, ?)`,
      id('rsv'), tenantId, orderId, item.product_id, warehouseId, item.qty, nowIso(), nowIso());
    q.run(db, `UPDATE inventory_items SET reserved = reserved + ?, updated_at = ? WHERE tenant_id = ? AND product_id = ? AND warehouse_id = ?`,
      item.qty, nowIso(), tenantId, item.product_id, warehouseId);
    q.run(db, `INSERT INTO inventory_movements
      (id, tenant_id, product_id, warehouse_id, type, qty_delta, on_hand_after, reason, ref_type, ref_id, actor_id, created_at)
      VALUES (?,?,?,?, 'RESERVE', 0, ?, ?, 'order', ?, ?, ?)`,
      id('mov'), tenantId, item.product_id, warehouseId,
      positionFor(db, tenantId, item.product_id, warehouseId).on_hand,
      `Reserved ${item.qty} for order`, orderId, actorId, nowIso());
  }
}

/** Consume reservations on fulfilment: release hold + issue stock. */
export function fulfilReserved(db, { tenantId, orderId, warehouseId, items, actorId }) {
  const out = [];
  for (const item of items) {
    q.run(db, `UPDATE stock_reservations SET status = 'FULFILLED', updated_at = ?
               WHERE tenant_id = ? AND order_id = ? AND product_id = ? AND status = 'ACTIVE'`,
      nowIso(), tenantId, orderId, item.product_id);
    q.run(db, `UPDATE inventory_items SET reserved = MAX(reserved - ?, 0), updated_at = ?
               WHERE tenant_id = ? AND product_id = ? AND warehouse_id = ?`,
      item.qty, nowIso(), tenantId, item.product_id, warehouseId);
    out.push(postMovement(db, {
      tenantId, productId: item.product_id, warehouseId, type: 'ISSUE', qty: item.qty,
      reason: 'Order fulfilment', refType: 'order', refId: orderId, actorId,
    }));
  }
  return out;
}

export function releaseReservations(db, { tenantId, orderId, actorId }) {
  const res = q.all(db, `SELECT * FROM stock_reservations WHERE tenant_id = ? AND order_id = ? AND status = 'ACTIVE'`, tenantId, orderId);
  for (const r of res) {
    q.run(db, `UPDATE stock_reservations SET status = 'RELEASED', updated_at = ? WHERE id = ?`, nowIso(), r.id);
    q.run(db, `UPDATE inventory_items SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE tenant_id = ? AND product_id = ? AND warehouse_id = ?`,
      r.qty, nowIso(), r.tenant_id, r.product_id, r.warehouse_id);
    q.run(db, `INSERT INTO inventory_movements
      (id, tenant_id, product_id, warehouse_id, type, qty_delta, on_hand_after, reason, ref_type, ref_id, actor_id, created_at)
      VALUES (?,?,?,?, 'RELEASE', 0, ?, ?, 'order', ?, ?, ?)`,
      id('mov'), r.tenant_id, r.product_id, r.warehouse_id,
      positionFor(db, r.tenant_id, r.product_id, r.warehouse_id).on_hand,
      `Reservation released (${r.qty})`, orderId, actorId, nowIso());
  }
  return res.length;
}

/** Low-stock signals after receiving/issuing — emits StockLow events. */
export function stockAlerts(db, tenantId, productId) {
  const p = q.one(db, `SELECT * FROM products WHERE id = ? AND tenant_id = ?`, productId, tenantId);
  if (!p) return;
  const totals = q.one(db, `SELECT COALESCE(SUM(on_hand),0) AS on_hand, COALESCE(SUM(reserved),0) AS reserved
                            FROM inventory_items WHERE tenant_id = ? AND product_id = ?`, tenantId, productId);
  const available = totals.on_hand - totals.reserved;
  if (p.reorder_point > 0 && available <= p.reorder_point) {
    const open = q.one(db, `SELECT id FROM notifications WHERE tenant_id = ? AND event_type = 'StockLow' AND ref_id = ? AND status != 'READ'`,
      tenantId, productId);
    if (!open) {
      sendNotification(db, {
        tenantId, channel: 'IN_APP', recipientKind: 'ROLE', recipientId: 'OWNER',
        body: `Low stock: ${p.name} — ${available} ${p.unit} available (reorder point ${p.reorder_point}).`,
        priority: available <= 0 ? 'CRITICAL' : 'HIGH', kind: 'OPERATIONAL',
        eventType: 'StockLow', refType: 'product', refId: productId,
        extra: { role_recipient: 'OWNER' },
      });
    }
  }
}
import { sendNotification } from '../adapters/messaging.js';

export function stockLevels(db, tenantId, { warehouseId = null, productId = null } = {}) {
  let sql = `SELECT i.*, p.name AS product_name, p.sku, p.unit, p.cost_price, p.price_retail, p.reorder_point,
              w.name AS warehouse_name
             FROM inventory_items i
             JOIN products p ON p.id = i.product_id
             JOIN warehouses w ON w.id = i.warehouse_id
             WHERE i.tenant_id = ?`;
  const params = [tenantId];
  if (warehouseId) { sql += ` AND i.warehouse_id = ?`; params.push(warehouseId); }
  if (productId) { sql += ` AND i.product_id = ?`; params.push(productId); }
  sql += ` ORDER BY p.name`;
  return q.all(db, sql, ...params);
}

/** Stock valuation & movement-based analytics. */
export function valuation(db, tenantId) {
  return q.one(db, `
    SELECT COALESCE(SUM(i.on_hand * p.cost_price), 0) AS cost_value,
           COALESCE(SUM(i.on_hand * p.price_retail), 0) AS retail_value,
           COUNT(DISTINCT i.product_id) AS products
    FROM inventory_items i JOIN products p ON p.id = i.product_id
    WHERE i.tenant_id = ? AND i.on_hand > 0`, tenantId);
}
