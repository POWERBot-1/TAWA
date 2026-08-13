#!/usr/bin/env node
/**
 * TAWA — API reference generator.
 * Derives docs/API.md directly from the registered route table so the
 * documentation can never drift from the implementation.
 *
 *   node scripts/gen-api-docs.js
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const dir = path.join(ROOT, 'server/routes');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

const TITLES = {
  identity: 'Identity, Auth & Users', catalog: 'Catalog, Products & Pricing', inventory: 'Inventory & Warehouses',
  sales: 'Sales: POS, Quotes, Orders, Invoices', payments: 'Payments & Webhooks', relationships: 'Customers, Suppliers & Brokers',
  procurement: 'Procurement (PO / GRN / Bills)', workforce: 'Workforce, Attendance & Payroll', logistics: 'Deliveries & Logistics',
  money: 'Money: Expenses, Petty Cash, Accounting', comms: 'Communications & Notifications', intel: 'Dashboard, Analytics, AI, Reports, Search',
  settings: 'Tenant Settings, White-Label & Domains', admin: 'Platform Control Plane',
};

let md = `# TAWA API Reference (v1)

> Generated from the registered route table (\`server/routes/*.js\`). Base URL: \`/api/v1\`.
> All responses use the envelope \`{ "data": … }\` on success and \`{ "error": { "code", "message", "details?" } }\` on failure.
> Money is always **integer minor units** (e.g. cents). Timestamps are ISO-8601 UTC.

## Cross-cutting rules

| Concern | Behaviour |
|---|---|
| Auth | \`Authorization: Bearer <token>\` from \`POST /api/v1/auth/login\` (HttpOnly cookie also set for browsers), or \`x-api-key\` for scoped API keys. |
| Tenancy | Resolved **exclusively** from the authenticated session/key. Client-supplied \`tenant_id\` is never trusted. |
| CSRF | Cookie-auth mutations require the \`x-csrf-token\` header returned at login. Bearer/API-key requests skip CSRF. Safe methods (GET/HEAD) are exempt. |
| Idempotency | Money-moving POSTs accept \`idempotency_key\`; replays return the original result. |
| Entitlements | Routes are gated by subscription plan (see \`server/core/entitlements.js\`); denials return \`403 PLAN_UPGRADE_REQUIRED\`. |
| RBAC | Route-level permission checks return \`403 FORBIDDEN\` with the required permission in \`details\`. |
| Rate limit | 600 req/min/IP globally, 20/min on \`auth/login\`; \`429 RATE_LIMITED\`. |
| Webhooks | \`POST /api/v1/webhooks/:provider\` require \`x-tawa-signature\` HMAC-SHA256 over \`<ts>.<body>\` with a 5-minute replay window. |
| Errors | \`400 VALIDATION\` · \`401 UNAUTHORIZED\` · \`403 FORBIDDEN / PLAN_UPGRADE_REQUIRED / TENANT_RESTRICTED\` · \`404 NOT_FOUND\` · \`409 CONFLICT / IDEMPOTENT_REPLAY\` · \`429 RATE_LIMITED\` |

## System endpoints

| Method | Path | Notes |
|---|---|---|
| GET | \`/health\` | Liveness (no auth). |
| GET | \`/ready\` | Readiness: DB up + tenant count (no auth). |
| GET | \`/api/v1/meta\` | Product/module descriptor (public, non-sensitive). |

`;

let total = 0;
for (const f of files) {
  const name = f.replace('.js', '');
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)]
    .map(m => [m[1].toUpperCase(), m[2]]);
  total += routes.length;
  md += `## ${TITLES[name] || name} — \`server/routes/${f}\`\n\n| Method | Path |\n|---|---|\n`;
  for (const [m, p] of routes) md += `| ${m} | \`${p}\` |\n`;
  md += '\n';
}
md += `---\n\n_${total} routes across ${files.length} modules. Source of truth: the route registrations themselves._\n`;
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/API.md'), md);
console.log('docs/API.md written —', total, 'routes,', files.length, 'modules,', md.length, 'bytes');
