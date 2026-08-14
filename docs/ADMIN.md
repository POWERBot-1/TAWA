# TAWA Platform Administration

Platform plane: `/api/v1/admin/*` — sessions with `tenant_id IS NULL` only. Demo login:
`platform@tawa.app / Admin#2026!` (only exists in seeded environments).

## Control centre tabs

- **Overview** — tenant counts, today's orders/payments, monthly AI/message usage, event queue size.
- **Tenants** — every tenant with plan, status, users/orders/products; actions: **Suspend** (402 wall),
  **Restrict** (read-only), **Restore**, **Plan** (upgrade/downgrade, immediate effect), **Provision**.
- **Usage** — per-tenant meters (orders, ai_requests, messages_sent, api_calls, …) billed against plans.
- **Integrity** — per-tenant ledger verification + mutation-guard status.

## Provisioning a tenant (no code changes)

Control centre → Provision tenant → `{code, name, plan, owner…}` → `provisionTenant()` creates, atomically:
tenant row + branding + domain + subscription(TRIAL 14d) + license + chart of accounts + 13 role templates
+ loyalty tiers + feature flags + owner with OWNER role.

Self-service alternative: `POST /api/v1/public/signup` (rate-limited) does the same and additionally
seeds HQ branch, Main Store warehouse, default `config_keys`, and `pos_settings` — ready-to-trade on
first login; `/api/v1/onboarding` tracks the wizard.

## Lifecycle semantics

| Status | Reads | Writes | Data |
|---|---|---|---|
| TRIAL / ACTIVE / GRACE | ✓ | ✓ | intact |
| RESTRICTED | ✓ | ✗ (402) | intact |
| SUSPENDED / EXPIRED / CANCELLED | ✗ (402) | ✗ (402) | intact |

Status changes sync `tenants.status`, `subscriptions.status`, `licenses.state` and are audit-logged
with from/to + operator identity.

## Events / DLQ

`GET /api/v1/admin/events` — latest queue rows. `GET /api/v1/admin/events/dlq` — failed deliveries
(attempts ≥ 3). Requeue by flipping `status` back to `PENDING` in the DB (dispatcher picks it up).

## Hardening checklist for production

1. Set `TAWA_ADMIN_BOOTSTRAP_SECRET`; send `x-tawa-internal` from admin clients.
2. Terminate TLS at a proxy that strips inbound `X-Forwarded-For`.
3. `TAWA_COOKIE_SECURE=1`.
4. Rotate webhook secrets (`TAWA_WEBHOOK_SECRET_*`).
5. Schedule `scripts/backup.js` (it refuses to claim success without a restore verification pass).
