# TAWA Security Notes

## Tenant isolation enforcement points

1. **Middleware** (`core/tenancy.js`): session-derived tenant only. Client `tenant_id` (param/header/body) is ignored — the query-param pivot is covered by test `fail-closed` in `tests/commercial.test.js`.
2. **Query layer**: handlers bind `req.tenantId` into WHERE clauses; foreign ids return 404 (not 403) to avoid object-existence leaks.
3. **Storage layer**: migration 007 adds `tenant_id` + propagation triggers to line-item tables; `usage_events`/`api_calls` tenant-stamped; `files` carry `tenant_id` + `tenant_code`.
4. **Tests**: `tests/commercial.test.js` proves read/write/delete/search/file/notification/AI/payment-config/export isolation between live tenants A and B; `tests/invariants.test.js` §58-series cover ledger/audit immutability and session revocation.

## AuthN/AuthZ

- Passwords: scrypt (N=16384) + per-user salt, constant-time compare. Policy: ≥10 chars, upper+digit
  (public signup enforces; staff creation uses admin-set temp passwords, also policy-checked).
- Sessions: opaque 256-bit bearer tokens; HttpOnly `tawa_session` cookie for browsers; server-side
  revocation (`/auth/logout`, password change, admin user suspension); 8 failed logins lock the account.
- CSRF: cookie-authenticated mutations require `X-TAWA-CSRF` matching the session. Bearer/API-key calls are exempt (no ambient credential).
- RBAC: 13 role templates, ~80 granular permissions, enforced per route via `mustPerm`. Owner/Admin/Branch-Manager/Store-Manager derive from a least-privilege-minus model.
- API keys: `tawa_*`, sha-256 stored, scopes→permission mapping with a hard deny-list for sensitive
  actions (`users.manage`, `roles.manage`, `apikeys.manage`, `billing.manage`, `integrations.manage`,
  `branding.manage`, `audit.view`), instant revocation, per-key last-used + usage metering.

## Payments

- Providers are adapters (sandbox in this environment, clearly labeled). Webhooks verify
  `x-tawa-signature` = HMAC-SHA256(`<ts>.<body>`, per-provider secret) with a 5-minute timestamp window;
  unknown/failed intents never settle. Partial/overpaid cash confirmations are rejected.
- A tenant can disable any provider (`settings/payment-config`); `createIntent` then fails closed for
  every flow (POS, AR, credit) — verified by test.

## Rate limiting

Global 600 req/min per IP;login 20/min per IP; API keys are independently metered (`api_calls`).
**Deployment caveat:** `clientIp` trusts `X-Forwarded-For`. Expose TAWA only behind a proxy that
strips client-supplied XFF (or set your proxy to append). Do not expose the node process directly to
untrusted networks without that proxy behavior.

## Headers / transport

Security headers set by the static server (CSP deny-by-default for raw file serve, `X-Content-Type-Options`,
frame-ancestors). TLS terminates at your proxy/Ingress in production; set `TAWA_COOKIE_SECURE=1` so
session cookies are `Secure` + `SameSite=Lax`.

## Admin surface

`/api/v1/admin/*` requires platform sessions (tenant NULL). Set `TAWA_ADMIN_BOOTSTRAP_SECRET` to additionally
require the `x-tawa-internal` header — recommended on any internet-reachable deployment.

## Data lifecycle

Suspension never deletes data. Tenant export/backup are tenant-scoped and exclude stored provider
credentials. Platform backups (`scripts/backup.js`) are restore-verified with a tenant-boundary leak scan.
