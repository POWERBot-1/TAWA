# TAWA API Reference (v1)

> Generated from the registered route table (`server/routes/*.js`). Base URL: `/api/v1`.
> All responses use the envelope `{ "data": … }` on success and `{ "error": { "code", "message", "details?" } }` on failure.
> Money is always **integer minor units** (e.g. cents). Timestamps are ISO-8601 UTC.

## Cross-cutting rules

| Concern | Behaviour |
|---|---|
| Auth | `Authorization: Bearer <token>` from `POST /api/v1/auth/login` (HttpOnly cookie also set for browsers), or `x-api-key` for scoped API keys. |
| Tenancy | Resolved **exclusively** from the authenticated session/key. Client-supplied `tenant_id` is never trusted. |
| CSRF | Cookie-auth mutations require the `x-csrf-token` header returned at login. Bearer/API-key requests skip CSRF. Safe methods (GET/HEAD) are exempt. |
| Idempotency | Money-moving POSTs accept `idempotency_key`; replays return the original result. |
| Entitlements | Routes are gated by subscription plan (see `server/core/entitlements.js`); denials return `403 PLAN_UPGRADE_REQUIRED`. |
| RBAC | Route-level permission checks return `403 FORBIDDEN` with the required permission in `details`. |
| Rate limit | 600 req/min/IP globally, 20/min on `auth/login`; `429 RATE_LIMITED`. |
| Webhooks | `POST /api/v1/webhooks/:provider` require `x-tawa-signature` HMAC-SHA256 over `<ts>.<body>` with a 5-minute replay window. |
| Errors | `400 VALIDATION` · `401 UNAUTHORIZED` · `403 FORBIDDEN / PLAN_UPGRADE_REQUIRED / TENANT_RESTRICTED` · `404 NOT_FOUND` · `409 CONFLICT / IDEMPOTENT_REPLAY` · `429 RATE_LIMITED` |

## System endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness (no auth). |
| GET | `/ready` | Readiness: DB up + tenant count (no auth). |
| GET | `/api/v1/meta` | Product/module descriptor (public, non-sensitive). |

## Platform Control Plane — `server/routes/admin.js`

| Method | Path |
|---|---|
| GET | `/api/v1/admin/overview` |
| GET | `/api/v1/admin/tenants` |
| POST | `/api/v1/admin/tenants/:id/plan` |
| POST | `/api/v1/admin/tenants/:id/status` |
| POST | `/api/v1/admin/tenants` |
| GET | `/api/v1/admin/audit` |
| GET | `/api/v1/admin/integrity` |
| GET | `/api/v1/admin/usage` |
| GET | `/api/v1/admin/events` |
| GET | `/api/v1/admin/events/dlq` |

## Catalog, Products & Pricing — `server/routes/catalog.js`

| Method | Path |
|---|---|
| GET | `/api/v1/units` |
| GET | `/api/v1/categories` |
| POST | `/api/v1/categories` |
| GET | `/api/v1/products` |
| GET | `/api/v1/products/:id` |
| POST | `/api/v1/products` |
| PATCH | `/api/v1/products/:id` |
| GET | `/api/v1/products/:id/relations` |
| POST | `/api/v1/products/:id/relations` |
| GET | `/api/v1/synonyms` |
| POST | `/api/v1/synonyms` |

## Communications & Notifications — `server/routes/comms.js`

| Method | Path |
|---|---|
| GET | `/api/v1/notifications` |
| POST | `/api/v1/notifications/:id/read` |
| GET | `/api/v1/notifications/outbound` |
| GET | `/api/v1/alerts/rules` |
| POST | `/api/v1/alerts/rules` |
| PATCH | `/api/v1/alerts/rules/:id` |
| GET | `/api/v1/automation/rules` |
| POST | `/api/v1/automation/rules` |
| GET | `/api/v1/marketing/campaigns` |
| POST | `/api/v1/marketing/campaigns` |
| POST | `/api/v1/marketing/campaigns/:id/approve` |
| POST | `/api/v1/marketing/campaigns/:id/send` |
| GET | `/api/v1/marketing/promotions` |
| POST | `/api/v1/marketing/promotions` |
| POST | `/api/v1/marketing/promotions/evaluate` |
| GET | `/api/v1/marketing/loyalty` |
| GET | `/api/v1/autopay/rules` |
| POST | `/api/v1/autopay/rules` |
| POST | `/api/v1/autopay/rules/:id/toggle` |
| GET | `/api/v1/notification-config` |
| PUT | `/api/v1/notification-config` |

## files — `server/routes/files.js`

| Method | Path |
|---|---|
| POST | `/api/v1/files` |
| POST | `/api/v1/files/logo` |
| GET | `/api/v1/files` |
| GET | `/api/v1/files/:id/raw` |
| GET | `/api/v1/files/:id/info` |
| GET | `/api/v1/files/:id` |
| DELETE | `/api/v1/files/:id` |

## Identity, Auth & Users — `server/routes/identity.js`

| Method | Path |
|---|---|
| GET | `/api/v1/brand` |
| GET | `/api/v1/public/tenants` |
| POST | `/api/v1/auth/login` |
| POST | `/api/v1/auth/logout` |
| GET | `/api/v1/auth/me` |
| POST | `/api/v1/auth/change-password` |
| GET | `/api/v1/users` |
| POST | `/api/v1/users` |
| PATCH | `/api/v1/users/:id` |
| GET | `/api/v1/roles` |
| GET | `/api/v1/public/plans` |
| POST | `/api/v1/public/signup` |
| GET | `/api/v1/onboarding` |
| PUT | `/api/v1/onboarding` |

## Dashboard, Analytics, AI, Reports, Search — `server/routes/intel.js`

| Method | Path |
|---|---|
| GET | `/api/v1/dashboard` |
| GET | `/api/v1/ai/insights` |
| POST | `/api/v1/ai/ask` |
| GET | `/api/v1/ai/reorder` |
| GET | `/api/v1/ai/log` |
| GET | `/api/v1/analytics/overview` |
| GET | `/api/v1/ai/status` |
| GET | `/api/v1/ai/status/outcomes` |
| GET | `/api/v1/reports/:name` |
| GET | `/api/v1/search/tenant-scope` |
| GET | `/api/v1/search` |

## Inventory & Warehouses — `server/routes/inventory.js`

| Method | Path |
|---|---|
| GET | `/api/v1/branches` |
| POST | `/api/v1/branches` |
| GET | `/api/v1/warehouses` |
| POST | `/api/v1/warehouses` |
| GET | `/api/v1/inventory/levels` |
| GET | `/api/v1/inventory/valuation` |
| GET | `/api/v1/inventory/movements` |
| POST | `/api/v1/inventory/receive` |
| POST | `/api/v1/inventory/adjust` |
| POST | `/api/v1/inventory/transfer` |

## keys — `server/routes/keys.js`

| Method | Path |
|---|---|
| GET | `/api/v1/api-keys` |
| POST | `/api/v1/api-keys` |
| POST | `/api/v1/api-keys/:id/revoke` |
| DELETE | `/api/v1/api-keys/:id` |

## Deliveries & Logistics — `server/routes/logistics.js`

| Method | Path |
|---|---|
| GET | `/api/v1/deliveries` |
| POST | `/api/v1/deliveries` |
| POST | `/api/v1/deliveries/:id/assign` |
| POST | `/api/v1/deliveries/:id/advance` |
| POST | `/api/v1/deliveries/:id/complete` |
| POST | `/api/v1/deliveries/:id/send-otp` |

## Money: Expenses, Petty Cash, Accounting — `server/routes/money.js`

| Method | Path |
|---|---|
| GET | `/api/v1/expenses` |
| POST | `/api/v1/expenses` |
| POST | `/api/v1/expenses/:id/approve` |
| POST | `/api/v1/expenses/:id/reject` |
| POST | `/api/v1/expenses/:id/pay` |
| GET | `/api/v1/accounting/accounts` |
| GET | `/api/v1/accounting/journal` |
| GET | `/api/v1/accounting/trial-balance` |
| GET | `/api/v1/accounting/pnl` |
| GET | `/api/v1/accounting/balance-sheet` |
| GET | `/api/v1/accounting/integrity` |
| GET | `/api/v1/accounting/journal.csv` |
| GET | `/api/v1/accounting/reconcile` |

## Payments & Webhooks — `server/routes/payments.js`

| Method | Path |
|---|---|
| GET | `/api/v1/payments/intents` |
| POST | `/api/v1/payments/intents` |
| POST | `/api/v1/payments/intents/:id/initiate` |
| POST | `/api/v1/payments/intents/:id/verify` |
| POST | `/api/v1/payments/intents/:id/confirm-cash` |
| POST | `/api/v1/payments/intents/:id/confirm-bank` |
| GET | `/api/v1/payments` |
| POST | `/api/v1/payments/:id/refund` |
| GET | `/api/v1/payments/reconcile` |
| GET | `/api/v1/payments/providers` |
| POST | `/api/v1/webhooks/payments/:provider` |
| POST | `/api/v1/sandbox/mpesa/outcome` |

## Procurement (PO / GRN / Bills) — `server/routes/procurement.js`

| Method | Path |
|---|---|
| GET | `/api/v1/procurement/requisitions` |
| POST | `/api/v1/procurement/requisitions` |
| POST | `/api/v1/procurement/requisitions/:id/approve` |
| POST | `/api/v1/procurement/requisitions/:id/reject` |
| GET | `/api/v1/procurement/pos` |
| GET | `/api/v1/procurement/pos/:id` |
| POST | `/api/v1/procurement/pos` |
| POST | `/api/v1/procurement/pos/:id/approve` |
| POST | `/api/v1/procurement/pos/:id/send` |
| POST | `/api/v1/procurement/pos/:id/receive` |
| GET | `/api/v1/procurement/pos/:id/document` |
| GET | `/api/v1/procurement/invoices` |
| POST | `/api/v1/procurement/invoices` |
| POST | `/api/v1/procurement/invoices/:id/pay` |

## Customers, Suppliers & Brokers — `server/routes/relationships.js`

| Method | Path |
|---|---|
| GET | `/api/v1/customers` |
| GET | `/api/v1/customers/segments` |
| GET | `/api/v1/customers/:id` |
| POST | `/api/v1/customers` |
| PATCH | `/api/v1/customers/:id` |
| GET | `/api/v1/customers/segment/:name/export` |
| GET | `/api/v1/credit/accounts` |
| GET | `/api/v1/credit/accounts/:customerId` |
| POST | `/api/v1/credit/accounts` |
| POST | `/api/v1/credit/accounts/:customerId/pay` |
| GET | `/api/v1/suppliers` |
| GET | `/api/v1/suppliers/:id` |
| POST | `/api/v1/suppliers` |
| GET | `/api/v1/brokers` |
| POST | `/api/v1/brokers` |
| GET | `/api/v1/brokers/:id` |
| POST | `/api/v1/brokers/:id/leads` |
| POST | `/api/v1/leads/:id/convert` |
| POST | `/api/v1/commissions/:id/approve` |
| POST | `/api/v1/commissions/:id/pay` |

## Sales: POS, Quotes, Orders, Invoices — `server/routes/sales.js`

| Method | Path |
|---|---|
| GET | `/api/v1/quotes` |
| GET | `/api/v1/quotes/:id` |
| POST | `/api/v1/quotes` |
| POST | `/api/v1/quotes/:id/send` |
| POST | `/api/v1/quotes/:id/accept` |
| POST | `/api/v1/quotes/:id/reject` |
| POST | `/api/v1/quotes/:id/convert` |
| GET | `/api/v1/quotes/:id/document` |
| GET | `/api/v1/orders` |
| GET | `/api/v1/orders/:id` |
| POST | `/api/v1/orders` |
| POST | `/api/v1/orders/:id/fulfil` |
| POST | `/api/v1/orders/:id/cancel` |
| GET | `/api/v1/orders/:id/invoice` |
| POST | `/api/v1/pos/sale` |
| POST | `/api/v1/pos/complete` |
| GET | `/api/v1/receipts/:paymentId` |
| GET | `/api/v1/deliveries/:id/note` |
| GET | `/api/v1/sales/today` |

## Tenant Settings, White-Label & Domains — `server/routes/settings.js`

| Method | Path |
|---|---|
| GET | `/api/v1/settings/branding` |
| PUT | `/api/v1/settings/branding` |
| GET | `/api/v1/settings/flags` |
| PUT | `/api/v1/settings/flags` |
| GET | `/api/v1/billing/subscription` |
| GET | `/api/v1/billing/matrix` |
| POST | `/api/v1/billing/change-plan` |
| GET | `/api/v1/integrations` |
| GET | `/api/v1/audit` |
| GET | `/api/v1/settings/tenant` |
| PATCH | `/api/v1/settings/tenant` |
| POST | `/api/v1/settings/domains` |
| GET | `/api/v1/settings/payment-config` |
| PUT | `/api/v1/settings/payment-config/:provider` |
| POST | `/api/v1/settings/payment-config/:provider/test` |
| GET | `/api/v1/settings/export` |
| GET | `/api/v1/settings/backup` |

## Workforce, Attendance & Payroll — `server/routes/workforce.js`

| Method | Path |
|---|---|
| GET | `/api/v1/workers` |
| POST | `/api/v1/workers` |
| GET | `/api/v1/workers/:id/performance` |
| POST | `/api/v1/workers/:id/attendance` |
| GET | `/api/v1/tasks` |
| POST | `/api/v1/tasks` |
| POST | `/api/v1/tasks/:id/transition` |
| GET | `/api/v1/payroll/runs` |
| POST | `/api/v1/payroll/calculate` |
| POST | `/api/v1/payroll/runs/:id/review` |
| POST | `/api/v1/payroll/runs/:id/approve` |
| POST | `/api/v1/payroll/runs/:id/execute` |

---

_201 routes across 16 modules. Source of truth: the route registrations themselves._
