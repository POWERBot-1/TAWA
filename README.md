# TAWA — Multi-Tenant Hardware Business Operating System

**One product → many hardware businesses.** TAWA is a commercial-grade, multi-tenant SaaS platform
for hardware/building-supplies retail: POS, inventory, procurement, customers & credit, suppliers &
brokers, workforce & payroll, deliveries, marketing & SMS, payments, accounting, analytics, and a
governed AI assistant — each tenant fully isolated, subscription-gated, and white-labeled.

Stack: **zero-dependency Node.js (≥22.5) backend** (`node:http`, `node:sqlite`) + a **no-build ES-module
SPA**. One process serves API + UI. Data lives in a single SQLite file (WAL). Docker optional.

```
┌──────────────────────────────────────────────────────────────────┐
│ TAWA PRODUCT (one codebase, one deployment)                      │
│  platform control plane · auth · RBAC · entitlements · metering  │
├───────────────┬───────────────────┬──────────────────────────────┤
│ ALPHA HARDWARE│ BUILDPRO SUPPLIES │ KILIMANI BUILDERS · tenant N │
│ own data/users/customers/payments/branding/plan/AI context       │
└───────────────┴───────────────────┴──────────────────────────────┘
```

---

## 1. Quick start

### Local (Node ≥ 22.5)

```bash
git clone <repo> && cd TAWA
npm start          # http://localhost:8080  (migrates the DB automatically)
# first run with demo world:
node server/index.js --seed
```

### Docker

```bash
docker build -t tawa .
docker run -p 8080:8080 -v tawa-data:/data tawa            # demo tenants seeded on empty DB
# or
docker compose up --build
```

`docker run … -e TAWA_ENV=production tawa node server/index.js` starts **without** demo data.

### Verification

```bash
npm test           # 43 checks — invariants, acceptance, commercial multi-tenancy
npm run validate   # build validator: syntax, migrations idempotency, RBAC, tenancy, POS smoke
npm run package    # reproducible tarball + SHA-256 manifest into out/
```

---

## 2. Demo credentials (after `--seed`)

| Tenant | Plan | Login (owner) | Password | Notes |
|---|---|---|---|---|
| Platform control plane | — | `platform@tawa.app` | `Admin#2026!` | tenant management, plans, usage, integrity |
| ALPHA HARDWARE | BUSINESS | `owner@alpha-hardware.co.ke` | `Alpha#2026!` | full TAWA-branded workspace |
| BUILDPRO SUPPLIES | PROFESSIONAL | `owner@buildpro.co.ke` | `Build#2026!` | white-labeled tenant |
| KILIMANI BUILDERS | STARTER | `owner@kilimani-builders.co.ke` | `Kilimani#2026!` | white-labeled, lean plan |

Each tenant also has `manager@`, `cashier@`, `keeper@`, `finance@`, `sales@`, `hr@` + its own domain —
same password as the owner — so you can feel role-based access differences immediately.

**Try this:** open two browser profiles side by side, log into ALPHA and KILIMANI — different brand
colors, products, customers, orders, staff, plan features. Nothing leaks across. Then log into the
platform plane and suspend KILIMANI: its workspace flips to a payment-required state while ALPHA is
untouched. Restore it and trading resumes.

---

## 3. What a tenant gets

| Area | Capability |
|---|---|
| Commerce | POS (offline-safe idempotent checkout, receipts), quotes → orders, price lists (retail/wholesale/contractor), layaway & credit sales |
| Inventory | Multi-branch warehouses, immutable stock movements, reservations, transfers, counts, reorder points, valuation |
| Procurement | Requisitions → POs → GRN (3-way match) → supplier bills → payments |
| Money | Double-entry ledger (journal per event), chart of accounts, P&L / balance sheet / trial balance, expenses with approval flow, refunds ≤ capture |
| Payments | Intent → provider → verify-server-side → settle → reconcile. M-Pesa/card/bank via **sandbox adapters** (honest: labeled sandbox everywhere; real credentials wire into the same seam) |
| Relationships | Customers (segments, loyalty, credit accounts & statements), suppliers (scorecards), brokers (leads, commissions with clawback) |
| Workforce | Workers, attendance, tasks/verification, payroll with review/approve/execute segregation of duties |
| Logistics | Deliveries with OTP proof-of-delivery, driver feed, status events |
| Growth | Campaigns with consent gates, promotions, per-tenant SMS config, in-app + outbound notifications |
| Intelligence | Deterministic AI copilot (READ/ANALYSE/RECOMMEND/PREPARE — never EXECUTE), insights, reorder engine, anomaly flags, explainable answers |
| Platform | Tenant provisioning (no code changes), plans & entitlements, usage metering, suspension lifecycle, audit, backups, exports, API keys |

## 4. Architecture in one paragraph

`server/index.js` boots: run migrations (idempotent, numbered SQL) → optionally seed → `buildApp(db)`.
Every `/api/v1/*` request flows: rate-limit → request-id → `resolveAuth` (bearer|cookie|api-key) →
CSRF (cookie mutations) → `tenancyMiddleware` (**tenant resolved from the session only — client-supplied
tenant ids are never trusted; unknown context fails closed**) → entitlement gate → route → module
(transactions via `tx()`, events via `emitEvent`, audit via `audit`). Read [`ARCHITECTURE.md`](ARCHITECTURE.md)
and [`docs/API.md`](docs/API.md) (generated from the route table).

## 5. Security model (summary)

- **Isolation**: every business table carries `tenant_id`; middleware stamps context; queries are
  tenant-clamped; line-item tables got physical `tenant_id` + propagation triggers (migration 007).
- **Sessions**: scrypt password hashing, opaque bearer tokens + HttpOnly cookie, server-side revocation,
  8-failure lockout, login rate limiting per IP.
- **API keys** (§66): `tawa_…` keys, SHA-256 at rest, scopes (`read/write/reports/webhooks`), expiry,
  instant revocation, tenant-bound, metered (`api_calls`).
- **Webhooks**: HMAC-SHA256 over `<ts>.<body>`, 5-minute replay window, constant-time compare.
- **Files**: tenant-namespaced blob store, MIME sniffing, dimension caps, SVG script stripping.
- **Audit**: append-only (DB triggers forbid UPDATE/DELETE), tenant-tagged, control-plane visible.
- Details: [`docs/SECURITY.md`](docs/SECURITY.md).

## 6. Configuration & deployment

All configuration is env-based (`.env.example`): `PORT`, `HOST`, `TAWA_DATA_DIR`, `TAWA_ENV`,
session TTL, webhook secrets, optional control-plane bootstrap header. One build step: none.
One process model: API+SPA. Horizontal scaling path = Postgres adapter seam + external queue
(the module seams are written for this); single-node comfortably serves an SME tenant estate.

Backups: `node scripts/backup.js` (VACUUM-based, restore-verified with a tenant-boundary leak check).
Tenant-level export/backup: Settings → Data & API (or `GET /api/v1/settings/export`, `/backup`).

## 7. JATA Qi / Forge posture

TAWA is built JATA-Qi-native: identity, billing, subscriptions, and entitlement checks bind to the
Qi control plane in production; in this environment those seams run as **explicitly-labeled sandbox
adapters** (payments, messaging) with local enforcement engines (entitlements, metering, audit).
`product.manifest.json` is the machine-readable Forge product definition (modules, entitlements,
permissions, billing items, configuration schema, deployment requirements).

## 8. Repository map

```
server/            zero-dep backend (core, modules, routes, adapters, db, seed)
web/               no-build SPA (router, ui kit, 26 pages, icons, tokens)
tests/             invariants + acceptance + commercial multi-tenancy suites
scripts/           validate · package · backup · gen-api-docs
docs/              API.md (generated) · SECURITY.md · ADMIN.md · AUDIT.md
Dockerfile  docker-compose.yml  .env.example  product.manifest.json
```

Status: see docs/AUDIT.md for the full §1–88 implementation audit and the readiness classification.
