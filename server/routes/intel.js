import { q, nowIso } from '../db/connection.js';
import { ok, readBody, err } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { generateInsights, copilot, reorderAnalysis, deadStock, productVelocity, salesAnomaly } from '../modules/ai.js';
import { audit } from '../core/audit.js';
import { csv } from './relationships.js';
import { profitAndLoss } from '../modules/ledger.js';

function rangeStart(req) {
  const r = req.query.range || 'today';
  const now = new Date();
  const iso = (d) => d.toISOString();
  switch (r) {
    case 'today': return new Date(now).toISOString().slice(0, 10);
    case 'yesterday': { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
    case '7d': return iso(new Date(Date.now() - 7 * 86400_000));
    case '30d': return iso(new Date(Date.now() - 30 * 86400_000));
    case '90d': return iso(new Date(Date.now() - 90 * 86400_000));
    case 'ytd': return `${now.getFullYear()}-01-01`;
    case 'custom': return req.query.from || iso(new Date(Date.now() - 30 * 86400_000));
    default: return new Date(now).toISOString().slice(0, 10);
  }
}

export function registerIntel(router, db) {
  /* ---------------- Executive dashboard (§6, §65) ---------------- */
  router.get('/api/v1/dashboard', (req, res) => {
    mustPerm(req, 'analytics.view');
    const t = req.tenantId;
    const from = rangeStart(req);
    const sales = q.one(db, `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS total, COALESCE(SUM(discount),0) AS discounts
      FROM orders WHERE tenant_id = ? AND status != 'CANCELLED' AND created_at >= ?`, t, from);
    const collected = q.one(db, `SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN payment_intents i ON i.id = p.intent_id
      WHERE p.tenant_id = ? AND p.direction = 'INBOUND' AND p.status != 'REVERSED' AND p.received_at >= ?`, t, from).s;
    const cogs = q.one(db, `SELECT COALESCE(SUM(oi.cost_price * oi.qty),0) AS c FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.tenant_id = ? AND o.status != 'CANCELLED' AND o.created_at >= ?`, t, from).c;
    const cashPos = q.all(db, `SELECT a.code, COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0) AS balance
      FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
      WHERE a.tenant_id = ? AND a.code IN ('1000','1010','1020') GROUP BY a.code`, t);
    const credit = q.one(db, `SELECT COALESCE(SUM(balance),0) AS outstanding, COALESCE(SUM(limit_amount),0) AS limits FROM credit_accounts WHERE tenant_id = ? AND is_active = 1`, t);
    const ap = q.one(db, `SELECT COALESCE(SUM(amount - paid),0) AS due FROM supplier_invoices WHERE tenant_id = ? AND status IN ('OPEN','PARTIAL')`, t);
    const payrollDue = q.one(db, `SELECT COALESCE(SUM(total_net),0) AS due FROM payroll_runs WHERE tenant_id = ? AND status IN ('CALCULATED','REVIEWED','APPROVED')`, t);
    const inv = q.one(db, `SELECT COALESCE(SUM(i.on_hand * p.cost_price),0) AS cost_value, COALESCE(SUM(i.on_hand * p.price_retail),0) AS retail_value
      FROM inventory_items i JOIN products p ON p.id = i.product_id WHERE i.tenant_id = ? AND i.on_hand > 0`, t);
    const lowStock = q.all(db, `SELECT p.id, p.name, p.reorder_point,
        COALESCE(SUM(i.on_hand),0) - COALESCE(SUM(i.reserved),0) AS available
      FROM products p JOIN inventory_items i ON i.product_id = p.id
      WHERE p.tenant_id = ? AND p.reorder_point > 0 AND p.is_active = 1
      GROUP BY p.id HAVING available <= p.reorder_point ORDER BY available`, t);
    const deadRows = deadStock(db, t);
    const pendingQuotes = q.one(db, `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE tenant_id = ? AND status IN ('DRAFT','REVIEW','SENT','VIEWED')`, t);
    const pendingOrders = q.one(db, `SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND status IN ('CONFIRMED','PARTIALLY_FULFILLED')`, t);
    const pendingDeliveries = q.one(db, `SELECT COUNT(*) AS n FROM deliveries WHERE tenant_id = ? AND status IN ('PENDING','PICKING','PACKED','READY','ASSIGNED','DISPATCHED','IN_TRANSIT')`, t);
    const overdueInvoices = q.one(db, `SELECT COUNT(*) AS n, COALESCE(SUM(amount - paid),0) AS amt FROM supplier_invoices
      WHERE tenant_id = ? AND status IN ('OPEN','PARTIAL') AND due_at < ?`, t, nowIso());
    const overdueOrders = q.one(db, `SELECT COUNT(*) AS n, COALESCE(SUM(total - amount_paid),0) AS amt FROM orders
      WHERE tenant_id = ? AND is_credit = 1 AND payment_status != 'PAID' AND created_at < ?`, t, new Date(Date.now() - 14 * 86400_000).toISOString());
    const topProducts = q.all(db, `SELECT p.id, p.name, p.sku, SUM(oi.qty) AS units, SUM(oi.total) AS revenue,
        SUM((oi.unit_price - oi.cost_price) * oi.qty) AS margin
      FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status != 'CANCELLED' AND o.created_at >= ?
      JOIN products p ON p.id = oi.product_id WHERE o.tenant_id = ?
      GROUP BY p.id ORDER BY revenue DESC LIMIT 5`, t, from);
    const topCustomers = q.all(db, `SELECT c.id, c.name, COUNT(o.id) AS orders, SUM(o.total) AS spent
      FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.tenant_id = ? AND o.status != 'CANCELLED' AND o.created_at >= ?
      GROUP BY c.id ORDER BY spent DESC LIMIT 5`, t, from);
    const branchPerf = q.all(db, `SELECT b.id, b.name, COUNT(o.id) AS orders, COALESCE(SUM(o.total),0) AS revenue
      FROM branches b LEFT JOIN orders o ON o.branch_id = b.id AND o.tenant_id = ? AND o.status != 'CANCELLED' AND o.created_at >= ?
      WHERE b.tenant_id = ? AND b.is_active = 1 GROUP BY b.id ORDER BY revenue DESC`, t, from, t);
    const trend = q.all(db, `SELECT substr(created_at, 1, 10) AS day, SUM(total) AS total, COUNT(*) AS orders
      FROM orders WHERE tenant_id = ? AND status != 'CANCELLED' AND created_at >= ?
      GROUP BY day ORDER BY day`, t, from.length === 10 ? from + 'T00:00' : from);
    const marginTrendBase = q.all(db, `SELECT substr(o.created_at,1,10) AS day, SUM(oi.total) AS revenue, SUM((oi.unit_price - oi.cost_price)*oi.qty) AS margin
      FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status != 'CANCELLED' AND o.created_at >= ?
      WHERE o.tenant_id = ? GROUP BY day ORDER BY day`, from.length === 10 ? from + 'T00:00' : from, t);
    ok(res, {
      range: { from, to: nowIso() },
      sales: {
        orders: sales.orders, total: sales.total, discounts: sales.discounts,
        aov: sales.orders ? Math.round(sales.total / sales.orders) : 0,
        gross_profit: Math.max((sales.total - 0) - cogs, 0),
        collected,
      },
      positions: {
        cash: Object.fromEntries(cashPos.map(c => [c.code, c.balance])),
        credit_outstanding: credit.outstanding, credit_limits: credit.limits,
        supplier_liabilities: ap.due, payroll_liability: payrollDue.due,
        inventory_cost_value: inv.cost_value, inventory_retail_value: inv.retail_value,
      },
      attention: {
        low_stock: lowStock.length, dead_stock: deadRows.length,
        dead_stock_value: deadRows.reduce((s, d) => s + d.tied_up_value, 0),
        pending_quotes: pendingQuotes.n, pending_quotes_value: pendingQuotes.value,
        pending_orders: pendingOrders.n, pending_deliveries: pendingDeliveries.n,
        overdue_supplier_invoices: overdueInvoices, overdue_credit_orders: overdueOrders,
      },
      top_products: topProducts, top_customers: topCustomers,
      branch_performance: branchPerf,
      best_branch: branchPerf[0] || null, worst_branch: branchPerf[branchPerf.length - 1] || null,
      sales_trend: trend, margin_trend: marginTrendBase,
      low_stock_items: lowStock.slice(0, 8),
    });
  });

  /* ---------------- AI (§31-32) ---------------- */
  router.get('/api/v1/ai/insights', (req, res) => {
    mustPerm(req, 'ai.view');
    const fresh = JSON.parse(req.query.regenerate || '0') ? generateInsights(db, req.tenantId) : [];
    const stored = q.all(db, `SELECT * FROM ai_insights WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 25`, req.tenantId);
    ok(res, { stored, fresh });
  });
  router.post('/api/v1/ai/ask', async (req, res) => {
    mustPerm(req, 'ai.use');
    const body = await readBody(req);
    if (!body.question || typeof body.question !== 'string') throw new Error('question required');
    const result = copilot(db, req.tenantId, req.auth.user.id, body.question);
    if (result.action_class === 'PREPARE') {
      audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'ai.prepare', metadata: { question: body.question.slice(0, 200), created: result.data } });
    }
    ok(res, result);
  });
  router.get('/api/v1/ai/reorder', (req, res) => {
    mustPerm(req, 'ai.view');
    ok(res, reorderAnalysis(db, req.tenantId));
  });
  router.get('/api/v1/ai/log', (req, res) => {
    mustPerm(req, 'ai.view');
    ok(res, q.all(db, `SELECT * FROM ai_action_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`, req.tenantId));
  });

  /* ---------------- Analytics (§31) ---------------- */
  router.get('/api/v1/analytics/overview', (req, res) => {
    mustPerm(req, 'analytics.view');
    const t = req.tenantId;
    const velocities = productVelocity(db, t, 30);
    ok(res, {
      product_velocity: velocities.filter(v => v.units > 0).sort((a, b) => b.units - a.units).slice(0, 20),
      slow_movers: velocities.filter(v => v.units === 0).length,
      sales_anomaly: salesAnomaly(db, t),
      pnl_30d: profitAndLoss(db, t, { from: new Date(Date.now() - 30 * 86400_000).toISOString() }),
      payments_by_method: q.all(db, `SELECT method, COUNT(*) AS count, SUM(amount) AS total FROM payments WHERE tenant_id = ? AND direction = 'INBOUND' GROUP BY method`, t),
      quotes_funnel: q.all(db, `SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM quotes WHERE tenant_id = ? GROUP BY status`, t),
      order_sources: q.all(db, `SELECT source, COUNT(*) AS n, SUM(total) AS value FROM orders WHERE tenant_id = ? AND status != 'CANCELLED' GROUP BY source`, t),
    });
  });

  /* ---------------- Reports (§35) ---------------- */
  router.get('/api/v1/reports/:name', (req, res) => {
    mustPerm(req, 'reports.view');
    const t = req.tenantId;
    const from = req.query.from || new Date(Date.now() - 30 * 86400_000).toISOString();
    const to = req.query.to || nowIso();
    const name = req.params.name;
    let rows = null, title = name;
    if (name === 'sales') {
      rows = q.all(db, `SELECT o.number, o.created_at, c.name AS customer, o.subtotal, o.tax, o.total, o.amount_paid, o.payment_status, o.status, o.source
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.tenant_id = ? AND o.created_at BETWEEN ? AND ? ORDER BY o.created_at DESC`, t, from, to)
        .map(moneyRow(['subtotal', 'tax', 'total', 'amount_paid']));
    } else if (name === 'stock-ageing') {
      rows = q.all(db, `SELECT p.sku, p.name, p.unit, w.name AS warehouse, i.on_hand, i.on_hand * p.cost_price AS value,
        (SELECT MAX(m.created_at) FROM inventory_movements m WHERE m.product_id = p.id AND m.type = 'RECEIVE') AS last_received
        FROM inventory_items i JOIN products p ON p.id = i.product_id JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.tenant_id = ? AND i.on_hand > 0 ORDER BY value DESC`, t).map(r => ({ ...r, value: (r.value / 100).toFixed(2) }));
    } else if (name === 'profit') {
      rows = q.all(db, `SELECT p.sku, p.name, SUM(oi.qty) AS units, SUM(oi.total)/100.0 AS revenue, SUM(oi.cost_price*oi.qty)/100.0 AS cost,
        SUM((oi.unit_price-oi.cost_price)*oi.qty)/100.0 AS margin
        FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status != 'CANCELLED' AND o.created_at BETWEEN ? AND ?
        JOIN products p ON p.id = oi.product_id WHERE o.tenant_id = ? GROUP BY p.id ORDER BY margin DESC`, t, from, to);
    } else if (name === 'customers') {
      rows = q.all(db, `SELECT c.code, c.name, c.type, c.segment, COUNT(o.id) AS orders, SUM(o.total)/100.0 AS spent
        FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'CANCELLED' WHERE c.tenant_id = ? GROUP BY c.id ORDER BY spent DESC`, t);
    } else if (name === 'suppliers') {
      rows = q.all(db, `SELECT s.code, s.name, s.lead_time_days, s.payment_terms, s.reliability, s.on_time_rate,
        (SELECT COALESCE(SUM(amount - paid),0)/100.0 FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.status != 'PAID') AS outstanding
        FROM suppliers s WHERE s.tenant_id = ?`, t);
    } else if (name === 'tax') {
      rows = q.all(db, `SELECT substr(o.created_at,1,7) AS period, SUM(o.total - o.tax)/100.0 AS net, SUM(o.tax)/100.0 AS vat, SUM(o.total)/100.0 AS gross
        FROM orders o WHERE o.tenant_id = ? AND o.status != 'CANCELLED' AND o.created_at BETWEEN ? AND ? GROUP BY period ORDER BY period`, t, from, to);
    } else if (name === 'payroll') {
      rows = q.all(db, `SELECT r.number, r.period_start, r.period_end, r.status, w.name AS worker, i.gross/100.0 AS gross, i.net/100.0 AS net, i.status AS pay_status
        FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id JOIN workers w ON w.id = i.worker_id WHERE r.tenant_id = ? ORDER BY r.created_at DESC`, t);
    } else if (name === 'brokers') {
      rows = q.all(db, `SELECT b.code, b.name, b.territory, b.commission_pct,
        (SELECT COUNT(*) FROM leads l WHERE l.broker_id = b.id) AS leads,
        (SELECT COALESCE(SUM(cm.amount),0)/100.0 FROM commissions cm WHERE cm.broker_id = b.id AND cm.status='PAID') AS paid,
        (SELECT COALESCE(SUM(o.subtotal),0)/100.0 FROM orders o WHERE o.broker_id = b.id AND o.status != 'CANCELLED') AS revenue_generated
        FROM brokers b WHERE b.tenant_id = ?`, t);
    }
    if (!rows) throw err.notFound('Unknown report');
    if (req.query.format === 'csv') {
      audit(db, { tenantId: t, actorId: req.auth.user.id, action: 'reports.export', metadata: { report: name } });
      if (!rows.length) rows = [{ note: 'no data for selected range' }];
      return csv(res, `${title}-${from.slice(0, 10)}.csv`, Object.keys(rows[0]), rows);
    }
    ok(res, { report: title, from, to, rows });
  });

  /* ---------------- Universal search (§36) ---------------- */
  router.get('/api/v1/search', (req, res) => {
    const term = String(req.query.q || '').toLowerCase().trim();
    if (!term || term.length < 2) return ok(res, { results: [] });
    const t = req.tenantId;
    const like = `%${term}%`;
    const out = [];
    const push = (kind, idv, title, sub) => out.push({ kind, id: idv, title, sub });
    for (const r of q.all(db, `SELECT id, name, sku, price_retail FROM products WHERE tenant_id = ? AND (LOWER(name) LIKE ? OR LOWER(sku) LIKE ? OR barcode = ?) LIMIT 6`, t, like, like, term)) push('product', r.id, r.name, `${r.sku} · ${(r.price_retail / 100).toFixed(2)}`);
    for (const r of q.all(db, `SELECT id, name, phone, code FROM customers WHERE tenant_id = ? AND (LOWER(name) LIKE ? OR phone LIKE ?) LIMIT 6`, t, like, like)) push('customer', r.id, r.name, `${r.code} · ${r.phone || ''}`);
    for (const r of q.all(db, `SELECT id, name, code FROM suppliers WHERE tenant_id = ? AND LOWER(name) LIKE ? LIMIT 4`, t, like)) push('supplier', r.id, r.name, r.code);
    for (const r of q.all(db, `SELECT id, number, total, status FROM orders WHERE tenant_id = ? AND number LIKE ? LIMIT 6`, t, `%${term.toUpperCase()}%`)) push('order', r.id, r.number, `${r.status} · ${(r.total / 100).toFixed(2)}`);
    for (const r of q.all(db, `SELECT id, number, total, status FROM quotes WHERE tenant_id = ? AND number LIKE ? LIMIT 4`, t, `%${term.toUpperCase()}%`)) push('quote', r.id, r.number, r.status);
    for (const r of q.all(db, `SELECT id, name, code FROM workers WHERE tenant_id = ? AND LOWER(name) LIKE ? LIMIT 4`, t, like)) push('worker', r.id, r.name, r.code);
    for (const r of q.all(db, `SELECT id, name, code FROM brokers WHERE tenant_id = ? AND LOWER(name) LIKE ? LIMIT 4`, t, like)) push('broker', r.id, r.name, r.code);
    ok(res, { results: out.slice(0, 20) });
  });
}
function moneyRow(keys) {
  return r => {
    const out = { ...r };
    for (const k of keys) out[k] = (Number(out[k] || 0) / 100).toFixed(2);
    return out;
  };
}
