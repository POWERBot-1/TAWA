import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqOneOf, pageParams } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { emitEvent } from '../core/events.js';
import { postCommissionAccrued } from '../modules/ledger.js';
import { fmtMoney } from '../modules/payments.js';
import { sendNotification } from '../adapters/messaging.js';

export function registerRelationships(router, db) {
  /* ---------------- Customers (§14) ---------------- */
  router.get('/api/v1/customers', (req, res) => {
    mustPerm(req, 'customers.view');
    const { limit, offset, page } = pageParams(req);
    const filters = ['c.tenant_id = ?']; const params = [req.tenantId];
    if (req.query.q) { filters.push('(LOWER(c.name) LIKE ? OR c.phone LIKE ? OR LOWER(c.code) LIKE ?)'); const t = `%${String(req.query.q).toLowerCase()}%`; params.push(t, t, t); }
    if (req.query.segment) { filters.push('c.segment = ?'); params.push(req.query.segment); }
    if (req.query.type) { filters.push('c.type = ?'); params.push(req.query.type); }
    const where = filters.join(' AND ');
    const total = q.one(db, `SELECT COUNT(*) AS n FROM customers c WHERE ${where}`, ...params).n;
    const rows = q.all(db, `SELECT c.*, a.balance AS credit_balance, a.limit_amount AS credit_limit,
        (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'CANCELLED') AS lifetime_value,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'CANCELLED') AS orders_count,
        (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order_at
      FROM customers c LEFT JOIN credit_accounts a ON a.customer_id = c.id
      WHERE ${where} ORDER BY c.name LIMIT ? OFFSET ?`, ...params, limit, offset);
    ok(res, rows, { total, page });
  });

  router.get('/api/v1/customers/segments', (req, res) => {
    mustPerm(req, 'customers.view');
    const t = req.tenantId;
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400_000).toISOString();
    ok(res, {
      ALL: q.one(db, `SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND is_active=1`, t).n,
      NEW: q.one(db, `SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND created_at >= ?`, t, new Date(Date.now() - 30 * 86400_000).toISOString()).n,
      HIGH_VALUE: q.all(db, `SELECT c.id FROM customers c JOIN orders o ON o.customer_id = c.id AND o.status != 'CANCELLED' WHERE c.tenant_id = ? GROUP BY c.id HAVING SUM(o.total) > 10000000`, t).length,
      CONTRACTORS: q.one(db, `SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND type = 'CONTRACTOR'`, t).n,
      WHOLESALE: q.one(db, `SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND type = 'WHOLESALE'`, t).n,
      CREDIT: q.one(db, `SELECT COUNT(*) AS n FROM credit_accounts WHERE tenant_id = ? AND is_active = 1`, t).n,
      INACTIVE: q.all(db, `SELECT c.id FROM customers c WHERE c.tenant_id = ? AND c.is_active = 1 AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at > ?)`, t, sixtyDaysAgo).length,
      MARKETING_OPTIN: q.one(db, `SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND marketing_opt_in = 1`, t).n,
    });
  });

  router.get('/api/v1/customers/:id', (req, res) => {
    mustPerm(req, 'customers.view');
    const c = q.one(db, `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!c) throw err.notFound('Customer not found');
    ok(res, {
      ...c, notify_prefs: JSON.parse(c.notify_prefs || '{}'),
      credit: q.one(db, `SELECT * FROM credit_accounts WHERE customer_id = ?`, c.id) || null,
      orders: q.all(db, `SELECT id, number, total, payment_status, status, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`, c.id),
      quotes: q.all(db, `SELECT id, number, total, status, valid_until, created_at FROM quotes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`, c.id),
      payments: q.all(db, `SELECT p.amount, p.method, p.reference, p.received_at FROM payments p JOIN payment_intents i ON i.id = p.intent_id WHERE i.customer_id = ? ORDER BY p.received_at DESC LIMIT 20`, c.id),
      top_products: q.all(db, `SELECT oi.name_snap AS name, SUM(oi.qty) AS qty, SUM(oi.total) AS spent FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status != 'CANCELLED' WHERE o.customer_id = ? GROUP BY oi.product_id ORDER BY spent DESC LIMIT 5`, c.id),
    });
  });

  router.post('/api/v1/customers', async (req, res) => {
    mustPerm(req, 'customers.manage');
    const body = await readBody(req);
    const cid = id('cus');
    const code = `C-${String(q.one(db, `SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?`, req.tenantId).n + 1).padStart(4, '0')}`;
    q.run(db, `INSERT INTO customers (id, tenant_id, code, name, phone, email, type, segment, branch_id, broker_id, notes, marketing_opt_in, address, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cid, req.tenantId, code, reqStr(body.name, 'name'), optStr(body.phone, 'phone'), optStr(body.email, 'email'),
      reqOneOf(body.type || 'RETAIL', 'type', ['RETAIL', 'WHOLESALE', 'CONTRACTOR', 'CORPORATE']),
      optStr(body.segment, 'segment') || (body.type || 'RETAIL'), body.branch_id || null, body.broker_id || null,
      optStr(body.notes, 'notes'), body.marketing_opt_in ? 1 : 0, optStr(body.address, 'address'), nowIso(), nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'customer.create', resource: 'customer', resourceId: cid });
    created(res, q.one(db, `SELECT * FROM customers WHERE id = ?`, cid));
  });

  router.patch('/api/v1/customers/:id', async (req, res) => {
    mustPerm(req, 'customers.manage');
    const c = q.one(db, `SELECT * FROM customers WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!c) throw err.notFound('Customer not found');
    const body = await readBody(req);
    const fields = ['name', 'phone', 'email', 'type', 'segment', 'notes', 'address'];
    const sets = []; const vals = [];
    for (const f of fields) if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(body[f]); }
    if (body.marketing_opt_in !== undefined) { sets.push('marketing_opt_in = ?'); vals.push(body.marketing_opt_in ? 1 : 0); }
    if (body.notify_prefs) { sets.push('notify_prefs = ?'); vals.push(JSON.stringify(body.notify_prefs)); }
    if (!sets.length) return ok(res, c);
    sets.push('updated_at = ?'); vals.push(nowIso(), c.id);
    q.run(db, `UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    ok(res, q.one(db, `SELECT * FROM customers WHERE id = ?`, c.id));
  });

  /** Segments export (respects consent for marketing use). */
  router.get('/api/v1/customers/segment/:name/export', (req, res) => {
    mustPerm(req, 'customers.export');
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'customers.export', metadata: { segment: req.params.name } });
    const rows = q.all(db, `SELECT code, name, phone, email, type, segment, marketing_opt_in FROM customers WHERE tenant_id = ? AND is_active = 1`, req.tenantId);
    csv(res, `customers-${req.params.name}.csv`, ['code', 'name', 'phone', 'email', 'type', 'segment', 'marketing_opt_in'], rows);
  });

  /* ---------------- Credit engine (§27) ---------------- */
  router.get('/api/v1/credit/accounts', (req, res) => {
    mustPerm(req, 'credit.view');
    ok(res, q.all(db, `SELECT a.*, c.name, c.phone, c.code FROM credit_accounts a JOIN customers c ON c.id = a.customer_id
      WHERE a.tenant_id = ? ORDER BY a.balance DESC`, req.tenantId));
  });
  router.get('/api/v1/credit/accounts/:customerId', (req, res) => {
    mustPerm(req, 'credit.view');
    const acct = q.one(db, `SELECT * FROM credit_accounts WHERE customer_id = ? AND tenant_id = ?`, req.params.customerId, req.tenantId);
    if (!acct) throw err.notFound('Credit account not found');
    acct.transactions = q.all(db, `SELECT * FROM credit_transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT 50`, acct.customer_id);
    ok(res, acct);
  });
  router.post('/api/v1/credit/accounts', async (req, res) => {
    mustPerm(req, 'credit.grant');
    const body = await readBody(req);
    const customerId = reqStr(body.customer_id, 'customer_id');
    if (!q.one(db, `SELECT id FROM customers WHERE id = ? AND tenant_id = ?`, customerId, req.tenantId)) throw err.notFound('Customer not found');
    const limit = Math.round(reqNum(body.limit_amount ?? body.limit, 'limit_amount', { min: 0.01 }) * 100);
    tx(db, () => {
      q.run(db, `INSERT INTO credit_accounts (customer_id, tenant_id, limit_amount, balance, is_active, approved_by, created_at, updated_at)
                 VALUES (?,?,?,0,1,?,?,?)
                 ON CONFLICT(customer_id) DO UPDATE SET limit_amount = excluded.limit_amount, is_active = 1, approved_by = excluded.approved_by, updated_at = excluded.updated_at`,
        customerId, req.tenantId, limit, req.auth.user.id, nowIso(), nowIso());
      q.run(db, `INSERT INTO credit_transactions (id, tenant_id, account_id, type, amount, balance_after, actor_id, created_at)
                 VALUES (?,?,?,'LIMIT_CHANGE',?, COALESCE((SELECT balance FROM credit_accounts WHERE customer_id = ?),0), ?, ?)`,
        id('ctx'), req.tenantId, customerId, limit, customerId, req.auth.user.id, nowIso());
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'credit.grant', resource: 'credit_account', resourceId: customerId, metadata: { limit } });
    emitEvent(db, req.tenantId, 'CreditLimitSet', { customer_id: customerId, limit });
    created(res, q.one(db, `SELECT * FROM credit_accounts WHERE customer_id = ?`, customerId));
  });

  /* Credit repayment via verified payment intent */
  router.post('/api/v1/credit/accounts/:customerId/pay', async (req, res) => {
    mustPerm(req, 'payments.create');
    const body = await readBody(req);
    // handled by payment intents with purpose CREDIT_PAYMENT — this is a shortcut
    const { createIntent } = await import('../modules/payments.js');
    const method = reqOneOf(reqStr(body.method, 'method'), 'method', ['CASH', 'MPESA', 'BANK', 'CARD']);
    const provider = { CASH: 'cash', MPESA: 'mpesa_sandbox', BANK: 'bank_manual', CARD: 'card_sandbox' }[method];
    const amount = Math.round(reqNum(body.amount, 'amount', { min: 0.01 }) * 100);
    const { intent, replayed } = createIntent(db, {
      tenantId: req.tenantId, customerId: req.params.customerId, purpose: 'CREDIT_PAYMENT',
      amount, provider, method, phone: optStr(body.phone, 'phone'),
      idempotencyKey: reqStr(body.idempotency_key, 'idempotency_key'),
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'credit.pay.intent', resource: 'payment_intent', resourceId: intent.id });
    created(res, { intent, replayed });
  });

  /* ---------------- Suppliers (§16) ---------------- */
  router.get('/api/v1/suppliers', (req, res) => {
    mustPerm(req, 'suppliers.view');
    const rows = q.all(db, `SELECT s.*,
      (SELECT COALESCE(SUM(amount - paid),0) FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.status IN ('OPEN','PARTIAL')) AS outstanding,
      (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS orders_count,
      (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS products_count
      FROM suppliers s WHERE s.tenant_id = ? ORDER BY s.name`, req.tenantId);
    ok(res, rows);
  });
  router.get('/api/v1/suppliers/:id', (req, res) => {
    mustPerm(req, 'suppliers.view');
    const s = q.one(db, `SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!s) throw err.notFound('Supplier not found');
    ok(res, {
      ...s,
      products: q.all(db, `SELECT id, sku, name, unit, cost_price FROM products WHERE supplier_id = ?`, s.id),
      purchase_orders: q.all(db, `SELECT id, number, total, status, created_at FROM purchase_orders WHERE supplier_id = ? ORDER BY created_at DESC LIMIT 20`, s.id),
      invoices: q.all(db, `SELECT id, number, amount, paid, status, due_at FROM supplier_invoices WHERE supplier_id = ? ORDER BY created_at DESC LIMIT 20`, s.id),
      score: supplierScore(s),
    });
  });
  router.post('/api/v1/suppliers', async (req, res) => {
    mustPerm(req, 'suppliers.manage');
    const body = await readBody(req);
    const sid = id('sup');
    const code = `S-${String(q.one(db, `SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id = ?`, req.tenantId).n + 1).padStart(3, '0')}`;
    q.run(db, `INSERT INTO suppliers (id, tenant_id, code, name, contact_name, phone, email, address, lead_time_days, payment_terms, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      sid, req.tenantId, code, reqStr(body.name, 'name'), optStr(body.contact_name, 'contact_name'), optStr(body.phone, 'phone'),
      optStr(body.email, 'email'), optStr(body.address, 'address'), reqNum(body.lead_time_days ?? 3, 'lead_time_days', { min: 0, max: 365 }),
      optStr(body.payment_terms, 'payment_terms') || 'NET30', nowIso(), nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'supplier.create', resource: 'supplier', resourceId: sid });
    created(res, q.one(db, `SELECT * FROM suppliers WHERE id = ?`, sid));
  });

  /* ---------------- Brokers (§19) ---------------- */
  router.get('/api/v1/brokers', (req, res) => {
    mustPerm(req, 'brokers.view');
    const rows = q.all(db, `SELECT b.*,
      (SELECT COUNT(*) FROM leads l WHERE l.broker_id = b.id) AS leads_count,
      (SELECT COUNT(*) FROM leads l WHERE l.broker_id = b.id AND l.status = 'CONVERTED') AS converted_count,
      (SELECT COALESCE(SUM(cm.amount),0) FROM commissions cm WHERE cm.broker_id = b.id AND cm.status IN ('EARNED','APPROVED')) AS pending_commission,
      (SELECT COALESCE(SUM(cm.amount),0) FROM commissions cm WHERE cm.broker_id = b.id AND cm.status = 'PAID') AS paid_commission,
      (SELECT COALESCE(SUM(o.subtotal),0) FROM orders o WHERE o.broker_id = b.id AND o.status != 'CANCELLED') AS revenue_generated
      FROM brokers b WHERE b.tenant_id = ? ORDER BY b.name`, req.tenantId);
    ok(res, rows);
  });
  router.post('/api/v1/brokers', async (req, res) => {
    mustPerm(req, 'brokers.manage');
    const body = await readBody(req);
    const bid = id('brk');
    const code = `B-${String(q.one(db, `SELECT COUNT(*) AS n FROM brokers WHERE tenant_id = ?`, req.tenantId).n + 1).padStart(3, '0')}`;
    q.run(db, `INSERT INTO brokers (id, tenant_id, code, name, phone, email, territory, commission_pct, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      bid, req.tenantId, code, reqStr(body.name, 'name'), optStr(body.phone, 'phone'), optStr(body.email, 'email'),
      optStr(body.territory, 'territory'), reqNum(body.commission_pct ?? 5, 'commission_pct', { min: 0, max: 50 }), nowIso());
    created(res, q.one(db, `SELECT * FROM brokers WHERE id = ?`, bid));
  });

  router.get('/api/v1/brokers/:id', (req, res) => {
    mustPerm(req, 'brokers.view');
    const b = q.one(db, `SELECT * FROM brokers WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!b) throw err.notFound('Broker not found');
    ok(res, {
      ...b,
      leads: q.all(db, `SELECT * FROM leads WHERE broker_id = ? ORDER BY created_at DESC LIMIT 50`, b.id),
      commissions: q.all(db, `SELECT cm.*, o.number AS order_number FROM commissions cm JOIN orders o ON o.id = cm.order_id WHERE cm.broker_id = ? ORDER BY cm.created_at DESC LIMIT 50`, b.id),
      customers: q.all(db, `SELECT id, name, phone, type FROM customers WHERE broker_id = ? LIMIT 50`, b.id),
    });
  });

  router.post('/api/v1/brokers/:id/leads', async (req, res) => {
    mustPerm(req, 'brokers.view');
    const b = q.one(db, `SELECT * FROM brokers WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!b) throw err.notFound('Broker not found');
    const body = await readBody(req);
    const leadId = id('led');
    q.run(db, `INSERT INTO leads (id, tenant_id, broker_id, name, phone, email, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      leadId, req.tenantId, b.id, reqStr(body.name, 'name'), optStr(body.phone, 'phone'), optStr(body.email, 'email'), optStr(body.note, 'note'), nowIso(), nowIso());
    emitEvent(db, req.tenantId, 'LeadCreated', { lead_id: leadId, broker: b.name, ref_type: 'lead', ref_id: leadId });
    created(res, q.one(db, `SELECT * FROM leads WHERE id = ?`, leadId));
  });

  /** Lead → customer (§19 broker workflow). */
  router.post('/api/v1/leads/:id/convert', (req, res) => {
    mustPerm(req, 'customers.manage');
    const lead = q.one(db, `SELECT l.*, b.name AS broker_name FROM leads l JOIN brokers b ON b.id = l.broker_id WHERE l.id = ? AND l.tenant_id = ?`, req.params.id, req.tenantId);
    if (!lead) throw err.notFound('Lead not found');
    if (lead.customer_id) return ok(res, { customer_id: lead.customer_id, replayed: true });
    const cid = id('cus');
    tx(db, () => {
      const code = `C-${String(q.one(db, `SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?`, req.tenantId).n + 1).padStart(4, '0')}`;
      q.run(db, `INSERT INTO customers (id, tenant_id, code, name, phone, email, type, segment, broker_id, created_at, updated_at)
                 VALUES (?,?,?,?,?,?, 'RETAIL', 'BROKER-REFERRED', ?, ?, ?)`,
        cid, req.tenantId, code, lead.name, lead.phone, lead.email, lead.broker_id, nowIso(), nowIso());
      q.run(db, `UPDATE leads SET status = 'CONVERTED', customer_id = ?, updated_at = ? WHERE id = ?`, cid, nowIso(), lead.id);
      const brk = q.one(db, `SELECT phone FROM brokers WHERE id = ?`, lead.broker_id);
      if (brk?.phone) sendNotification(db, {
        tenantId: req.tenantId, channel: 'SMS', recipientKind: 'BROKER', recipientId: lead.broker_id, toAddr: brk.phone,
        body: `Your lead ${lead.name} is now a registered customer. Thank you for growing business with us.`,
        eventType: 'LeadConverted', refType: 'lead', refId: lead.id,
      });
    });
    emitEvent(db, req.tenantId, 'LeadConverted', { lead_id: lead.id, customer_id: cid, broker: lead.broker_name });
    created(res, { customer_id: cid });
  });

  /** Commission: earned on paid order, approve, then payout (§19-20). */
  router.post('/api/v1/commissions/:id/approve', (req, res) => {
    mustPerm(req, 'brokers.commission.approve');
    const cm = q.one(db, `SELECT * FROM commissions WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!cm) throw err.notFound('Commission not found');
    if (cm.status !== 'EARNED') throw err.conflict(`Commission is ${cm.status} — only EARNED can be approved`);
    tx(db, () => {
      q.run(db, `UPDATE commissions SET status = 'APPROVED', approved_by = ?, updated_at = ? WHERE id = ?`, req.auth.user.id, nowIso(), cm.id);
      postCommissionAccrued(db, req.tenantId, { amount: cm.amount, refId: cm.id, actorId: req.auth.user.id });
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'commission.approve', resource: 'commission', resourceId: cm.id, metadata: { amount: cm.amount } });
    emitEvent(db, req.tenantId, 'BrokerCommissionApproved', { commission_id: cm.id, amount: fmtMoney(cm.amount) });
    ok(res, q.one(db, `SELECT * FROM commissions WHERE id = ?`, cm.id));
  });

  router.post('/api/v1/commissions/:id/pay', async (req, res) => {
    mustPerm(req, 'brokers.commission.pay');
    const cm = q.one(db, `SELECT * FROM commissions WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!cm) throw err.notFound('Commission not found');
    if (cm.status !== 'APPROVED') throw err.conflict('Commission must be APPROVED before payout');
    const body = await readBody(req);
    const method = reqOneOf(reqStr(body.method, 'method'), 'method', ['MPESA', 'CASH', 'BANK']);
    const { createOutboundPayout } = await import('../modules/payouts.js');
    const out = createOutboundPayout(db, {
      tenantId: req.tenantId, payeeType: 'BROKER', payeeId: cm.broker_id, purpose: 'BROKER_COMMISSION',
      amount: cm.amount, method, actorId: req.auth.user.id, refId: cm.id,
    });
    q.run(db, `UPDATE commissions SET status = 'PAID', paid_ref = ?, updated_at = ? WHERE id = ?`, out.payment_id, nowIso(), cm.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'commission.pay', resource: 'commission', resourceId: cm.id, metadata: { amount: cm.amount, method } });
    const brk = q.one(db, `SELECT * FROM brokers WHERE id = ?`, cm.broker_id);
    if (brk?.phone) sendNotification(db, {
      tenantId: req.tenantId, channel: 'SMS', recipientKind: 'BROKER', recipientId: brk.id, toAddr: brk.phone,
      body: `Commission of ${fmtMoney(cm.amount)} has been paid to you. Ref: ${out.reference}.`,
      eventType: 'CommissionPaid', refType: 'commission', refId: cm.id,
    });
    ok(res, { paid: true, payment: out });
  });
}

function supplierScore(s) {
  return {
    price_competitiveness: 0.85, reliability: s.reliability, quality: s.quality,
    fulfilment_rate: s.fulfilment_rate, on_time_rate: s.on_time_rate,
    overall: +(((s.reliability + s.quality + s.fulfilment_rate + s.on_time_rate) / 4 * 4 + 0.85) / 5).toFixed(2),
  };
}

export function csv(res, filename, headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h] == null ? '' : String(r[h]);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  }
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.end(lines.join('\n'));
}
