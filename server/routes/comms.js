import { q, id, nowIso, tx } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqOneOf, pageParams } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { emitEvent } from '../core/events.js';
import { sendNotification } from '../adapters/messaging.js';
import { fmtMoney } from '../modules/payments.js';

export function registerComms(router, db) {
  /* ---------------- Notification centre ---------------- */
  router.get('/api/v1/notifications', (req, res) => {
    mustPerm(req, 'alerts.view');
    const { limit, offset } = pageParams(req);
    const rows = q.all(db, `SELECT * FROM notifications WHERE tenant_id = ? AND (recipient_id = ? OR recipient_kind = 'ROLE' OR recipient_id IS NULL)
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, req.tenantId, req.auth.user.id, limit, offset);
    const unread = q.one(db, `SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND recipient_id = ? AND status != 'READ' AND channel = 'IN_APP'`, req.tenantId, req.auth.user.id).n;
    ok(res, rows, { unread });
  });
  router.post('/api/v1/notifications/:id/read', (req, res) => {
    mustPerm(req, 'alerts.view');
    q.run(db, `UPDATE notifications SET status = 'READ', read_at = ? WHERE id = ? AND tenant_id = ? AND recipient_id = ?`,
      nowIso(), req.params.id, req.tenantId, req.auth.user.id);
    ok(res, { read: true });
  });
  /** Admin view of all outbound (SMS/WhatsApp/email) with provider status. */
  router.get('/api/v1/notifications/outbound', (req, res) => {
    mustPerm(req, 'alerts.manage');
    const { limit, offset } = pageParams(req);
    ok(res, q.all(db, `SELECT * FROM notifications WHERE tenant_id = ? AND channel != 'IN_APP'
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, req.tenantId, limit, offset));
  });

  /* ---------------- Alert rules ---------------- */
  router.get('/api/v1/alerts/rules', (req, res) => {
    mustPerm(req, 'alerts.manage');
    ok(res, q.all(db, `SELECT * FROM alert_rules WHERE tenant_id = ? ORDER BY created_at`, req.tenantId));
  });
  router.post('/api/v1/alerts/rules', async (req, res) => {
    mustPerm(req, 'alerts.manage');
    const body = await readBody(req);
    const rid = id('arl');
    q.run(db, `INSERT INTO alert_rules (id, tenant_id, name, event, condition, channel, recipient_role, template, priority, enabled, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      rid, req.tenantId, reqStr(body.name, 'name'), reqStr(body.event, 'event'),
      JSON.stringify(body.condition || {}), reqOneOf(reqStr(body.channel, 'channel'), 'channel', ['IN_APP', 'SMS', 'WHATSAPP', 'EMAIL']),
      optStr(body.recipient_role, 'recipient_role') || 'OWNER', reqStr(body.template, 'template'),
      reqOneOf(body.priority || 'NORMAL', 'priority', ['INFO', 'LOW', 'NORMAL', 'HIGH', 'URGENT', 'CRITICAL']),
      body.enabled === false ? 0 : 1, nowIso());
    created(res, q.one(db, `SELECT * FROM alert_rules WHERE id = ?`, rid));
  });
  router.patch('/api/v1/alerts/rules/:id', async (req, res) => {
    mustPerm(req, 'alerts.manage');
    const rule = q.one(db, `SELECT * FROM alert_rules WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!rule) throw err.notFound('Rule not found');
    const body = await readBody(req);
    q.run(db, `UPDATE alert_rules SET enabled = COALESCE(?, enabled), priority = COALESCE(?, priority), template = COALESCE(?, template)
      WHERE id = ?`, body.enabled === undefined ? null : (body.enabled ? 1 : 0), body.priority ?? null, body.template ?? null, rule.id);
    ok(res, q.one(db, `SELECT * FROM alert_rules WHERE id = ?`, rule.id));
  });

  /* ---------------- Automation rules (§43) ---------------- */
  router.get('/api/v1/automation/rules', (req, res) => {
    mustPerm(req, 'alerts.manage');
    ok(res, q.all(db, `SELECT * FROM automation_rules WHERE tenant_id = ? ORDER BY created_at`, req.tenantId));
  });
  router.post('/api/v1/automation/rules', async (req, res) => {
    mustPerm(req, 'automation.manage');
    const body = await readBody(req);
    const rid = id('aut');
    q.run(db, `INSERT INTO automation_rules (id, tenant_id, name, trigger_event, condition, action_type, action, requires_approval, enabled, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      rid, req.tenantId, reqStr(body.name, 'name'), reqStr(body.trigger_event, 'trigger_event'),
      JSON.stringify(body.condition || {}),
      reqOneOf(reqStr(body.action_type, 'action_type'), 'action_type', ['CREATE_PURCHASE_RECOMMENDATION', 'NOTIFY', 'ESCALATE', 'PREPARE_TASK']),
      JSON.stringify(body.action || {}), body.requires_approval === false ? 0 : 1, body.enabled === false ? 0 : 1, nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'automation.create', resource: 'automation_rule', resourceId: rid });
    created(res, q.one(db, `SELECT * FROM automation_rules WHERE id = ?`, rid));
  });

  /* ---------------- Campaigns (ext §3-8) ---------------- */
  router.get('/api/v1/marketing/campaigns', (req, res) => {
    mustPerm(req, 'marketing.view');
    ok(res, q.all(db, `SELECT c.*, u.name AS created_by_name FROM campaigns c LEFT JOIN users u ON u.id = c.created_by
      WHERE c.tenant_id = ? ORDER BY c.created_at DESC LIMIT 100`, req.tenantId));
  });
  router.post('/api/v1/marketing/campaigns', async (req, res) => {
    mustPerm(req, 'marketing.manage');
    const body = await readBody(req);
    const cid = id('cmp');
    q.run(db, `INSERT INTO campaigns (id, tenant_id, name, description, objective, segment, offer, channels, budget, status, starts_at, ends_at, created_by, ai_prepared, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'DRAFT', ?,?,?,?,?,?)`,
      cid, req.tenantId, reqStr(body.name, 'name'), optStr(body.description, 'description'), optStr(body.objective, 'objective'),
      optStr(body.segment, 'segment') || 'ALL', JSON.stringify(body.offer || {}),
      JSON.stringify(body.channels || ['SMS']), Math.round(Number(body.budget || 0) * 100),
      body.starts_at || null, body.ends_at || null, req.auth.user.id, body.ai_prepared ? 1 : 0, nowIso(), nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'campaign.create', resource: 'campaign', resourceId: cid });
    created(res, q.one(db, `SELECT * FROM campaigns WHERE id = ?`, cid));
  });
  router.post('/api/v1/marketing/campaigns/:id/approve', (req, res) => {
    mustPerm(req, 'marketing.approve');
    const c = q.one(db, `SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!c) throw err.notFound('Campaign not found');
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(c.status)) throw err.conflict(`Campaign is ${c.status}`);
    q.run(db, `UPDATE campaigns SET status = 'APPROVED', approved_by = ?, updated_at = ? WHERE id = ?`, req.auth.user.id, nowIso(), c.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'campaign.approve', resource: 'campaign', resourceId: c.id });
    ok(res, q.one(db, `SELECT * FROM campaigns WHERE id = ?`, c.id));
  });

  /** Send: consent-gated broadcast via messaging adapters (ext §50). */
  router.post('/api/v1/marketing/campaigns/:id/send', (req, res) => {
    mustPerm(req, 'marketing.manage');
    const c = q.one(db, `SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!c) throw err.notFound('Campaign not found');
    if (c.status !== 'APPROVED') throw err.conflict('Campaign must be approved before sending — AI and staff prepare, humans authorize');
    const brand = q.one(db, `SELECT business_name FROM tenant_branding WHERE tenant_id = ?`, req.tenantId)?.business_name || 'TAWA';
    const offer = JSON.parse(c.offer || '{}');
    const customers = q.all(db, `SELECT id, name, phone, marketing_opt_in FROM customers WHERE tenant_id = ? AND is_active = 1 AND phone IS NOT NULL`, req.tenantId)
      .filter(cust => segmentMatch(c.segment, cust.id, c.tenant_id, db));
    let sent = 0, blocked = 0;
    const channels = JSON.parse(c.channels || '["SMS"]');
    tx(db, () => {
      for (const cust of customers) {
        const body = `${brand}: ${c.name}. ${offer.message || c.description || 'Special offer now on at our store.'} Reply STOP to opt out.`;
        for (const ch of channels) {
          const r = sendNotification(db, {
            tenantId: req.tenantId, channel: ch, recipientKind: 'CUSTOMER', recipientId: cust.id, toAddr: cust.phone,
            body, kind: 'MARKETING', eventType: 'CampaignSent', refType: 'campaign', refId: c.id, campaignId: c.id,
          });
          if (r.status === 'FAILED') blocked++; else sent++;
        }
      }
      q.run(db, `UPDATE campaigns SET status = 'SENT', stats = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify({ recipients: customers.length, sent, blocked_consent: blocked, orders: 0, revenue: 0 }), nowIso(), c.id);
    });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'campaign.send', resource: 'campaign', resourceId: c.id, metadata: { sent, blocked } });
    emitEvent(db, req.tenantId, 'CampaignSent', { campaign_id: c.id, recipients: customers.length });
    ok(res, q.one(db, `SELECT * FROM campaigns WHERE id = ?`, c.id));
  });

  /* ---------------- Promotions (ext §4-5) ---------------- */
  router.get('/api/v1/marketing/promotions', (req, res) => {
    mustPerm(req, 'marketing.view');
    ok(res, q.all(db, `SELECT * FROM promotions WHERE tenant_id = ? ORDER BY created_at DESC`, req.tenantId));
  });
  router.post('/api/v1/marketing/promotions', async (req, res) => {
    mustPerm(req, 'marketing.manage');
    const body = await readBody(req);
    const pid = id('prm');
    q.run(db, `INSERT INTO promotions (id, tenant_id, code, name, type, value, buy_qty, get_qty, conditions, starts_at, ends_at, is_active, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pid, req.tenantId, reqStr(body.code, 'code').toUpperCase(), reqStr(body.name, 'name'),
      reqOneOf(reqStr(body.type, 'type'), 'type', ['PERCENT', 'FIXED', 'BXY', 'BUNDLE', 'QUANTITY']),
      reqNum(body.value ?? 0, 'value', { min: 0 }),
      reqNum(body.buy_qty ?? 0, 'buy_qty', { min: 0 }), reqNum(body.get_qty ?? 0, 'get_qty', { min: 0 }),
      JSON.stringify(body.conditions || {}), body.starts_at || null, body.ends_at || null, body.is_active === false ? 0 : 1, nowIso());
    created(res, q.one(db, `SELECT * FROM promotions WHERE id = ?`, pid));
  });

  /** Rule-driven promo evaluation for a cart (ext §5: not hard-coded in POS). */
  router.post('/api/v1/marketing/promotions/evaluate', async (req, res) => {
    mustPerm(req, 'pos.use');
    const body = await readBody(req);
    const promos = q.all(db, `SELECT * FROM promotions WHERE tenant_id = ? AND is_active = 1`, req.tenantId)
      .filter(p => (!p.starts_at || p.starts_at <= nowIso()) && (!p.ends_at || p.ends_at >= nowIso()));
    const cartTotal = Math.round(Number(body.subtotal || 0) * 100);
    const applied = [];
    for (const p of promos) {
      const cond = JSON.parse(p.conditions || '{}');
      if (cond.min_order_total && cartTotal < cond.min_order_total) continue;
      let discount = 0;
      if (p.type === 'PERCENT') discount = Math.round(cartTotal * (p.value / 100));
      if (p.type === 'FIXED') discount = Math.round(p.value * 100);
      if (discount > 0) applied.push({ code: p.code, name: p.name, type: p.type, discount });
    }
    ok(res, { applied, total_discount: applied.reduce((s, a) => s + a.discount, 0) });
  });

  /* ---------------- Loyalty (§34) ---------------- */
  router.get('/api/v1/marketing/loyalty', (req, res) => {
    mustPerm(req, 'marketing.view');
    ok(res, {
      tiers: q.all(db, `SELECT * FROM loyalty_tiers WHERE tenant_id = ? ORDER BY min_points`, req.tenantId),
      top_members: q.all(db, `SELECT name, loyalty_tier, loyalty_points FROM customers WHERE tenant_id = ? AND loyalty_points > 0 ORDER BY loyalty_points DESC LIMIT 20`, req.tenantId),
      distribution: q.all(db, `SELECT loyalty_tier, COUNT(*) AS members FROM customers WHERE tenant_id = ? GROUP BY loyalty_tier`, req.tenantId),
    });
  });

  /* ---------------- Auto-Pay (entitlement-gated, audit-heavy) ---------------- */
  router.get('/api/v1/autopay/rules', (req, res) => {
    mustPerm(req, 'payments.view');
    ok(res, q.all(db, `SELECT r.*, u.name AS created_by_name FROM autopay_rules r LEFT JOIN users u ON u.id = r.created_by WHERE r.tenant_id = ? ORDER BY r.created_at DESC`, req.tenantId));
  });
  router.post('/api/v1/autopay/rules', async (req, res) => {
    mustPerm(req, 'payments.payout');
    const body = await readBody(req);
    const rid = id('apr');
    q.run(db, `INSERT INTO autopay_rules (id, tenant_id, name, purpose, payee_id, funding_source, max_amount, frequency, approval_policy, failure_policy, notify_policy, starts_at, ends_at, enabled, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rid, req.tenantId, reqStr(body.name, 'name'),
      reqOneOf(reqStr(body.purpose, 'purpose'), 'purpose', ['SUPPLIER_PAYMENT', 'WORKER_PAYMENT', 'BROKER_COMMISSION', 'EXPENSE', 'SUBSCRIPTION', 'OTHER']),
      optStr(body.payee_id, 'payee_id'), optStr(body.funding_source, 'funding_source') || 'MPESA',
      Math.round(reqNum(body.max_amount, 'max_amount', { min: 0.01 }) * 100),
      reqOneOf(reqStr(body.frequency, 'frequency'), 'frequency', ['DAILY', 'WEEKLY', 'MONTHLY', 'ON_APPROVAL']),
      reqOneOf(body.approval_policy || 'REQUIRE_CONFIRMATION', 'approval_policy', ['REQUIRE_CONFIRMATION', 'AMOUNT_LIMIT_ONLY']),
      reqStr(body.failure_policy || 'NOTIFY', 'failure_policy'), reqStr(body.notify_policy || 'ALWAYS', 'notify_policy'),
      reqStr(body.starts_at, 'starts_at'), reqStr(body.ends_at, 'ends_at'),
      body.enabled === false ? 0 : 1, req.auth.user.id, nowIso());
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'autopay.create', resource: 'autopay_rule', resourceId: rid, metadata: { purpose: body.purpose, max_amount: body.max_amount } });
    created(res, q.one(db, `SELECT * FROM autopay_rules WHERE id = ?`, rid));
  });
  /** Disabling Auto-Pay prevents ALL future executions from that rule (spec §58 test 12). */
  router.post('/api/v1/autopay/rules/:id/toggle', (req, res) => {
    mustPerm(req, 'payments.payout');
    const r = q.one(db, `SELECT * FROM autopay_rules WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!r) throw err.notFound('Auto-Pay rule not found');
    q.run(db, `UPDATE autopay_rules SET enabled = ? WHERE id = ?`, r.enabled ? 0 : 1, r.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: r.enabled ? 'autopay.disable' : 'autopay.enable', resource: 'autopay_rule', resourceId: r.id });
    ok(res, q.one(db, `SELECT * FROM autopay_rules WHERE id = ?`, r.id));
  });
}

function segmentMatch(segment, customerId, tenantId, db) {
  if (!segment || segment === 'ALL') return true;
  if (segment === 'MARKETING_OPTIN') {
    return !!q.one(db, `SELECT id FROM customers WHERE id = ? AND marketing_opt_in = 1 AND tenant_id = ?`, customerId, tenantId);
  }
  if (segment === 'CONTRACTORS' || segment === 'WHOLESALE') {
    return !!q.one(db, `SELECT id FROM customers WHERE id = ? AND type = ? AND tenant_id = ?`, customerId, segment === 'CONTRACTORS' ? 'CONTRACTOR' : 'WHOLESALE', tenantId);
  }
  if (segment === 'INACTIVE') {
    return !q.one(db, `SELECT id FROM orders WHERE customer_id = ? AND created_at >= ?`, customerId, new Date(Date.now() - 60 * 86400_000).toISOString());
  }
  return true;
}
