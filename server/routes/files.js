import { q, id, nowIso } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqOneOf } from '../core/http.js';
import { mustPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { requireApiScope } from './keys.js';
import crypto from 'node:crypto';

const MAX_FILE_BYTES = 256 * 1024;
const KINDS = ['LOGO', 'RECEIPT_LOGO', 'PRODUCT_IMAGE', 'DOCUMENT', 'AVATAR'];
const ALLOWED_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp' };
export const MAX_FILES_PER_TENANT = 500;

function sniffSize(mime, buf) {
  if (mime === 'image/png' && buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (mime === 'image/jpeg' && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      const len = buf.readUInt16BE(o + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
      if (len < 2) break; o += 2 + len;
    }
  }
  if (mime === 'image/webp' && buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.toString('latin1', 12, 16) === 'VP8X') {
    return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}
const readRawBody = (req, limit = MAX_FILE_BYTES) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > limit) { reject(err.unprocessable('File too large (max 256KB)')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

function fileUrl(tenantCode, idv) { return `/${tenantCode}/files/${idv}`; }
function present(row, withData = false) {
  if (!row) return null;
  const out = { id: row.id, tenant_code: row.tenant_code, kind: row.kind, name: row.name, mime: row.mime, bytes: row.bytes, sha256: row.sha256, width: row.width, height: row.height, created_at: row.created_at, created_by: row.created_by, url: fileUrl(row.tenant_code, row.id) };
  if (withData) out.data_base64 = row.data.toString('base64');
  return out;
}

async function storeFile(db, req, body, { kindDefault = 'LOGO', auditAction = 'file.upload' } = {}) {
  const kind = reqOneOf(body.kind || kindDefault, 'kind', KINDS);
  const name = reqStr(body.name, 'name', { min: 1, max: 160 });
  const mime = reqOneOf(String(body.mime || '').toLowerCase(), 'mime', Object.keys(ALLOWED_MIME));
  const b64 = reqStr(body.data_base64, 'data_base64', { min: 8 });
  const count = q.one(db, `SELECT COUNT(*) AS n FROM files WHERE tenant_id = ?`, req.tenantId).n;
  if (count >= MAX_FILES_PER_TENANT) throw err.conflict(`File quota exceeded (${MAX_FILES_PER_TENANT} files per tenant)`);
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { throw err.unprocessable('data_base64 must be valid base64'); }
  if (!buf || !buf.length) throw err.unprocessable('Empty file');
  if (buf.length > MAX_FILE_BYTES) throw err.unprocessable('File too large (max 256KB)');
  if (mime === 'image/svg+xml') {
    const txt = buf.toString('utf8');
    if (/<script|on\w+\s*=|javascript:|foreignObject/i.test(txt)) throw err.unprocessable('SVG must not contain scripts or event handlers');
  }
  const dims = sniffSize(mime, buf);
  if (dims && (dims.w > 4096 || dims.h > 4096 || dims.w < 1 || dims.h < 1)) throw err.unprocessable('Image dimensions exceed limits (max 4096px)');
  const fid = id('fil');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  q.run(db, `INSERT INTO files (id, tenant_id, tenant_code, kind, name, mime, bytes, sha256, width, height, data, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fid, req.tenantId, req.tenant.code, kind, name, mime, buf.length, sha, dims?.w ?? null, dims?.h ?? null, buf, nowIso(), req.auth.user.id);
  audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: auditAction, resource: 'file', resourceId: fid, metadata: { kind, name, bytes: buf.length, sha256: sha.slice(0, 16) } });
  return { fid, sha, mime, bytes: buf.length };
}

export function registerFileRoutes(router, db) {
  router.post('/api/v1/files', async (req, res) => { mustPerm(req, 'files.manage'); requireApiScope(req, 'write'); const body = await readBody(req); const { fid, sha, bytes } = await storeFile(db, req, body, { kindDefault: 'DOCUMENT' }); created(res, present(q.one(db, `SELECT * FROM files WHERE id = ?`, fid))); });
  router.post('/api/v1/files/logo', async (req, res) => {
    mustPerm(req, 'branding.manage'); requireApiScope(req, 'write');
    const body = await readBody(req);
    body.kind = reqOneOf(body.kind || 'LOGO', 'kind', ['LOGO', 'RECEIPT_LOGO']);
    const { fid } = await storeFile(db, req, body, { kindDefault: 'LOGO', auditAction: 'branding.logo.upload' });
    q.run(db, `UPDATE tenant_branding SET logo_file_id = ?, updated_at = ? WHERE tenant_id = ?`, fid, nowIso(), req.tenantId);
    created(res, present(q.one(db, `SELECT * FROM files WHERE id = ?`, fid)));
  });
  router.get('/api/v1/files', (req, res) => {
    mustPerm(req, 'files.view');
    const kind = optStr(req.query.kind, 'kind');
    const rows = q.all(db, `SELECT id, tenant_id, tenant_code, kind, name, mime, bytes, sha256, width, height, created_at, created_by FROM files
      WHERE tenant_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY created_at DESC LIMIT 200`, ...(kind ? [req.tenantId, kind] : [req.tenantId]));
    ok(res, rows.map(r => present(r)));
  });
  router.get('/api/v1/files/:id/raw', (req, res) => serveRaw(db, req, res));
  router.get('/api/v1/files/:id/info', (req, res) => { mustPerm(req, 'files.view'); requireApiScope(req, 'read'); ok(res, present(findFile(db, req))); });
  router.get('/api/v1/files/:id', (req, res) => serveRaw(db, req, res));
  router.delete('/api/v1/files/:id', (req, res) => {
    mustPerm(req, 'files.manage'); requireApiScope(req, 'write');
    const f = findFile(db, req);
    q.run(db, `DELETE FROM files WHERE id = ?`, f.id);
    q.run(db, `UPDATE tenant_branding SET logo_file_id = NULL WHERE tenant_id = ? AND logo_file_id = ?`, req.tenantId, f.id);
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'file.delete', resource: 'file', resourceId: f.id, metadata: { name: f.name, kind: f.kind, bytes: f.bytes } });
    ok(res, { deleted: true });
  });
}

function findFile(db, req) {
  const f = q.one(db, `SELECT * FROM files WHERE id = ?`, req.params.id);
  if (!f || f.tenant_id !== req.tenantId) throw err.notFound('File not found');
  return f;
}
function serveRaw(db, req, res) {
  mustPerm(req, 'files.view'); requireApiScope(req, 'read');
  const f = findFile(db, req);
  const ifNone = req.headers['if-none-match'];
  const etag = `"${f.sha256}"`;
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('ETag', etag);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  if (ifNone && ifNone === etag) { res.writeHead(304); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.bytes });
  res.end(f.data);
}

export async function serveBrandLogo(db, req, res, tenantCode) {
  const row = q.one(db, `SELECT f.*, b.business_name AS tenant_name FROM files f
    JOIN tenant_branding b ON b.logo_file_id = f.id JOIN tenants t ON t.id = f.tenant_id
    WHERE t.code = ?`, tenantCode);
  if (!row) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } })); }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': row.bytes });
  res.end(row.data);
}
