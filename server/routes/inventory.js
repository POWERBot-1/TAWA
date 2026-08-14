import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqOneOf, pageParams } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { postMovement, stockLevels, valuation, positionFor } from '../modules/inventory.js';
import { emitEvent } from '../core/events.js';
import { enforcePlanLimit, meter } from '../core/entitlements.js';

export function registerInventory(router, db) {
  router.get('/api/v1/branches', (req, res) => {
    ok(res, q.all(db, `SELECT b.*, (SELECT COUNT(*) FROM warehouses w WHERE w.branch_id = b.id AND w.is_active=1) AS warehouses
                       FROM branches b WHERE b.tenant_id = ? ORDER BY b.code`, req.tenantId));
  });
  router.post('/api/v1/branches', async (req, res) => {
    enforcePlanLimit(db, req.tenantId, 'branches');
    mustPerm(req, 'branches.manage');
    const body = await readBody(req);
    const bid = id('br');
    q.run(db, `INSERT INTO branches (id, tenant_id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?,?)`,
      bid, req.tenantId, reqStr(body.code, 'code').toUpperCase(), reqStr(body.name, 'name'), optStr(body.address, 'address'), optStr(body.phone, 'phone'), nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'branch.create', resource: 'branch', resourceId: bid });
    created(res, q.one(db, `SELECT * FROM branches WHERE id = ?`, bid));
  });

  router.get('/api/v1/warehouses', (req, res) => {
    ok(res, q.all(db, `SELECT w.*, b.name AS branch_name, (SELECT COUNT(DISTINCT product_id) FROM inventory_items i WHERE i.warehouse_id = w.id AND i.on_hand > 0) AS stocked_products
                       FROM warehouses w LEFT JOIN branches b ON b.id = w.branch_id WHERE w.tenant_id = ? ORDER BY w.code`, req.tenantId));
  });
  router.post('/api/v1/warehouses', async (req, res) => {
    mustPerm(req, 'branches.manage');
    const body = await readBody(req);
    const wid = id('wh');
    q.run(db, `INSERT INTO warehouses (id, tenant_id, branch_id, code, name, address, created_at) VALUES (?,?,?,?,?,?,?)`,
      wid, req.tenantId, optStr(body.branch_id, 'branch_id'), reqStr(body.code, 'code').toUpperCase(), reqStr(body.name, 'name'), optStr(body.address, 'address'), nowIso());
    created(res, q.one(db, `SELECT * FROM warehouses WHERE id = ?`, wid));
  });

  router.get('/api/v1/inventory/levels', (req, res) => {
    mustPerm(req, 'inventory.view');
    ok(res, stockLevels(db, req.tenantId, { warehouseId: req.query.warehouse_id || null }));
  });
  router.get('/api/v1/inventory/valuation', (req, res) => {
    mustPerm(req, 'inventory.view');
    ok(res, valuation(db, req.tenantId));
  });
  router.get('/api/v1/inventory/movements', (req, res) => {
    mustPerm(req, 'inventory.view');
    if (req.query.comm === '1') {
      mustPerm(req, 'alerts.view');
      const filters = ['m.tenant_id = ?']; const params = [req.tenantId];
      if (req.query.product_id) { filters.push('m.product_id = ?'); params.push(req.query.product_id); }
      if (req.query.warehouse_id) { filters.push('m.warehouse_id = ?'); params.push(req.query.warehouse_id); }
      if (req.query.type) { filters.push('m.type = ?'); params.push(req.query.type); }
      return ok(res, { movements: q.all(db, `SELECT m.*, p.name AS product_name, p.sku, w.name AS warehouse_name
        FROM inventory_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
        WHERE ${filters.join(' AND ')} ORDER BY m.created_at DESC LIMIT 300`, ...params) });
    }
    const { limit, offset, page } = pageParams(req);
    const rows = q.all(db, `SELECT m.*, p.name AS product_name, p.sku, w.name AS warehouse_name, u.name AS actor_name
      FROM inventory_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
      LEFT JOIN users u ON u.id = m.actor_id
      WHERE m.tenant_id = ? ${req.query.product_id ? 'AND m.product_id = ?' : ''}
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      ...(req.query.product_id ? [req.tenantId, req.query.product_id] : [req.tenantId]), limit, offset);
    ok(res, rows, { page });
  });

  /** Stock receiving (GRN or manual). */
  router.post('/api/v1/inventory/receive', async (req, res) => {
    mustPerm(req, 'inventory.receive');
    const body = await readBody(req);
    const warehouseId = reqStr(body.warehouse_id, 'warehouse_id');
    requireWarehouse(db, req.tenantId, warehouseId);
    const items = normalizeItems(body.items);
    const result = tx(db, () => {
      const out = [];
      for (const it of items) {
        requireProduct(db, req.tenantId, it.product_id);
        out.push(postMovement(db, {
          tenantId: req.tenantId, productId: it.product_id, warehouseId, type: 'RECEIVE', qty: it.qty,
          reason: optStr(body.reason, 'reason') || 'Stock receiving', refType: body.ref_type || null, refId: body.ref_id || null,
          actorId: req.auth.user.id,
        }));
      }
      return out;
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'inventory.receive', resource: 'warehouse', resourceId: warehouseId, metadata: { lines: items.length } });
    created(res, { movements: result });
    emitEvent(db, req.tenantId, 'StockReceived', { warehouse_id: warehouseId, lines: items.length });
  });

  /** Adjustment / count / damage — permission + reason + audit. */
  router.post('/api/v1/inventory/adjust', async (req, res) => {
    mustPerm(req, 'inventory.adjust');
    const body = await readBody(req);
    const warehouseId = reqStr(body.warehouse_id, 'warehouse_id');
    requireWarehouse(db, req.tenantId, warehouseId);
    const type = reqOneOf(body.type || 'ADJUST', 'type', ['ADJUST', 'COUNT', 'DAMAGE', 'RETURN']);
    const allowNegative = body.allow_negative === true && reqOneOf(type, 'type', ['ADJUST']) === 'ADJUST'; // explicit permit, only adjustments
    const items = normalizeItems(body.items, type);
    const result = tx(db, () => items.map(it => {
      requireProduct(db, req.tenantId, it.product_id);
      const delta = type === 'COUNT'
        ? it.qty - positionFor(db, req.tenantId, it.product_id, warehouseId).on_hand
        : type === 'DAMAGE' ? -Math.abs(it.qty)
        : type === 'RETURN' ? Math.abs(it.qty)
        : it.qty; // ADJUST: signed delta as submitted
      return postMovement(db, {
        tenantId: req.tenantId, productId: it.product_id, warehouseId, type,
        qty: Math.abs(delta), qtyDelta: delta,
        reason: reqStr(body.reason || `${type} adjustment`, 'reason'), actorId: req.auth.user.id,
        refType: 'adjustment', allowNegative,
      });
    }));
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'inventory.adjust', resource: 'warehouse', resourceId: warehouseId, metadata: { type, lines: items.length, allow_negative: allowNegative } });
    created(res, { movements: result });
  });

  /** Warehouse transfer — paired movements, atomic. */
  router.post('/api/v1/inventory/transfer', async (req, res) => {
    mustPerm(req, 'inventory.transfer');
    const body = await readBody(req);
    const from = reqStr(body.from_warehouse_id, 'from_warehouse_id');
    const to = reqStr(body.to_warehouse_id, 'to_warehouse_id');
    if (from === to) throw err.unprocessable('Source and destination warehouses must differ');
    requireWarehouse(db, req.tenantId, from); requireWarehouse(db, req.tenantId, to);
    const items = normalizeItems(body.items);
    const transferId = id('trf');
    const result = tx(db, () => {
      const out = [];
      for (const it of items) {
        requireProduct(db, req.tenantId, it.product_id);
        out.push(postMovement(db, { tenantId: req.tenantId, productId: it.product_id, warehouseId: from, type: 'TRANSFER_OUT', qty: it.qty, reason: `Transfer to warehouse`, refType: 'transfer', refId: transferId, actorId: req.auth.user.id }));
        out.push(postMovement(db, { tenantId: req.tenantId, productId: it.product_id, warehouseId: to, type: 'TRANSFER_IN', qty: it.qty, reason: `Transfer received`, refType: 'transfer', refId: transferId, actorId: req.auth.user.id }));
      }
      return out;
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'inventory.transfer', resource: 'transfer', resourceId: transferId, metadata: { from, to, lines: items.length } });
    created(res, { transfer_id: transferId, movements: result });
  });
}

function requireWarehouse(db, tenantId, wid) {
  if (!q.one(db, `SELECT id FROM warehouses WHERE id = ? AND tenant_id = ? AND is_active = 1`, wid, tenantId)) throw err.notFound('Warehouse not found');
}
function requireProduct(db, tenantId, pid) {
  if (!q.one(db, `SELECT id FROM products WHERE id = ? AND tenant_id = ?`, pid, tenantId)) throw err.notFound('Product not found');
}
function normalizeItems(items, type = 'RECEIVE') {
  if (!Array.isArray(items) || !items.length) throw err.unprocessable('items[] required');
  return items.map(it => {
    const qty = reqNum(it.qty, 'qty', { min: type === 'ADJUST' ? -1e9 : 0.0001 });
    return { product_id: reqStr(it.product_id, 'product_id'), qty, signed: it.qty < 0 };
  });
}
