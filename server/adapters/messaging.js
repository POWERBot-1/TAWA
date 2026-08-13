import crypto from 'node:crypto';
import { q, id, nowIso } from '../db/connection.js';
import { meter } from '../core/entitlements.js';

/**
 * Messaging adapter layer (§62, marketing spec §9-11).
 * Providers are SANDBOX adapters: they persist a fully-formed outbound
 * record with provider references and delivery simulation — no external
 * network calls. Production adapters (Africa's Talking, Twilio, Meta WA,
 * SMTP) implement the same contract. Status is honestly marked 'sandbox'.
 */
export const MESSAGING_PROVIDERS = {
  sms_log: {
    kind: 'SMS', environment: 'sandbox', name: 'TAWA SMS Sandbox',
    send(to, body) {
      return { ok: !!to, ref: `SMSB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, status: to ? 'DELIVERED' : 'FAILED' };
    },
    healthCheck() { return { status: 'ONLINE', environment: 'sandbox' }; },
  },
  whatsapp_log: {
    kind: 'WHATSAPP', environment: 'sandbox', name: 'TAWA WhatsApp Sandbox',
    send(to, body) {
      return { ok: !!to, ref: `WASB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, status: to ? 'DELIVERED' : 'FAILED' };
    },
    healthCheck() { return { status: 'ONLINE', environment: 'sandbox' }; },
  },
  email_log: {
    kind: 'EMAIL', environment: 'sandbox', name: 'TAWA Email Sandbox',
    send(to) {
      return { ok: !!to, ref: `EMSB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, status: to ? 'DELIVERED' : 'FAILED' };
    },
    healthCheck() { return { status: 'ONLINE', environment: 'sandbox' }; },
  },
};

const CHANNEL_PROVIDER = { SMS: 'sms_log', WHATSAPP: 'whatsapp_log', EMAIL: 'email_log' };

/**
 * Single outbound path. Notifications are durable records: channel sends
 * never lose intent; marketing kind enforces consent (§50).
 */
export function sendNotification(db, n) {
  const channel = n.channel || 'IN_APP';
  let status = 'SENT', provider = null, providerRef = null, sentAt = nowIso();
  if (n.kind === 'MARKETING' && n.recipientKind === 'CUSTOMER' && n.recipientId) {
    const c = q.one(db, `SELECT marketing_opt_in FROM customers WHERE id = ? AND tenant_id = ?`, n.recipientId, n.tenantId);
    if (!c || !c.marketing_opt_in) status = 'FAILED'; // consent gate — do not spam (spec §33, §50)
  }
  if (channel !== 'IN_APP' && status !== 'FAILED') {
    const p = MESSAGING_PROVIDERS[CHANNEL_PROVIDER[channel]];
    const result = p.send(n.toAddr, n.body);
    provider = CHANNEL_PROVIDER[channel];
    providerRef = result.ref;
    status = result.ok ? result.status : 'FAILED';
    if (n.tenantId) meter(db, n.tenantId, 'messages_sent');
  } else if (channel === 'IN_APP' && n.recipientKind === 'ROLE') {
    // role broadcast → materialize per-user IN_APP rows
    const users = q.all(db,
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE u.tenant_id = ? AND r.name = ? AND u.status = 'ACTIVE'`, n.tenantId, n.extra?.role_recipient || n.recipientId || 'OWNER');
    const targets = users.length ? users : q.all(db, `SELECT id FROM users WHERE tenant_id = ? AND status='ACTIVE' LIMIT 5`, n.tenantId);
    for (const u of targets) {
      q.run(db, `INSERT INTO notifications (id, tenant_id, channel, recipient_kind, recipient_id, to_addr, body, priority, status, kind, event_type, ref_type, ref_id, created_at, sent_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id('ntf'), n.tenantId, 'IN_APP', 'USER', u.id, null, n.body, n.priority || 'NORMAL', 'SENT', n.kind || 'OPERATIONAL',
        n.eventType || null, n.refType || null, n.refId || null, nowIso(), sentAt);
    }
    return { id: null, count: targets.length };
  }
  const nid = id('ntf');
  q.run(db, `INSERT INTO notifications (id, tenant_id, channel, recipient_kind, recipient_id, to_addr, subject, body, priority, status, kind, event_type, ref_type, ref_id, provider, provider_ref, campaign_id, created_at, sent_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    nid, n.tenantId ?? null, channel, n.recipientKind || 'USER', n.recipientId ?? null,
    n.toAddr ?? null, n.subject ?? null, n.body, n.priority || 'NORMAL', status,
    n.kind || 'TRANSACTIONAL', n.eventType || null, n.refType || null, n.refId || null,
    provider, providerRef, n.campaignId || null, nowIso(), sentAt);
  return { id: nid, status };
}
