import { q, id, nowIso } from '../db/connection.js';
import { sendNotification } from '../adapters/messaging.js';

/**
 * Event-driven core (§42, §30, §43).
 * BUSINESS EVENT → event log → alert rules → automation rules.
 * Business logic never depends on async delivery; rules execute
 * deterministically in-process, in the same transaction.
 */

export function emitEvent(db, tenantId, type, payload = {}, actorId = null) {
  q.run(db, `INSERT INTO events (id, tenant_id, type, payload, actor_id, created_at) VALUES (?,?,?,?,?,?)`,
    id('evt'), tenantId, type, JSON.stringify(payload), actorId, nowIso());
  runAlertRules(db, tenantId, type, payload);
  runAutomationRules(db, tenantId, type, payload);
}

// ------- Alert rules (§30) -------
function renderTemplate(tpl, payload) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => payload[k] ?? '');
}

function matchCondition(cond, payload) {
  try {
    const c = typeof cond === 'string' ? JSON.parse(cond) : cond;
    for (const [k, v] of Object.entries(c || {})) {
      if (k === 'min') continue;
      if (payload[k] !== v) return false;
    }
    if (c?.min) {
      for (const [k, min] of Object.entries(c.min)) if (!(Number(payload[k]) >= Number(min))) return false;
    }
    return true;
  } catch { return true; }
}

export function runAlertRules(db, tenantId, type, payload) {
  if (!tenantId) return;
  const rules = q.all(db,
    `SELECT * FROM alert_rules WHERE tenant_id = ? AND event = ? AND enabled = 1`, tenantId, type);
  for (const rule of rules) {
    if (!matchCondition(rule.condition, payload)) continue;
    const users = rule.recipient_kind === 'USER'
      ? [{ id: rule.recipient_role }]
      : q.all(db,
        `SELECT u.id, u.phone FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = ? AND r.name = ? AND u.status = 'ACTIVE'`, tenantId, rule.recipient_role || 'OWNER');
    for (const u of users) {
      sendNotification(db, {
        tenantId, channel: rule.channel, recipientKind: 'USER', recipientId: u.id,
        toAddr: u.phone || null, body: renderTemplate(rule.template, payload),
        priority: rule.priority, kind: 'OPERATIONAL', eventType: type,
        refType: payload.ref_type || null, refId: payload.ref_id || null,
      });
    }
  }
}

// ------- Automation rules (§43) -------
export function runAutomationRules(db, tenantId, type, payload) {
  if (!tenantId) return;
  const rules = q.all(db,
    `SELECT * FROM automation_rules WHERE tenant_id = ? AND trigger_event = ? AND enabled = 1`, tenantId, type);
  for (const rule of rules) {
    if (!matchCondition(rule.condition, payload)) continue;
    const action = JSON.parse(rule.action || '{}');
    q.run(db, `UPDATE automation_rules SET last_fired_at = ? WHERE id = ?`, nowIso(), rule.id);
    // Sensitive automations never silently execute: they PREPARE + notify (§43, §58).
    if (rule.action_type === 'CREATE_PURCHASE_RECOMMENDATION' && payload.product_id) {
      const existing = q.one(db,
        `SELECT id FROM notifications WHERE tenant_id = ? AND ref_type = 'automation' AND ref_id = ? AND status != 'READ'`,
        tenantId, rule.id);
      if (!existing) {
        sendNotification(db, {
          tenantId, channel: 'IN_APP', recipientKind: 'ROLE', recipientId: 'PROCUREMENT',
          body: action.message || `Automation "${rule.name}" recommends reordering product ${payload.sku || payload.product_id}. Awaiting human approval.`,
          priority: 'HIGH', kind: 'OPERATIONAL', eventType: type, refType: 'automation', refId: rule.id,
          extra: { role_recipient: 'PROCUREMENT_OFFICER' },
        });
      }
    } else if (rule.action_type === 'NOTIFY') {
      sendNotification(db, {
        tenantId, channel: action.channel || 'IN_APP', recipientKind: 'ROLE', recipientId: action.role || 'OWNER',
        body: renderTemplate(action.message || rule.name, payload),
        priority: action.priority || 'NORMAL', kind: 'OPERATIONAL', eventType: type,
        refType: payload.ref_type || null, refId: payload.ref_id || null,
        extra: { role_recipient: action.role || 'OWNER' },
      });
    }
  }
}
