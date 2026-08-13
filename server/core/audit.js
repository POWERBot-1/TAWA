import { q, id, nowIso } from '../db/connection.js';

/**
 * Append-only audit (§39). Never logs passwords, tokens, payment credentials.
 * Metadata is shallow-sanitized for sensitive keys.
 */
const SENSITIVE_KEYS = ['password', 'secret', 'token', 'api_key', 'apikey', 'credential', 'card_number', 'cvv', 'pin'];

function sanitize(obj, depth = 0) {
  if (obj === null || typeof obj !== 'object' || depth > 4) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (SENSITIVE_KEYS.some(s => key.includes(s))) { out[k] = '[redacted]'; continue; }
    out[k] = v && typeof v === 'object' ? sanitize(v, depth + 1) : v;
  }
  return out;
}

export function audit(db, { tenantId = null, actorId = null, actorName = null, action, resource = null, resourceId = null, result = 'SUCCESS', reason = null, metadata = {}, ip = null, correlationId = null }) {
  q.run(db,
    `INSERT INTO audit_events (id, tenant_id, actor_id, actor_name, action, resource, resource_id, result, reason, metadata, ip, correlation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id('aud'), tenantId, actorId, actorName, action, resource, resourceId, result, reason,
    JSON.stringify(sanitize(metadata) ?? {}), ip, correlationId, nowIso());
}

export function auditFromReq(db, req, action, opts = {}) {
  audit(db, {
    tenantId: req.tenantId ?? null,
    actorId: req.auth?.user?.id ?? null,
    actorName: req.auth?.user?.name ?? null,
    action,
    ip: req.ip ?? null,
    correlationId: req.id ?? null,
    ...opts,
  });
}
