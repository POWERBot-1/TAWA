import crypto from 'node:crypto';
import { err } from './http.js';
import { q, id, nowIso } from '../db/connection.js';
import { config } from '../config.js';
import { audit } from './audit.js';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

/** scrypt password hashing. Format: scrypt$N$salt_b64$hash_b64 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  try {
    const [algo, nStr, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const key = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), KEYLEN, { N: Number(nStr), r: SCRYPT_R, p: SCRYPT_P });
    const expected = Buffer.from(hashB64, 'base64');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

/** Password policy (§40 security). */
export function checkPasswordPolicy(pw) {
  const issues = [];
  if (typeof pw !== 'string' || pw.length < 10) issues.push('at least 10 characters');
  if (!/[a-z]/.test(pw)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) issues.push('an uppercase letter');
  if (!/[0-9]/.test(pw)) issues.push('a digit');
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push('a symbol');
  return issues;
}

export function sessionCookie(res, token, session) {
  const cookie = [
    `${config.cookieName}=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${config.sessionTtlHours * 3600}`,
    config.cookieSecure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
  return session;
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

export function createSession(db, user, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(16).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
  const sess = {
    id: tokenHash, user_id: user.id, tenant_id: user.tenant_id,
    csrf, ip: clientIp(req), user_agent: String(req.headers['user-agent'] || '').slice(0, 250),
    expires_at: expires, created_at: nowIso(),
  };
  q.run(db,
    `INSERT INTO sessions (id, user_id, tenant_id, csrf, ip, user_agent, expires_at, created_at)
     VALUES (@id,@user_id,@tenant_id,@csrf,@ip,@user_agent,@expires_at,@created_at)`,
    ...named(sess));
  if (res) sessionCookie(res, token, sess);
  return { token, csrf, expires_at: expires };
}

// node:sqlite named params need keys without '@'. Helper adapts object.
function named(obj) { return [obj]; }

export function revokeSession(db, tokenHash) {
  q.run(db, `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, nowIso(), tokenHash);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || null;
}

/**
 * Resolve the request's authenticated context. Server-side only:
 * - session => user => tenant. Never trust client-supplied tenant ids (§3).
 * - Revoked/expired sessions cannot continue privileged operations (§58 test 9).
 */
export function resolveAuth(db, req) {
  const cookies = parseCookies(req);
  const bearer = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : null;
  const token = cookies[config.cookieName] || bearer;
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const sess = q.one(db, `SELECT * FROM sessions WHERE id = ?`, tokenHash);
  if (!sess || sess.revoked_at || sess.expires_at < nowIso()) return null;
  const user = q.one(db, `SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'`, sess.user_id);
  if (!user) return null;
  const roles = q.all(db,
    `SELECT r.* FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`, user.id);
  const perms = new Set();
  for (const r of roles) {
    for (const row of q.all(db, `SELECT permission FROM role_permissions WHERE role_id = ?`, r.id)) perms.add(row.permission);
  }
  return { user, session: sess, tokenHash, roles, perms, viaCookie: !!cookies[config.cookieName] && !bearer };
}

/** CSRF: cookie-based mutations must carry the session's csrf token (§40). */
export function enforceCsrf(auth, req) {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (safe || !auth?.viaCookie) return;
  const hdr = req.headers['x-tawa-csrf'] || req.headers['x-csrf-token'];
  if (!hdr || hdr !== auth.session.csrf) throw err.forbidden('CSRF validation failed');
}

/** Middleware factory: require authenticated session. */
export function requireAuth(db) {
  return (req) => {
    if (req.path.startsWith('/api/')) {
      const auth = resolveAuth(db, req);
      req.auth = auth || null;
    }
  };
}
export function mustAuth(req) {
  if (!req.auth) throw err.unauthorized();
  return req.auth;
}
export function mustPerm(req, perm) {
  const auth = mustAuth(req);
  if (!auth.perms.has(perm)) {
    throw err.forbidden(`Missing permission: ${perm}`);
  }
  return auth;
}
export function hasPerm(req, perm) {
  return !!(req.auth && req.auth.perms.has(perm));
}
