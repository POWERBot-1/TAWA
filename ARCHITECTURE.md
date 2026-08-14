# TAWA Architecture

## 0. Design invariants

1. **One product, many tenants.** No customer forks, no per-customer builds. Tenant = configuration + data + entitlements + branding.
2. **Tenant context is server-derived.** `tenant_id` never comes from the client (headers, params, body are ignored for tenancy). Fail closed when ambiguous.
3. **Money is integers.** Minor units everywhere; format at the edge.
4. **Money never moves without idempotency.** Keys + replay windows + verified settlement.
5. **Entitlements are enforced server-side.** UI hides, server *denies*.
6. **Everything security-relevant is audited.** Append-only audit log (DB triggers).

## 1. Request pipeline

```
HTTP → rateLimit(ip) → request id → resolveAuth(bearer | cookie | x-api-key)
     → CSRF (cookie-auth mutations only)
     → tenancyMiddleware            # mustAuth → tenant row → status gate → entitlement gates
     → route handler → mustPerm(permission) → module (tx) → events/audit
     → uniform error envelope       # {error:{code,message,details?}}
```

`server/core/tenancy.js` is the choke point: `/api/v1/auth/*`, `/api/v1/brand`, `/api/v1/webhooks/*`,
`/api/v1/public/*`, `/api/v1/meta`, `/api/v1/admin/*` are the only allowlisted non-tenant paths;
everything else demands an authenticated, tenant-bound session. Tenant statuses map to access:
`SUSPENDED/EXPIRED/CANCELLED` → 402 both reads and writes; `RESTRICTED` → read-only;
`TRIAL/ACTIVE/GRACE` → full.

## 2. Module map

| Layer | Files | Responsibility |
|---|---|---|
| db | `db/connection.js` (q/tx/id), `db/migrate.js`, `db/migrations/001–007` | SQLite WAL, numbered idempotent migrations |
| core | `http.js` (router/envelope/validation), `auth.js` (sessions, scrypt, API keys, CSRF), `tenancy.js`, `rbac.js` (permissions + role templates), `entitlements.js` (plan matrix, gates, plan limits, metering), `audit.js`, `events.js` (queue) | Cross-cutting platform mechanics |
| modules | `ledger.js` (double-entry), `inventory.js` (immutable movements), `sales.js` (order lifecycle), `payments.js` (intent→verify→settle→reconcile), `payouts.js`, `ai.js` (deterministic copilot), `documents.js` (receipts/invoices HTML) | Business logic, framework-free |
| routes | 16 route files (201 endpoints) | Thin HTTP adapters: validate → authz → module → respond |
| adapters | `payments.js` (mpesa/card/cash sandbox + provider registry), `messaging.js` (sms/whatsapp sandbox) | External-world seams; sandbox labeled as sandbox |
| seed | `seed/seed.js`, `seed/catalog.js` | Deterministic 3-tenant demo world |

## 3. Data model (79 tables, 7 migrations)

- **Platform**: tenants, tenant_domains, tenant_branding, plans, entitlements, plan_entitlements,
  subscriptions, licenses, feature_flags, usage_counters, usage_events, audit_events, api_keys (platform-managed per-tenant).
- **Tenant business**: users/roles, branches/warehouses, catalog (products/categories/units/relations/synonyms),
  inventory (items/movements/reservations), commerce (quotes/orders/items/payments/refunds/credit),
  supply (suppliers/requisitions/POs/GRNs/bills), relationships (brokers/leads/commissions),
  workforce (workers/attendance/tasks/payroll), logistics (deliveries), growth (campaigns/promotions/notifications/rules),
  intel (insights/action log), files, config_keys, pos_settings, payments_config.
- **Line items** (`order_items`, `quote_items`, `po_items`) carry physical `tenant_id` (migration 007: column + backfill + insert-trigger propagation) — storage-layer defense in depth beyond join discipline.

Key invariants enforced in DB: `CHECK (tenant_id IS NOT NULL)` on business tables, UNIQUE per tenant on
SKUs/domains/idempotency keys, triggers forbidding UPDATE/DELETE on `audit_events` and `inventory_movements`.

## 4. Money flow (canonical)

```
POS/AR → createIntent(idempotency_key)        [payment_intents: CREATED]
      → initiate(provider)                    [PROCESSING + sandbox provider record]
      → verify | confirm-cash/bank            [server-side amount + status check]
      → settleVerifiedPayment                 [tx: payment row + ledger journal + order PAID + event + notification]
      → reconcile()                           [intents vs payments vs journals — nightly & on demand]
Refunds: amount ≤ captured, negative ledger entries, audit. Payouts: expenses/supplier bills via payouts module.
```

## 5. Authorization decision (per request)

`user ∈ tenant ∧ tenant.status allows ∧ role grants permission ∧ plan includes entitlement` —
evaluated in that order; any failure denies. Platform plane (`/api/v1/admin/*`) requires a session with
`tenant_id IS NULL` and, when `TAWA_ADMIN_BOOTSTRAP_SECRET` is set, an additional internal header.

## 6. Events & jobs

`emitEvent` writes tenant-stamped rows to `events` (type, tenant_id, payload, status, attempts). The
dispatcher processes per-tenant; failures retry with attempts++; `attempts ≥ 3` land in the DLQ view
(`GET /api/v1/admin/events/dlq`). No event crosses tenants by construction (tenant_id on the row; handlers
require tenant context).

## 7. Web / SPA

No build step. `web/` is static ES modules served by the API (`index.html` fallback for client routes).
Design tokens (`css/tokens.css`) are brand-parameterized at runtime (`--brand` etc. from
`tenant_branding`), so white-labeling is pure data. Icons are hand-drawn stroke SVG (`js/icons.js`).
Pages are lazy-imported by `js/router.js` with per-route permission/entitlement metadata; denied routes
render lock screens *and* the server would deny the APIs anyway.

## 8. Scaling path

Single-node SQLite is the SME profile (WAL, one writer). The seams for the 10k-tenant profile:
Postgres flavor of `q/tx` behind the same interface; `events` → external queue; blob files → object
storage keyed `tenant/{id}/…`; APM via the request-id/correlation hooks already in the error path.
Nothing in tenant code changes.
