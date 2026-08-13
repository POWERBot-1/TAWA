import crypto from 'node:crypto';
import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqOneOf, pageParams } from '../core/http.js';
import { mustPerm, hasPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { emitEvent } from '../core/events.js';
import { sendNotification } from '../adapters/messaging.js';

/**
 * Delivery & logistics (§21, ext §38-46).
 * ORDER → PICK → PACK → ASSIGN → DISPATCH → IN_TRANSIT → DELIVERED → POD.
 * OTP proof for eligible deliveries (ext §45).
 */
const FLOW = {
  PENDING: ['PICKING', 'CANCELLED'],
  PICKING: ['PACKED'],
  PACKED: ['READY'],
  READY: ['ASSIGNED'],
  ASSIGNED: ['DISPATCHED'],
  DISPATCHED: ['IN_TRANSIT', 'ARRIVED'],
  IN_TRANSIT: ['ARRIVED', 'DELIVERED', 'FAILED'],
  ARRIVED: ['DELIVERED', 'FAILED'],
  DELIVERED: ['RETURNED'],
  FAILED: ['READY', 'RETURNED'],
};

function businessName(db, tenantId) {
  return q.one(db, `SELECT business_name FROM tenant_branding WHERE tenant_id = ?`, tenantId)?.business_name || 'TAWA';
}
function smsCustomer(db, tenantId, orderId, body, eventType, deliveryId) {
  const order = q.one(db, `SELECT o.*, c.phone, c.id AS cid, c.notify_prefs FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ? AND o.tenant_id = ?`, orderId, tenantId);
  if (!order?.phone) return;
  const prefs = JSON.parse(order.notify_prefs || '{}');
  if ((eventType === 'OrderDispatched' && prefs.dispatch === false) || (eventType === 'DeliveryCompleted' && prefs.delivery === false)) return;
  sendNotification(db, { tenantId, channel: 'SMS', recipientKind: 'CUSTOMER', recipientId: order.cid, toAddr: order.phone, body, eventType, refType: 'delivery', refId: deliveryId });
}

export function registerLogistics(router, db) {
  router.get('/api/v1/deliveries', (req, res) => {
    mustPerm(req, 'deliveries.view');
    const { limit, offset, page } = pageParams(req);
    const filters = ['d.tenant_id = ?']; const params = [req.tenantId];
    if (req.query.status) { filters.push('d.status = ?'); params.push(req.query.status); }
    // Drivers only see their assignments unless they manage deliveries
    if (hasPerm(req, 'deliveries.drive') && !hasPerm(req, 'deliveries.manage')) {
      const w = req.auth.user.linked_worker_id;
      if (w) { filters.push('d.driver_id = ?'); params.push(w); }
    }
    const rows = q.all(db, `SELECT d.*, o.number AS order_number, o.total AS order_total, o.payment_status,
        c.name AS customer_name, c.phone AS customer_phone, w.name AS driver_name
      FROM deliveries d JOIN orders o ON o.id = d.order_id LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN workers w ON w.id = d.driver_id
      WHERE ${filters.join(' AND ')} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = q.one(db, `SELECT COUNT(*) AS n FROM deliveries d WHERE ${filters.join(' AND ')}`, ...params).n;
    ok(res, rows, { total, page });
  });

  router.post('/api/v1/deliveries', async (req, res) => {
    mustPerm(req, 'deliveries.manage');
    const body = await readBody(req);
    const order = q.one(db, `SELECT * FROM orders WHERE id = ? AND tenant_id = ?`, reqStr(body.order_id, 'order_id'), req.tenantId);
    if (!order) throw err.notFound('Order not found');
    if (order.status === 'CANCELLED') throw err.conflict('Cannot deliver a cancelled order');
    if (q.one(db, `SELECT d.id FROM deliveries d WHERE d.order_id = ? AND d.status NOT IN ('RETURNED','FAILED')`, order.id)) {
      throw err.conflict('An active delivery already exists for this order');
    }
    const did = id('dlv');
    const otp = String(crypto.randomInt(1000, 9999));
    q.run(db, `INSERT INTO deliveries (id, tenant_id, order_id, fee, address, instructions, otp_code, proof_type, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
      did, req.tenantId, order.id, Math.round(Number(body.fee || 0) * 100),
      optStr(body.address, 'address') || order.address, optStr(body.instructions, 'instructions'),
      otp, body.proof_type || 'OTP', nowIso(), nowIso());
    emitEvent(db, req.tenantId, 'DeliveryCreated', { delivery_id: did, order: order.number }, req.auth.user.id);
    created(res, q.one(db, `SELECT id, status, proof_type FROM deliveries WHERE id = ?`, did));
  });

  router.post('/api/v1/deliveries/:id/assign', async (req, res) => {
    mustPerm(req, 'deliveries.manage');
    const d = mustDelivery(db, req.tenantId, req.params.id);
    const body = await readBody(req);
    const to = d.status === 'READY' || d.status === 'PACKED' || d.status === 'PENDING' ? 'ASSIGNED' : 'ASSIGNED';
    if (!(FLOW[d.status] || []).concat(['ASSIGNED']).includes('ASSIGNED') && d.status !== 'READY') {
      if (!['READY', 'PACKED', 'PICKING', 'PENDING'].includes(d.status)) throw err.conflict(`Delivery is ${d.status}; cannot assign`);
    }
    void to;
    const driver = q.one(db, `SELECT * FROM workers WHERE id = ? AND tenant_id = ?`, reqStr(body.driver_id, 'driver_id'), req.tenantId);
    if (!driver) throw err.notFound('Driver not found');
    if ((FLOW[d.status] || []).length === 0) throw err.conflict(`Delivery is ${d.status}`);
    q.run(db, `UPDATE deliveries SET status = 'ASSIGNED', driver_id = ?, vehicle = ?, route = ?, assigned_at = ?, updated_at = ? WHERE id = ?`,
      driver.id, optStr(body.vehicle, 'vehicle'), optStr(body.route, 'route'), nowIso(), nowIso(), d.id);
    if (driver.phone) sendNotification(db, {
      tenantId: req.tenantId, channel: 'SMS', recipientKind: 'WORKER', recipientId: driver.id, toAddr: driver.phone,
      body: `Delivery ${d.id.slice(-8).toUpperCase()} assigned to you. Address: ${d.address || 'on order'}.`,
      eventType: 'DeliveryAssigned', refType: 'delivery', refId: d.id,
    });
    ok(res, { id: d.id, status: 'ASSIGNED', driver: driver.name });
  });

  router.post('/api/v1/deliveries/:id/advance', async (req, res) => {
    mustPerm(req, 'deliveries.view');
    const d = mustDelivery(db, req.tenantId, req.params.id);
    const body = await readBody(req);
    const to = reqOneOf(reqStr(body.to, 'to'), 'to', ['PICKING', 'PACKED', 'READY', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED', 'FAILED', 'RETURNED']);
    if (!(FLOW[d.status] || []).includes(to)) throw err.conflict(`Delivery cannot move from ${d.status} to ${to}`);
    if (['DISPATCHED', 'IN_TRANSIT', 'ARRIVED'].includes(to) && !hasPerm(req, 'deliveries.drive') && !hasPerm(req, 'deliveries.manage')) {
      throw err.forbidden('Driver or manager permission required');
    }
    const order = q.one(db, `SELECT * FROM orders WHERE id = ?`, d.order_id);
    tx(db, () => {
      q.run(db, `UPDATE deliveries SET status = ?, dispatched_at = CASE WHEN ? = 'DISPATCHED' THEN ? ELSE dispatched_at END, updated_at = ? WHERE id = ?`,
        to, to, nowIso(), nowIso(), d.id);
      if (to === 'DISPATCHED') {
        q.run(db, `UPDATE orders SET status = 'DELIVERING', updated_at = ? WHERE id = ? AND status NOT IN ('DELIVERED','COMPLETED','CANCELLED')`, nowIso(), d.order_id);
      }
      if (['RETURNED', 'FAILED'].includes(to)) {
        q.run(db, `UPDATE orders SET status = 'CONFIRMED', updated_at = ? WHERE id = ? AND status IN ('DELIVERING')`, nowIso(), d.order_id);
      }
      void order;
    });
    if (to === 'DISPATCHED') {
      smsCustomer(db, req.tenantId, d.order_id, `${businessName(db, req.tenantId)}: Your order has been dispatched and is on its way. Delivery ref: ${d.id.slice(-8).toUpperCase()}.`, 'OrderDispatched', d.id);
      emitEvent(db, req.tenantId, 'OrderDispatched', { delivery_id: d.id, order_id: d.order_id }, req.auth.user.id);
    } else {
      emitEvent(db, req.tenantId, `Delivery${to.charAt(0) + to.slice(1).toLowerCase()}`, { delivery_id: d.id, status: to }, req.auth.user.id);
    }
    ok(res, { id: d.id, status: to });
  });

  /** Proof-of-delivery completion (ext §44-45). */
  router.post('/api/v1/deliveries/:id/complete', async (req, res) => {
    mustPerm(req, 'deliveries.drive');
    if (!hasPerm(req, 'deliveries.drive') && !hasPerm(req, 'deliveries.manage')) throw err.forbidden('Driver permission required');
    const d = mustDelivery(db, req.tenantId, req.params.id);
    if (!['IN_TRANSIT', 'ARRIVED', 'DISPATCHED'].includes(d.status)) throw err.conflict(`Delivery is ${d.status} — must be on the way`);
    const body = await readBody(req);
    if (d.proof_type === 'OTP') {
      if (!body.otp || String(body.otp) !== d.otp_code) throw err.conflict('Invalid delivery code — customer must provide their OTP');
    }
    tx(db, () => {
      q.run(db, `UPDATE deliveries SET status = 'DELIVERED', delivered_at = ?, proof_ref = ?, updated_at = ? WHERE id = ?`,
        nowIso(), optStr(body.proof_ref, 'proof_ref') || (d.proof_type === 'OTP' ? `OTP-VERIFIED-${crypto.randomBytes(4).toString('hex')}` : null), nowIso(), d.id);
      q.run(db, `UPDATE orders SET status = 'DELIVERED', updated_at = ? WHERE id = ? AND status IN ('DELIVERING','CONFIRMED','PARTIALLY_FULFILLED')`, nowIso(), d.order_id);
    });
    smsCustomer(db, req.tenantId, d.order_id, `${businessName(db, req.tenantId)}: Your order has been delivered successfully. Thank you for shopping with us.`, 'DeliveryCompleted', d.id);
    emitEvent(db, req.tenantId, 'DeliveryCompleted', { delivery_id: d.id, order_id: d.order_id }, req.auth.user.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'delivery.complete', resource: 'delivery', resourceId: d.id, metadata: { proof: d.proof_type } });
    ok(res, { id: d.id, status: 'DELIVERED', delivered_at: nowIso() });
  });

  /** Customer-facing delivery OTP issuance (sent via SMS on dispatch readiness). */
  router.post('/api/v1/deliveries/:id/send-otp', (req, res) => {
    mustPerm(req, 'deliveries.manage');
    const d = mustDelivery(db, req.tenantId, req.params.id);
    if (d.proof_type !== 'OTP') throw err.unprocessable('This delivery does not use OTP verification');
    smsCustomer(db, req.tenantId, d.order_id, `${businessName(db, req.tenantId)}: Your delivery verification code is ${d.otp_code}. Give it to the driver on arrival.`, 'DeliveryOtp', d.id);
    ok(res, { sent: true });
  });
}

function mustDelivery(db, tenantId, did) {
  const d = q.one(db, `SELECT * FROM deliveries WHERE id = ? AND tenant_id = ?`, did, tenantId);
  if (!d) throw err.notFound('Delivery not found');
  return d;
}
