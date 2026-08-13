import crypto from 'node:crypto';

/** API error with stable code + http status. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const err = {
  badRequest: (m, d) => new ApiError(400, 'BAD_REQUEST', m, d),
  unauthorized: (m = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', m),
  forbidden: (m = 'Permission denied') => new ApiError(403, 'FORBIDDEN', m),
  tenantRestricted: (m = 'Tenant access is restricted by subscription status') => new ApiError(402, 'TENANT_RESTRICTED', m),
  notFound: (m = 'Not found') => new ApiError(404, 'NOT_FOUND', m),
  conflict: (m, d) => new ApiError(409, 'CONFLICT', m, d),
  unprocessable: (m, d) => new ApiError(422, 'VALIDATION_FAILED', m, d),
  tooMany: () => new ApiError(429, 'RATE_LIMITED', 'Too many requests'),
  unsupported: (m) => new ApiError(400, 'UNSUPPORTED', m),
};

/**
 * Tiny pattern router: /api/v1/products/:id — params, middleware chain.
 */
export class Router {
  constructor() { this.routes = []; this.middlewares = []; }
  use(fn) { this.middlewares.push(fn); return this; }
  add(method, pattern, ...fns) {
    const keys = [];
    pattern.split('/').forEach(seg => { if (seg.startsWith(':')) keys.push(seg.slice(1)); });
    const regex = new RegExp('^' + pattern.split('/').map(seg =>
      seg === '*' ? '.*' : seg.startsWith(':') ? '([^/]+)' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ).join('/') + '/?$');
    this.routes.push({ method, regex, keys, fns });
    return this;
  }
  get(p, ...f) { return this.add('GET', p, ...f); }
  post(p, ...f) { return this.add('POST', p, ...f); }
  put(p, ...f) { return this.add('PUT', p, ...f); }
  patch(p, ...f) { return this.add('PATCH', p, ...f); }
  delete(p, ...f) { return this.add('DELETE', p, ...f); }

  async handle(req, res) {
    const url = new URL(req.url, 'http://internal');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    req.query = Object.fromEntries(url.searchParams);
    req.path = pathname;
    let patternMatched = false;
    for (const route of this.routes) {
      const m = pathname.match(route.regex);
      if (!m) continue;
      patternMatched = true;
      if (route.method !== req.method) continue;
      req.params = {};
      route.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
      try {
        for (const mw of this.middlewares) {
          if (res.writableEnded) return;
          await mw(req, res);
        }
        if (res.writableEnded) return;
        for (const fn of route.fns) {
          if (res.writableEnded) return;
          await fn(req, res);
        }
        if (!res.writableEnded) this.notFound(req, res);
        return;
      } catch (e) { return this.onError(req, res, e); }
    }
    if (patternMatched) return this.onError(req, res, err.notFound('Method not allowed on this resource'));
    return this.notFound(req, res);
  }
  notFound(req, res) { send(res, 404, { error: { code: 'NOT_FOUND', message: 'Resource not found', path: req.path } }); }
  onError(req, res, e) {
    if (res.writableEnded) return;
    if (e instanceof ApiError) {
      return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
    }
    const cid = req.id || crypto.randomUUID();
    console.error(`[api ${cid}]`, e);
    return send(res, 500, { error: { code: 'INTERNAL', message: 'An unexpected error occurred', correlation_id: cid } });
  }
}

export function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function ok(res, data, meta) { send(res, 200, meta ? { data, meta } : { data }); }
export function created(res, data) { send(res, 201, { data }); }

/** Parse a JSON body with a hard size cap. */
export function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(err.badRequest('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      req.rawBody = raw;
      try { resolve(JSON.parse(raw)); } catch { reject(err.badRequest('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- Validation helpers ---------------- */
export const reqStr = (v, name, { min = 1, max = 400 } = {}) => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw err.unprocessable(`Field "${name}" is required and must be ${min}-${max} characters`);
  return v.trim();
};
export const optStr = (v, name, opts = {}) => (v === undefined || v === null || v === '') ? null : reqStr(v, name, opts);
export const reqNum = (v, name, { min = -1e15, max = 1e15 } = {}) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw err.unprocessable(`Field "${name}" must be a number between ${min} and ${max}`);
  return n;
};
export const reqMoney = (v, name) => Math.round(reqNum(v, name, { min: 0.001, max: 1e12 }) * 100);
export const reqOneOf = (v, name, allowed) => {
  if (!allowed.includes(v)) throw err.unprocessable(`Field "${name}" must be one of: ${allowed.join(', ')}`);
  return v;
};
export const reqArr = (v, name, { min = 1 } = {}) => {
  if (!Array.isArray(v) || v.length < min) throw err.unprocessable(`Field "${name}" must be an array with at least ${min} item(s)`);
  return v;
};
export const pageParams = (req) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
};
