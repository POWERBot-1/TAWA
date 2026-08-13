import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqArr } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { emitEvent } from '../core/events.js';
import { docNo, postSupplierInvoice, postSupplierPayment } from '../modules/ledger.js';
import { postMovement } from '../modules/inventory.js';
import { createOutboundPayout } from '../modules/payouts.js';
import { poDoc } from '../modules/documents.js';
import { fmtMoney } from '../modules/payments.js';
import { sendNotification } from '../adapters/messaging.js';

export function registerProcurement(router, db) {
  /* ---------------- Requisitions ---------------- */
  router.get('/api/v1/procurement/requisitions', (req, res) => {
    mustPerm(req, 'procurement.view');
    const rows = q.all(db, `SELECT r.*, u.name AS requested_by_name FROM purchase_requisitions r LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.tenant_id = ? ${req.query.status ? 'AND r.status = ?' : ''} ORDER BY r.created_at DESC LIMIT 100`,
      ...(req.query.status ? [req.tenantId, req.query.status] : [req.tenantId]));
    for (const r of rows) r.items = q.all(db, `SELECT i.*, p.name, p.sku, p.unit FROM purchase_requisition_items i JOIN products p ON p.id = i.product_id WHERE i.requisition_id = ?`, r.id);
    ok(res, rows);
  });
  router.post('/api/v1/procurement/requisitions', async (req, res) => {
    mustPerm(req, 'procurement.create');
    const body = await readBody(req);
    const items = reqArr(body.items, 'items');
    const rid = id('prq');
    tx(db, () => {
      q.run(db, `INSERT INTO purchase_requisitions (id, tenant_id, number, status, reason, source, requested_by, created_at, updated_at)
                 VALUES (?,?,?, 'PENDING_APPROVAL', ?, 'MANUAL', ?, ?, ?)`,
        rid, req.tenantId, `PR-${docNo(db, req.tenantId, 'requisition')}`, optStr(body.reason, 'reason'), req.auth.user.id, nowIso(), nowIso());
      for (const it of items) {
        if (!q.one(db, `SELECT id FROM products WHERE id = ? AND tenant_id = ?`, it.product_id, req.tenantId)) throw err.notFound('Product not found');
        q.run(db, `INSERT INTO purchase_requisition_items (id, requisition_id, product_id, qty, est_cost) VALUES (?,?,?,?,?)`,
          id('pri'), rid, it.product_id, reqNum(it.qty, 'qty', { min: 0.0001 }), Math.round(Number(it.est_cost || 0)));
      }
    });
    created(res, q.one(db, `SELECT * FROM purchase_requisitions WHERE id = ?`, rid));
  });
  router.post('/api/v1/procurement/requisitions/:id/approve', (req, res) => {
    mustPerm(req, 'procurement.approve');
    const r = q.one(db, `SELECT * FROM purchase_requisitions WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!r) throw err.notFound('Requisition not found');
    if (!['PENDING_APPROVAL', 'DRAFT'].includes(r.status)) throw err.conflict(`Cannot approve requisition in state ${r.status}`);
    q.run(db, `UPDATE purchase_requisitions SET status = 'APPROVED', approved_by = ?, updated_at = ? WHERE id = ?`, req.auth.user.id, nowIso(), r.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'requisition.approve', resource: 'requisition', resourceId: r.id });
    ok(res, q.one(db, `SELECT * FROM purchase_requisitions WHERE id = ?`, r.id));
  });
  router.post('/api/v1/procurement/requisitions/:id/reject', async (req, res) => {
    mustPerm(req, 'procurement.approve');
    const r = q.one(db, `SELECT * FROM purchase_requisitions WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!r) throw err.notFound('Requisition not found');
    q.run(db, `UPDATE purchase_requisitions SET status = 'REJECTED', updated_at = ? WHERE id = ?`, nowIso(), r.id);
    ok(res, q.one(db, `SELECT * FROM purchase_requisitions WHERE id = ?`, r.id));
  });

  /* ---------------- Purchase orders (§18) ---------------- */
  router.get('/api/v1/procurement/pos', (req, res) => {
    mustPerm(req, 'procurement.view');
    ok(res, q.all(db, `SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN warehouses w ON w.id = po.warehouse_id
      WHERE po.tenant_id = ? ORDER BY po.created_at DESC LIMIT 100`, req.tenantId));
  });
  router.get('/api/v1/procurement/pos/:id', (req, res) => {
    mustPerm(req, 'procurement.view');
    const po = q.one(db, `SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ? AND po.tenant_id = ?`, req.params.id, req.tenantId);
    if (!po) throw err.notFound('PO not found');
    po.items = q.all(db, `SELECT i.*, p.name, p.sku FROM po_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.po_id = ?`, po.id);
    ok(res, po);
  });

  /** Create PO directly or from an approved requisition. Human-initiated only. */
  router.post('/api/v1/procurement/pos', async (req, res) => {
    mustPerm(req, 'procurement.create');
    const body = await readBody(req);
    const supplierId = reqStr(body.supplier_id, 'supplier_id');
    if (!q.one(db, `SELECT id FROM suppliers WHERE id = ? AND tenant_id = ? AND is_active = 1`, supplierId, req.tenantId)) throw err.notFound('Supplier not found');
    let items;
    if (body.requisition_id) {
      const r = q.one(db, `SELECT * FROM purchase_requisitions WHERE id = ? AND tenant_id = ?`, body.requisition_id, req.tenantId);
      if (!r) throw err.notFound('Requisition not found');
      if (r.status !== 'APPROVED') throw err.conflict('Requisition must be approved before conversion to PO');
      const rItems = q.all(db, `SELECT * FROM purchase_requisition_items WHERE requisition_id = ?`, r.id);
      items = rItems.map(it => {
        const p = q.one(db, `SELECT cost_price, name FROM products WHERE id = ?`, it.product_id);
        return { product_id: it.product_id, name_snap: p.name, qty: it.qty, unit_cost: it.est_cost || p.cost_price };
      });
    } else {
      items = reqArr(body.items, 'items').map(it => {
        const p = q.one(db, `SELECT cost_price, name FROM products WHERE id = ? AND tenant_id = ?`, it.product_id, req.tenantId);
        if (!p) throw err.notFound('Product not found');
        return { product_id: it.product_id, name_snap: p.name, qty: reqNum(it.qty, 'qty', { min: 0.0001 }), unit_cost: it.unit_cost != null ? Math.round(Number(it.unit_cost) * 100) : p.cost_price };
      });
    }
    const poId = id('po');
    tx(db, () => {
      let subtotal = 0, tax = 0;
      for (const it of items) { const base = Math.round(it.qty * it.unit_cost); subtotal += base; tax += Math.round(base * 0.16); }
      q.run(db, `INSERT INTO purchase_orders (id, tenant_id, number, requisition_id, supplier_id, warehouse_id, status, subtotal, tax, total, expected_at, created_by, created_at, updated_at)
                 VALUES (?,?,?,?,?,?, 'PENDING_APPROVAL', ?,?,?,?,?,?,?)`,
        poId, req.tenantId, `PO-${docNo(db, req.tenantId, 'po')}`, body.requisition_id || null, supplierId, body.warehouse_id || null,
        subtotal, tax, subtotal + tax, body.expected_at || null, req.auth.user.id, nowIso(), nowIso());
      for (const it of items) {
        q.run(db, `INSERT INTO po_items (id, po_id, product_id, name_snap, qty, unit_cost, total) VALUES (?,?,?,?,?,?,?)`,
          id('poi'), poId, it.product_id, it.name_snap, it.qty, it.unit_cost, Math.round(it.qty * it.unit_cost));
      }
      if (body.requisition_id) q.run(db, `UPDATE purchase_requisitions SET status = 'CONVERTED', updated_at = ? WHERE id = ?`, nowIso(), body.requisition_id);
    });
    emitEvent(db, req.tenantId, 'PurchaseOrderCreated', { po_id: poId, ref_type: 'po', ref_id: poId }, req.auth.user.id);
    created(res, q.one(db, `SELECT * FROM purchase_orders WHERE id = ?`, poId));
  });

  router.post('/api/v1/procurement/pos/:id/approve', (req, res) => {
    mustPerm(req, 'procurement.approve');
    const po = mustPo(db, req.tenantId, req.params.id);
    if (!['PENDING_APPROVAL', 'DRAFT'].includes(po.status)) throw err.conflict(`PO is ${po.status}`);
    q.run(db, `UPDATE purchase_orders SET status = 'APPROVED', approved_by = ?, updated_at = ? WHERE id = ?`, req.auth.user.id, nowIso(), po.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'po.approve', resource: 'po', resourceId: po.id, metadata: { total: po.total } });
    emitEvent(db, req.tenantId, 'PurchaseOrderApproved', { po_id: po.id, number: po.number, total: fmtMoney(po.total) });
    ok(res, q.one(db, `SELECT * FROM purchase_orders WHERE id = ?`, po.id));
  });

  /** Send to supplier — notification, not money. */
  router.post('/api/v1/procurement/pos/:id/send', (req, res) => {
    mustPerm(req, 'procurement.approve');
    const po = mustPo(db, req.tenantId, req.params.id);
    if (po.status !== 'APPROVED') throw err.conflict('PO must be approved before sending');
    q.run(db, `UPDATE purchase_orders SET status = 'SENT', sent_at = ?, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), po.id);
    const supplier = q.one(db, `SELECT * FROM suppliers WHERE id = ?`, po.supplier_id);
    if (supplier?.phone) {
      sendNotification(db, { tenantId: req.tenantId, channel: 'SMS', recipientKind: 'SUPPLIER', recipientId: supplier.id, toAddr: supplier.phone,
        body: `Purchase order ${po.number} for ${fmtMoney(po.total)} has been issued. Expected delivery: ${po.expected_at ? new Date(po.expected_at).toLocaleDateString('en-KE') : 'as agreed'}.`,
        eventType: 'PurchaseOrderSent', refType: 'po', refId: po.id });
    }
    ok(res, q.one(db, `SELECT * FROM purchase_orders WHERE id = ?`, po.id));
  });

  /** Goods received note — real stock-in movements (§18). */
  router.post('/api/v1/procurement/pos/:id/receive', async (req, res) => {
    mustPerm(req, 'procurement.receive');
    const po = mustPo(db, req.tenantId, req.params.id);
    if (!['SENT', 'PARTIALLY_RECEIVED', 'APPROVED'].includes(po.status)) throw err.conflict(`PO is ${po.status} — cannot receive goods`);
    const body = await readBody(req);
    const items = reqArr(body.items, 'items');
    const warehouseId = body.warehouse_id || po.warehouse_id || q.one(db, `SELECT id FROM warehouses WHERE tenant_id = ? AND is_active = 1 ORDER BY code LIMIT 1`, req.tenantId)?.id;
    if (!warehouseId) throw err.conflict('No warehouse available to receive into');
    const grnId = id('grn');
    tx(db, () => {
      q.run(db, `INSERT INTO goods_receipts (id, tenant_id, number, po_id, warehouse_id, received_by, note, created_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
        grnId, req.tenantId, `GRN-${docNo(db, req.tenantId, 'grn')}`, po.id, warehouseId, req.auth.user.id, optStr(body.note, 'note'), nowIso());
      for (const it of items) {
        const poItem = q.one(db, `SELECT * FROM po_items WHERE po_id = ? AND product_id = ?`, po.id, it.product_id);
        if (!poItem) throw err.unprocessable(`Product ${it.product_id} is not on this PO`);
        const qty = reqNum(it.qty, 'qty', { min: 0.0001 });
        if (poItem.received_qty + qty > poItem.qty) throw err.conflict(`Over-receipt for ${poItem.name_snap || it.product_id}: ordered ${poItem.qty}, already received ${poItem.received_qty}`);
        q.run(db, `INSERT INTO grn_items (id, grn_id, product_id, qty) VALUES (?,?,?,?)`, id('grni'), grnId, it.product_id, qty);
        postMovement(db, { tenantId: req.tenantId, productId: it.product_id, warehouseId, type: 'RECEIVE', qty, reason: `GRN for ${po.number}`, refType: 'grn', refId: grnId, actorId: req.auth.user.id });
        q.run(db, `UPDATE po_items SET received_qty = received_qty + ? WHERE id = ?`, qty, poItem.id);
      }
      const remaining = q.one(db, `SELECT COALESCE(SUM(qty - received_qty),0) AS r FROM po_items WHERE po_id = ?`, po.id).r;
      q.run(db, `UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?`, remaining <= 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED', nowIso(), po.id);
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'procurement.receive', resource: 'grn', resourceId: grnId });
    emitEvent(db, req.tenantId, 'GoodsReceived', { po_id: po.id, grn_id: grnId, lines: items.length }, req.auth.user.id);
    created(res, q.one(db, `SELECT * FROM goods_receipts WHERE id = ?`, grnId));
  });

  router.get('/api/v1/procurement/pos/:id/document', (req, res) => {
    mustPerm(req, 'procurement.view');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(poDoc(db, req.tenantId, req.params.id));
  });

  /* ---------------- Supplier invoices & payments ---------------- */
  router.get('/api/v1/procurement/invoices', (req, res) => {
    mustPerm(req, 'procurement.view');
    ok(res, q.all(db, `SELECT si.*, s.name AS supplier_name FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.tenant_id = ? ORDER BY si.created_at DESC LIMIT 100`, req.tenantId));
  });
  router.post('/api/v1/procurement/invoices', async (req, res) => {
    mustPerm(req, 'procurement.create');
    const body = await readBody(req);
    const supplierId = reqStr(body.supplier_id, 'supplier_id');
    if (!q.one(db, `SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?`, supplierId, req.tenantId)) throw err.notFound('Supplier not found');
    const amount = Math.round(reqNum(body.amount, 'amount', { min: 0.01 }) * 100);
    const iid = id('sin');
    tx(db, () => {
      q.run(db, `INSERT INTO supplier_invoices (id, tenant_id, number, po_id, supplier_id, amount, due_at, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
        iid, req.tenantId, `SI-${docNo(db, req.tenantId, 'sinvoice')}`, body.po_id || null, supplierId, amount, body.due_at || null, nowIso(), nowIso());
      postSupplierInvoice(db, req.tenantId, { amount, refId: iid, actorId: req.auth.user.id });
    });
    emitEvent(db, req.tenantId, 'SupplierInvoiceCreated', { invoice_id: iid, amount: fmtMoney(amount) }, req.auth.user.id);
    created(res, q.one(db, `SELECT * FROM supplier_invoices WHERE id = ?`, iid));
  });

  /** Pay a supplier invoice via outbound payout (§18, §26-auth). */
  router.post('/api/v1/procurement/invoices/:id/pay', async (req, res) => {
    mustPerm(req, 'payments.payout');
    const inv = q.one(db, `SELECT * FROM supplier_invoices WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!inv) throw err.notFound('Supplier invoice not found');
    if (inv.status === 'PAID') return ok(res, { invoice: inv, replayed: true });
    const body = await readBody(req);
    const amount = body.amount ? Math.round(reqNum(body.amount, 'amount', { min: 0.01 }) * 100) : (inv.amount - inv.paid);
    if (amount > inv.amount - inv.paid) throw err.conflict('Payment exceeds outstanding invoice amount');
    const method = body.method || 'MPESA';
    const out = tx(db, () => {
      const result = createOutboundPayout(db, { tenantId: req.tenantId, payeeType: 'SUPPLIER', payeeId: inv.supplier_id, purpose: 'SUPPLIER_PAYMENT', amount, method, actorId: req.auth.user.id, refId: inv.id });
      const paid = inv.paid + amount;
      q.run(db, `UPDATE supplier_invoices SET paid = ?, status = ?, updated_at = ? WHERE id = ?`,
        paid, paid >= inv.amount ? 'PAID' : 'PARTIAL', nowIso(), inv.id);
      return result;
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'supplier_invoice.pay', resource: 'supplier_invoice', resourceId: inv.id, metadata: { amount, method } });
    emitEvent(db, req.tenantId, 'SupplierPaymentCompleted', { invoice_id: inv.id, amount: fmtMoney(amount) });
    ok(res, { payment: out });
  });
  void postSupplierPayment;
}

function mustPo(db, tenantId, idOrParam) {
  const po = q.one(db, `SELECT * FROM purchase_orders WHERE id = ? AND tenant_id = ?`, idOrParam, tenantId);
  if (!po) throw err.notFound('Purchase order not found');
  return po;
}
