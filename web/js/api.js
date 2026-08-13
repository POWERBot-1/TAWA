/**
 * API client — same-origin, bearer + CSRF, normalised envelope.
 * NEVER calls localhost; the SPA is served by the API itself.
 */
import { store } from './store.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

async function request(method, path, body, opts = {}) {
  const headers = { 'Accept': 'application/json', ...(opts.headers || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const sess = store.session;
  if (sess?.token) headers['Authorization'] = `Bearer ${sess.token}`;
  if (sess?.csrf) headers['X-TAWA-CSRF'] = sess.csrf;
  let url = path;
  if (opts.params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params)) if (v !== undefined && v !== null && v !== '') sp.set(k, v);
    const qs = sp.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network unreachable. Check your connection.');
  }
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const e = json?.error || {};
    if (res.status === 401 && !path.includes('/auth/login')) store.expire();
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details);
  }
  return json?.data !== undefined ? json.data : json;
}

export const api = {
  get: (p, params) => request('GET', p, undefined, { params }),
  post: (p, body, opts) => request('POST', p, body ?? {}, opts),
  put: (p, body) => request('PUT', p, body ?? {}),
  patch: (p, body) => request('PATCH', p, body ?? {}),
  del: (p) => request('DELETE', p),
  sandbox: (p, body) => request('POST', p, body ?? {}, { headers: { 'X-Sandbox-Mode': '1' } }),
};

/** Download a CSV/text endpoint with auth headers. */
export async function downloadFile(path, filename) {
  const headers = {};
  const sess = store.session;
  if (sess?.token) headers['Authorization'] = `Bearer ${sess.token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD', `Download failed (${res.status})`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
