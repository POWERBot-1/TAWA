import { q, id, nowIso } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqOneOf } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { requireEntitlement } from '../core/entitlements.js';
import crypto from 'node:crypto';

export const API_KEY_PREFIX = 'tawa';
export const KEY_SCOPES = ['read', 'write', 'reports', 'webhooks'];
export const MAX_ACTIVE_KEYS_PER_TENANT = 50;

function keyFingerprint(tokenHash) {
  return crypto.createHash('sha256').update('tawa-key-fp:' + tokenHash).digest('hex').slice(0, 16);
}
export function hashApiKey(raw) {
  return crypto.createHash('sha256').update('tawa-api-key:' + raw).digest('hex');
}
export function generateApiKey() {
  return `${API_KEY_PREFIX}_${crypto.randomBytes(24).toString('base64url')}`;
}

/** Scope gate for API-key-originated requests. */
export function requireApiScope(req, scope) {
  if (!req.auth?.fromApiKey) return;
  if (!req.auth.scopes.includes(scope)) {
    throw err.forbidden(`API key lacks scope: ${scope}`);
  }
}

const PERM_MAP = {
  'GET': 'apikeys.view', 'POST': 'apikeys.manage', 'PATCH': 'apikeys.manage', 'DELETE': 'apikeys.manage',
};

export function registerKeys(router, db) {
  const guard = (req) => {
    if (req.auth?.fromApiKey) throw err.forbidden('API keys cannot manage API keys');
    mustPerm(req, PERM_MAP[req.method] || 'api.keys.view');
    requireEntitlement(db, req, 'TAWA.API');
  };

  router.get('/api/v1/api-keys', (req, res) => {
    guard(req);
    const rows = q.all(db, `SELECT id, name, scopes, created_at, created_by, expires_at, last_used_at, revoked_at
      FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`, req.tenantId);
    ok(res, rows.map(r => ({ ...r, fingerprint: keyFingerprint(r.token_hash || '') })));
  });

  router.post('/api/v1/api-keys', async (req, res) => {
    guard(req);
    const body = await readBody(req);
    const name = reqStr(body.name, 'name', { min: 2, max: 80 });
    const scopes = (body.scopes || ['read']).map(s => reqOneOf(s, 'scope', KEY_SCOPES));
    if (!scopes.length) throw err.unprocessable('At least one scope is required');
    const active = q.one(db, `SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ? AND revoked_at IS NULL`, req.tenantId).n;
    if (active >= MAX_ACTIVE_KEYS_PER_TENANT) throw err.conflict(`API key limit reached (${MAX_ACTIVE_KEYS_PER_TENANT} active keys per tenant)`);
    const raw = generateApiKey();
    const kid = id('key');
    const expiresAt = body.expires_in_days ? new Date(Date.now() + Math.min(365, Math.max(1, Number(body.expires_in_days))) * 86400_000).toISOString() : null;
    q.run(db, `INSERT INTO api_keys (id, tenant_id, name, token_hash, scopes, created_at, created_by, expires_at)
      VALUES (?,?,?,?,?,?,?,?)`, kid, req.tenantId, name, hashApiKey(raw), scopes.join(','), nowIso(), req.auth.user.id, expiresAt);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'api_key.create', resource: 'api_key', resourceId: kid, metadata: { name, scopes, expires_at: expiresAt } });
    created(res, { id: kid, name, scopes, key: raw, expires_at: expiresAt, note: 'Store this key now. It is never shown again.' });
  });

  router.post('/api/v1/api-keys/:id/revoke', (req, res) => {
    guard(req);
    const k = q.one(db, `SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!k) throw err.notFound('API key not found');
    if (k.revoked_at) throw err.conflict('API key already revoked');
    q.run(db, `UPDATE api_keys SET revoked_at = ? WHERE id = ?`, nowIso(), k.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'api_key.revoke', resource: 'api_key', resourceId: k.id, metadata: { name: k.name } });
    ok(res, { id: k.id, revoked_at: nowIso() });
  });

  router.delete('/api/v1/api-keys/:id', (req, res) => {
    guard(req);
    const k = q.one(db, `SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!k) throw err.notFound('API key not found');
    if (!k.revoked_at) throw err.conflict('Revoke the key before deleting it');
    q.run(db, `DELETE FROM api_keys WHERE id = ?`, k.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'api_key.delete', resource: 'api_key', resourceId: k.id, metadata: { name: k.name } });
    ok(res, { deleted: true });
  });
}
