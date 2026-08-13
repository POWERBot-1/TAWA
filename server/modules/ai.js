import { q, id, nowIso } from '../db/connection.js';
import { fmtMoney } from './payments.js';

/**
 * TAWA Intelligence (§31-32, spec §10).
 * Deterministic, explainable AI: every insight shows WHAT / WHY / DATA /
 * CONFIDENCE / RECOMMENDED ACTION. LLM integration binds through the
 * JataQiAdapter seam; this engine IS the deterministic safety core that
 * keeps business logic correct even when LLM services are unavailable (§42).
 *
 * AI action classes: READ | ANALYSE | RECOMMEND | PREPARE | EXECUTE.
 * This engine never EXECUTEs. PREPARE creates drafts requiring human approval.
 */

const DAY = 86400_000;
function since(days) { return new Date(Date.now() - days * DAY).toISOString(); }

/** Units sold per product in the window (sold = items on non-cancelled orders). */
export function productVelocity(db, tenantId, days = 30) {
  return q.all(db, `
    SELECT p.id, p.name, p.sku, p.unit, p.reorder_point, p.max_stock, p.cost_price, p.price_retail, p.supplier_id,
           COALESCE(SUM(oi.qty), 0) AS units, COALESCE(SUM(oi.total),0) AS revenue,
           COALESCE(SUM((oi.unit_price - oi.cost_price) * oi.qty),0) AS margin
    FROM products p
    LEFT JOIN order_items oi ON oi.product_id = p.id
    LEFT JOIN orders o ON o.id = oi.order_id AND o.tenant_id = ? AND o.status != 'CANCELLED' AND o.created_at >= ?
    WHERE p.tenant_id = ? AND p.is_active = 1
    GROUP BY p.id`, tenantId, since(days), tenantId)
    .map(r => ({ ...r, velocity: r.units / days }));
}

export function stockMap(db, tenantId) {
  const rows = q.all(db, `SELECT product_id, SUM(on_hand) AS on_hand, SUM(reserved) AS reserved, SUM(damaged) AS damaged
                          FROM inventory_items WHERE tenant_id = ? GROUP BY product_id`, tenantId);
  return new Map(rows.map(r => [r.product_id, r]));
}

/** Reorder analysis (§10): ROP, safety stock, lead-time aware suggestions. */
export function reorderAnalysis(db, tenantId, { days = 30 } = {}) {
  const velocities = productVelocity(db, tenantId, days);
  const stocks = stockMap(db, tenantId);
  const out = [];
  for (const v of velocities) {
    const s = stocks.get(v.id) || { on_hand: 0, reserved: 0 };
    const available = (s.on_hand || 0) - (s.reserved || 0);
    const supplier = v.supplier_id ? q.one(db, `SELECT lead_time_days, name FROM suppliers WHERE id = ? AND tenant_id = ?`, v.supplier_id, tenantId) : null;
    const leadDays = supplier?.lead_time_days ?? 3;
    const safetyStock = +(v.velocity * 3).toFixed(2);                    // 3 days of cover
    const rop = +(v.velocity * leadDays + safetyStock).toFixed(2);       // demand during lead + safety
    const effectiveRop = Math.max(rop, v.reorder_point || 0);            // honor configured floor too
    const daysOfStock = v.velocity > 0 ? +(available / v.velocity).toFixed(1) : (available > 0 ? 999 : 0);
    const needsReorder = (available <= effectiveRop && available >= 0) || (v.velocity > 0 && daysOfStock <= leadDays + 3);
    const target = v.max_stock > 0 ? v.max_stock : Math.max(effectiveRop * 2, 10);
    const suggestedQty = needsReorder ? Math.max(Math.ceil(target - available), 0) : 0;
    const urgency = available <= 0 || (v.velocity > 0 && daysOfStock <= leadDays) ? 'CRITICAL'
      : available <= effectiveRop || daysOfStock <= leadDays + 3 ? 'HIGH'
      : daysOfStock <= leadDays + 7 ? 'MEDIUM' : 'LOW';
    out.push({
      product_id: v.id, name: v.name, sku: v.sku, unit: v.unit, available,
      velocity: +v.velocity.toFixed(3), lead_days: leadDays, supplier: supplier?.name || null,
      reorder_point: rop, safety_stock: safetyStock, days_of_stock: daysOfStock,
      suggested_qty: suggestedQty, est_cost: Math.round(suggestedQty * v.cost_price),
      urgency,
    });
  }
  return out.filter(r => r.suggested_qty > 0).sort((a, b) => (a.days_of_stock - b.days_of_stock));
}

export function deadStock(db, tenantId, { idleDays = 60 } = {}) {
  const rows = q.all(db, `
    SELECT p.id, p.name, p.sku, p.unit, p.cost_price, p.price_retail,
           COALESCE(SUM(i.on_hand),0) AS on_hand,
           MAX(o.created_at) AS last_sold
    FROM products p
    JOIN inventory_items i ON i.product_id = p.id AND i.on_hand > 0
    LEFT JOIN order_items oi ON oi.product_id = p.id
    LEFT JOIN orders o ON o.id = oi.order_id AND o.tenant_id = ? AND o.status != 'CANCELLED'
    WHERE p.tenant_id = ? AND p.is_active = 1
    GROUP BY p.id
    HAVING last_sold IS NULL OR last_sold < ?`, tenantId, tenantId, since(idleDays));
  return rows.map(r => ({
    ...r, idle_days: r.last_sold ? Math.floor((Date.now() - new Date(r.last_sold)) / DAY) : null,
    tied_up_value: Math.round(r.on_hand * r.cost_price),
  })).sort((a, b) => b.tied_up_value - a.tied_up_value);
}

/** Sales anomaly: today's sales vs rolling average. */
export function salesAnomaly(db, tenantId) {
  const days = q.all(db, `
    SELECT substr(created_at, 1, 10) AS day, SUM(total) AS total, COUNT(*) AS orders
    FROM orders WHERE tenant_id = ? AND status != 'CANCELLED' AND created_at >= ?
    GROUP BY day ORDER BY day`, tenantId, since(15));
  if (days.length < 4) return null;
  const today = new Date().toISOString().slice(0, 10);
  const hist = days.filter(d => d.day !== today).map(d => d.total);
  const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length) || 1;
  const todayTotal = days.find(d => d.day === today)?.total || 0;
  const z = (todayTotal - mean) / sd;
  return { today_total: todayTotal, mean: Math.round(mean), sd: Math.round(sd), z: +z.toFixed(2), direction: z > 1.5 ? 'SPIKE' : z < -1.5 ? 'DIP' : 'NORMAL' };
}

/** Explainable insight objects + persisted copies. */
export function generateInsights(db, tenantId) {
  const insights = [];
  const mk = (kind, title, body, data, confidence, action, severity = 'INFO') => ({
    id: id('aii'), tenant_id: tenantId, kind, title, body, severity,
    data: JSON.stringify(data), confidence, action, status: 'FRESH', created_at: nowIso(),
  });
  const reorders = reorderAnalysis(db, tenantId);
  const critical = reorders.filter(r => r.urgency === 'CRITICAL' || r.urgency === 'HIGH');
  if (critical.length) {
    insights.push(mk('REORDER', `${critical.length} product(s) need reordering now`,
      `${critical.slice(0, 3).map(r => `${r.name} (${r.days_of_stock} days of stock at current velocity; supplier lead ${r.lead_days}d)`).join('; ')}.`,
      { items: critical }, 0.86, 'Prepare purchase requisition', 'HIGH'));
  }
  const dead = deadStock(db, tenantId);
  if (dead.length) {
    const tied = dead.reduce((s, d) => s + d.tied_up_value, 0);
    insights.push(mk('DEAD_STOCK', `${fmtMoney(tied)} tied up in slow stock`,
      `${dead.length} product(s) show no sales in 60+ days. Top offender: ${dead[0].name} (${fmtMoney(dead[0].tied_up_value)} on hand).`,
      { items: dead.slice(0, 10) }, 0.78, 'Review for clearance promotion or return to supplier', 'NORMAL'));
  }
  const anomaly = salesAnomaly(db, tenantId);
  if (anomaly && anomaly.direction !== 'NORMAL') {
    insights.push(mk('TREND', anomaly.direction === 'DIP' ? 'Sales dipping below trend' : 'Sales spiking above trend',
      `Today's sales ${fmtMoney(anomaly.today_total)} vs 2-week daily mean ${fmtMoney(anomaly.mean)} (z=${anomaly.z}).`,
      anomaly, 0.66, anomaly.direction === 'DIP' ? 'Inspect top-declining products & consider a targeted promotion' : 'Check stock cover for surging products', anomaly.direction === 'DIP' ? 'HIGH' : 'INFO'));
  }
  const overdue = q.one(db, `SELECT COUNT(*) AS n, COALESCE(SUM(amount - paid),0) AS amt FROM supplier_invoices
                             WHERE tenant_id = ? AND status IN ('OPEN','PARTIAL') AND due_at < ?`, tenantId, nowIso());
  if (overdue.n > 0) {
    insights.push(mk('RISK', `${overdue.n} supplier invoice(s) overdue — ${fmtMoney(overdue.amt)}`,
      'Overdue supplier liabilities risk supply interruptions.',
      overdue, 0.95, 'Review accounts payable and schedule payments', 'HIGH'));
  }
  for (const ins of insights) {
    q.run(db, `INSERT INTO ai_insights (id, tenant_id, kind, title, severity, body, data, confidence, action, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?, 'FRESH', ?)`,
      ins.id, ins.tenant_id, ins.kind, ins.title, ins.severity, ins.body, ins.data, ins.confidence, ins.action, ins.created_at);
  }
  return insights;
}

/* ---------------- Copilot (§32) ---------------- */
function logAi(db, tenantId, actorId, actionClass, question, detail) {
  q.run(db, `INSERT INTO ai_action_log (id, tenant_id, actor_id, action_class, question, detail, created_at)
             VALUES (?,?,?,?,?,?,?)`, id('ail'), tenantId, actorId, actionClass, question || null, JSON.stringify(detail || {}), nowIso());
  const { meter } = entitlementsModule;
  meter(db, tenantId, 'ai_requests');
}
import * as entitlementsModule from '../core/entitlements.js';

function answer(actionClass, text, data = {}, confidence = 0.8, actions = []) {
  return { action_class: actionClass, answer: text, data, confidence, actions, what: text, why: data.why || null, recommended_action: actions[0]?.label || null };
}

export function copilot(db, tenantId, actorId, questionRaw) {
  const question = String(questionRaw || '').slice(0, 500);
  const qs = question.toLowerCase();
  const cur = q.one(db, `SELECT currency FROM tenants WHERE id = ?`, tenantId)?.currency || 'KES';
  const money = (v) => fmtMoney(v, cur);

  // READ: sales today
  if (/how much.*sell|sales today|sold today|today'?s sales/.test(qs)) {
    const start = new Date().toISOString().slice(0, 10);
    const d = q.one(db, `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS total FROM orders
                         WHERE tenant_id = ? AND status != 'CANCELLED' AND created_at >= ?`, tenantId, start);
    const p = q.one(db, `SELECT COALESCE(SUM(total - tax),0) - COALESCE((SELECT SUM(oi.cost_price * oi.qty) FROM order_items oi JOIN orders o2 ON o2.id = oi.order_id WHERE o2.tenant_id = ? AND o2.status != 'CANCELLED' AND o2.created_at >= ?), 0) AS gp
                         FROM orders WHERE tenant_id = ? AND status != 'CANCELLED' AND created_at >= ?`, tenantId, start, tenantId, start);
    logAi(db, tenantId, actorId, 'READ', question, d);
    return answer('READ', `Sales today: ${money(d.total)} across ${d.orders} order(s). Estimated gross profit: ${money(Math.max(p?.gp || 0, 0))}.`, { orders: d.orders, total: d.total, gross_profit: p?.gp || 0, why: 'Summed from orders created today (tenant-scoped)' }, 0.98);
  }
  // READ: top profit products
  if (/most profit|top profit|best margin|made the most/.test(qs)) {
    const rows = productVelocity(db, tenantId, 30).sort((a, b) => b.margin - a.margin).slice(0, 5);
    logAi(db, tenantId, actorId, 'READ', question, { n: rows.length });
    return answer('READ', `Top profit generators (30d): ${rows.map(r => `${r.name} — ${money(r.margin)}`).join('; ') || 'no sales yet'}.`,
      { items: rows, why: 'Margin = (unit price − cost) × units sold, last 30 days' }, 0.9);
  }
  // READ: debtors
  if (/owe|outstanding|debtor|credit balance|arrears/.test(qs) && /customer/.test(qs)) {
    const rows = q.all(db, `SELECT c.name, c.phone, a.balance, a.limit_amount FROM credit_accounts a JOIN customers c ON c.id = a.customer_id
                            WHERE a.tenant_id = ? AND a.balance > 0 ORDER BY a.balance DESC LIMIT 10`, tenantId);
    const total = rows.reduce((s, r) => s + r.balance, 0);
    logAi(db, tenantId, actorId, 'READ', question, { n: rows.length });
    return answer('READ', rows.length
      ? `${rows.length} customer(s) owe ${money(total)}. Largest: ${rows.slice(0, 3).map(r => `${r.name} ${money(r.balance)}`).join(', ')}.`
      : 'No outstanding customer credit balances right now.',
      { items: rows, total }, 0.97, [{ label: 'Open credit centre', route: '/credit' }]);
  }
  // ANALYSE: cheapest supplier for X
  if (/cheapest|best price|lowest cost/.test(qs) && /supplier/.test(qs)) {
    const term = qs.replace(/.*for /, '').replace(/[?.]/g, '').trim();
    const rows = q.all(db, `SELECT p.name, p.sku, p.cost_price, s.name AS supplier, s.lead_time_days FROM products p
                            LEFT JOIN suppliers s ON s.id = p.supplier_id
                            WHERE p.tenant_id = ? AND (LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ?) ORDER BY p.cost_price ASC LIMIT 8`,
      tenantId, `%${term}%`, `%${term}%`);
    logAi(db, tenantId, actorId, 'ANALYSE', question, { term, n: rows.length });
    return answer('ANALYSE', rows.length
      ? `For "${term}", best landed cost: ${rows.map(r => `${r.name} via ${r.supplier || '—'} at ${money(r.cost_price)} (${r.lead_time_days ?? '?'}d lead)`).join('; ')}.`
      : `No products matching "${term}" found in your catalogue.`,
      { items: rows, why: 'Compared product cost prices grouped by primary supplier' }, 0.72);
  }
  // RECOMMEND: reorder
  if (/reorder|order today|restock|buy more|stock.*(buy|need)/.test(qs) && !/prepare/.test(qs)) {
    const rows = reorderAnalysis(db, tenantId).slice(0, 10);
    const cost = rows.reduce((s, r) => s + r.est_cost, 0);
    logAi(db, tenantId, actorId, 'RECOMMEND', question, { n: rows.length });
    return answer('RECOMMEND', rows.length
      ? `Reorder recommended for ${rows.length} product(s), est. spend ${money(cost)}. Most urgent: ${rows.slice(0, 3).map(r => `${r.name} — ${r.suggested_qty} ${r.unit}`).join('; ')}.`
      : 'No products currently need reordering — stock cover is above lead-time demand.',
      { items: rows, est_cost: cost, why: 'ROP = velocity × lead time + 3-day safety stock' }, 0.85,
      [{ label: 'Open reorder report', route: '/reports/reorder' }]);
  }
  // RECOMMEND: dead stock
  if (/dead stock|slow moving|not selling|tying up|tied up/.test(qs)) {
    const rows = deadStock(db, tenantId).slice(0, 10);
    const tied = rows.reduce((s, r) => s + r.tied_up_value, 0);
    logAi(db, tenantId, actorId, 'RECOMMEND', question, { n: rows.length });
    return answer('RECOMMEND', rows.length
      ? `${rows.length} slow product(s) hold ${money(tied)}. Worst: ${rows.slice(0, 3).map(r => `${r.name} (${money(r.tied_up_value)})`).join('; ')}. Consider clearance pricing.`
      : 'No dead stock detected — everything on hand sold within 60 days.',
      { items: rows, tied_up: tied }, 0.8, [{ label: 'Open inventory', route: '/inventory' }]);
  }
  // ANALYSE: why are sales down
  if (/why.*(sales|revenue).*(down|drop|fall)|sales.*(down|dropped)/.test(qs)) {
    const a = salesAnomaly(db, tenantId);
    const decliners = q.all(db, `
      SELECT p.name, SUM(CASE WHEN o.created_at >= ? THEN oi.qty ELSE 0 END) AS recent,
             SUM(CASE WHEN o.created_at < ? THEN oi.qty ELSE 0 END) AS prior
      FROM products p JOIN order_items oi ON oi.product_id = p.id JOIN orders o ON o.id = oi.order_id
      WHERE p.tenant_id = ? AND o.status != 'CANCELLED' AND o.created_at >= ?
      GROUP BY p.id HAVING prior > 0 ORDER BY (recent * 1.0 / prior) ASC LIMIT 3`, since(7), since(7), tenantId, since(14));
    logAi(db, tenantId, actorId, 'ANALYSE', question, {});
    return answer('ANALYSE', a
      ? `Today's sales ${money(a.today_total)} vs 2-week daily average ${money(a.mean)} (z=${a.z}). ${decliners.length ? `Weakest lines vs prior week: ${decliners.map(d => d.name).join(', ')}.` : 'No single product explains the dip — check foot traffic and pending quotes.'}`
      : 'Not enough history yet to assess the trend reliably (need 4+ days of data).',
      { anomaly: a, decliners }, 0.64, [{ label: 'View analytics', route: '/analytics' }]);
  }
  // READ: best customers
  if (/best customer|top customer|loyal customer/.test(qs)) {
    const rows = q.all(db, `SELECT c.name, c.type, COUNT(o.id) AS orders, SUM(o.total) AS spent FROM customers c
                            JOIN orders o ON o.customer_id = c.id AND o.tenant_id = ? AND o.status != 'CANCELLED'
                            WHERE c.tenant_id = ? GROUP BY c.id ORDER BY spent DESC LIMIT 5`, tenantId, tenantId);
    logAi(db, tenantId, actorId, 'READ', question, {});
    return answer('READ', rows.length
      ? `Best customers by lifetime spend: ${rows.map(r => `${r.name} — ${money(r.spent)} (${r.orders} orders)`).join('; ')}.`
      : 'No customer orders recorded yet.', { items: rows }, 0.95);
  }
  // READ: expiring quotes
  if (/quot.*expir|expiring quot/.test(qs)) {
    const until = since(-7);
    const rows = q.all(db, `SELECT q.number, q.total, q.valid_until, c.name AS customer FROM quotes q JOIN customers c ON c.id = q.customer_id
                            WHERE q.tenant_id = ? AND q.status IN ('SENT','VIEWED') AND q.valid_until <= ? ORDER BY q.valid_until`, tenantId, until);
    logAi(db, tenantId, actorId, 'READ', question, { n: rows.length });
    return answer('READ', rows.length
      ? `${rows.length} quotation(s) expire within 7 days: ${rows.map(r => `${r.number} (${r.customer}, ${money(r.total)})`).join('; ')}. Follow up before expiry.`
      : 'No quotations expire within the next 7 days.', { items: rows }, 0.95, [{ label: 'Open quotations', route: '/quotes' }]);
  }
  // READ: payroll due
  if (/payroll.*due|how much payroll|salary|wages due/.test(qs)) {
    const run = q.one(db, `SELECT * FROM payroll_runs WHERE tenant_id = ? AND status IN ('CALCULATED','REVIEWED','APPROVED') ORDER BY created_at DESC LIMIT 1`, tenantId);
    const monthly = q.one(db, `SELECT COALESCE(SUM(base_pay),0) AS b FROM workers WHERE tenant_id = ? AND status = 'ACTIVE' AND wage_type = 'MONTHLY'`, tenantId);
    logAi(db, tenantId, actorId, 'READ', question, {});
    return answer('READ', run
      ? `Open payroll run ${run.number}: net payable ${money(run.total_net)} (status ${run.status}). Monthly salary base: ${money(monthly.b)}.`
      : `No open payroll run. Active monthly salary base: ${money(monthly.b)}.`,
      { run, monthly_base: monthly.b }, 0.9, [{ label: 'Open payroll', route: '/payroll' }]);
  }
  // READ: best branch
  if (/branch.*(best|perform|top)|best.*branch/.test(qs)) {
    const rows = q.all(db, `SELECT b.name, COUNT(o.id) AS orders, COALESCE(SUM(o.total),0) AS revenue FROM branches b
                            LEFT JOIN orders o ON o.branch_id = b.id AND o.tenant_id = ? AND o.status != 'CANCELLED' AND o.created_at >= ?
                            WHERE b.tenant_id = ? AND b.is_active = 1 GROUP BY b.id ORDER BY revenue DESC`, tenantId, since(30), tenantId);
    logAi(db, tenantId, actorId, 'READ', question, {});
    return answer('READ', rows.length
      ? `Branch performance (30d): ${rows.map(r => `${r.name} — ${money(r.revenue)} (${r.orders} orders)`).join('; ')}.`
      : 'No branches configured.', { items: rows }, 0.93, [{ label: 'Branch comparison', route: '/reports' }]);
  }
  // READ: delayed deliveries / pending
  if (/deliver|dispatch/.test(qs) && /(delayed|pending|late|status)/.test(qs)) {
    const rows = q.all(db, `SELECT d.id, d.status, d.address, o.number FROM deliveries d JOIN orders o ON o.id = d.order_id
                            WHERE d.tenant_id = ? AND d.status IN ('PENDING','PICKING','PACKED','READY','ASSIGNED','DISPATCHED','IN_TRANSIT')
                            ORDER BY d.created_at DESC LIMIT 10`, tenantId);
    const delayed = rows.filter(r => ['DISPATCHED', 'IN_TRANSIT'].includes(r.status));
    logAi(db, tenantId, actorId, 'READ', question, { n: rows.length });
    return answer('READ', `${rows.length} delivery(ies) in flight; ${delayed.length} dispatched/in transit.${rows.length ? ' Oldest: ' + rows[rows.length - 1].number + ' (' + rows[rows.length - 1].status + ').' : ''}`,
      { items: rows }, 0.9, [{ label: 'Open deliveries', route: '/deliveries' }]);
  }
  // PREPARE: purchase orders (§32) — drafts only; never auto-send or spend money.
  if (/prepare.*(purchase|po|order)|create.*purchase|draft.*po/.test(qs)) {
    const recs = reorderAnalysis(db, tenantId).filter(r => r.suggested_qty > 0 && r.supplier);
    const bySupplier = new Map();
    for (const r of recs) {
      const p = q.one(db, `SELECT supplier_id FROM products WHERE id = ?`, r.product_id);
      if (!p?.supplier_id) continue;
      if (!bySupplier.has(p.supplier_id)) bySupplier.set(p.supplier_id, []);
      bySupplier.get(p.supplier_id).push(r);
    }
    const created = [];
    for (const [supplierId, items] of bySupplier) {
      const reqId = id('prq');
      const number = `PR-${(q.one(db, `SELECT COUNT(*) AS n FROM purchase_requisitions WHERE tenant_id = ?`, tenantId).n + 1)}`;
      q.run(db, `INSERT INTO purchase_requisitions (id, tenant_id, number, status, reason, source, created_at, updated_at)
                 VALUES (?,?,?, 'PENDING_APPROVAL', ?, 'AI_REORDER', ?, ?)`,
        reqId, tenantId, number, `AI-prepared reorder for ${items.length} item(s) — requires approval before any PO.`, nowIso(), nowIso());
      for (const it of items) {
        q.run(db, `INSERT INTO purchase_requisition_items (id, requisition_id, product_id, qty, est_cost) VALUES (?,?,?,?,?)`,
          id('pri'), reqId, it.product_id, it.suggested_qty, it.est_cost);
      }
      created.push({ requisition_id: reqId, number, supplier_id: supplierId, items: items.length });
    }
    logAi(db, tenantId, actorId, 'PREPARE', question, { requisitions: created.length });
    return answer('PREPARE', created.length
      ? `Prepared ${created.length} purchase requisition(s) for approval: ${created.map(c => c.number).join(', ')}. Nothing was sent to suppliers — approval is required.`
      : 'No supplier-linked products currently need reordering, so nothing was prepared.',
      { requisitions: created, why: 'PREPARE class only — no financial commitment (§58 AI safety)' }, 0.82,
      [{ label: 'Review requisitions', route: '/procurement' }]);
  }
  // default: READ with safe guidance
  logAi(db, tenantId, actorId, 'READ', question, { unmatched: true });
  return answer('READ',
    `I couldn't match that to a specific analysis. I can answer things like: "How much did we sell today?", "What should I reorder?", "Which customers owe us money?", "Which products are dead stock?", "Prepare purchase orders", or "Which branch is performing best?"`,
    {}, 0.3);
}

/* Product graph recommendations (§8). */
export function productRecommendations(db, tenantId, productId) {
  return q.all(db, `
    SELECT r.type, r.weight, p2.id, p2.name, p2.sku, p2.price_retail, p2.unit
    FROM product_relations r JOIN products p2 ON p2.id = r.related_id
    WHERE r.tenant_id = ? AND r.product_id = ? AND p2.is_active = 1
    ORDER BY r.weight DESC, CASE r.type WHEN 'REQUIRED' THEN 0 WHEN 'BUNDLE' THEN 1 WHEN 'ACCESSORY' THEN 2 WHEN 'COMPATIBLE' THEN 3 WHEN 'FBO' THEN 4 ELSE 5 END`,
    tenantId, productId);
}
