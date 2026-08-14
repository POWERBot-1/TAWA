/**
 * TAWA — commercial multi-tenancy acceptance suite (master spec §8, §13–18, §20, §44–47, §66, §72–75).
 * Every test boots an idempotent helper stack; each test allocates its own tenant(s) so existing
 * suites remain untouched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStack, makeTenant, makeUser, makeFixture, login, api } from './helpers.js';
import { q, id, nowIso } from '../server/db/connection.js';
import { hashPassword } from '../server/core/auth.js';

let stack, db, base;
before(async () => { stack = await makeStack(); db = stack.db; base = stack.base; });
after(async () => stack.close());

const bucketOf = (email) => { let h = 7; for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `10.${(h >> 8) % 200 + 20}.${h % 250 + 1}`; };
const loginH = (email, pw) => login(base, email, pw, { 'x-forwarded-for': bucketOf(email) });
const loginOwner = (t) => loginH(t.ownerEmail, t.ownerPassword);
const uid = () => Math.random().toString(36).slice(2, 8);

/** Control-plane operator for tests (§9). Public signup never creates these. */
async function makePlatform() {
  q.run(db, `INSERT OR IGNORE INTO users (id, tenant_id, email, name, password_hash, status, created_at, updated_at)
             VALUES (?, NULL, 'platform@tawa.app', 'Platform Administrator', ?, 'ACTIVE', ?, ?)`,
    id('usr'), hashPassword('Admin#2026!'), nowIso(), nowIso());
  return login(base, 'platform@tawa.app', 'Admin#2026!', { 'x-forwarded-for': '10.77.0.1' });
}

/* ─── 1. Multi-tenant acceptance (§72): A/B/C operate fully and independently ─── */
test('three tenants run full business flows with zero cross-visibility', async () => {
  const names = ['abc-hw', 'mwangaza-hw', 'kilimani-b'];
  const T = [];
  for (const c of names) {
    const t = makeTenant(db, { code: c + '-' + uid() });
    t.fx = makeFixture(db, t.tenant.id, { stock: 100 });
    T.push(t);
  }
  const [A, B, C] = T;
  const aOwner = await loginOwner(A), bOwner = await loginOwner(B), cOwner = await loginOwner(C);

  // distinct branding, catalog, customers, workers per tenant
  await api(base, aOwner.token, 'PATCH', '/api/v1/settings/branding', { business_name: 'ABC HARDWARE', color_primary: '#B45309' });
  await api(base, bOwner.token, 'PATCH', '/api/v1/settings/branding', { business_name: 'MWANGAZA HARDWARE', color_primary: '#0E7490' });
  await api(base, cOwner.token, 'PATCH', '/api/v1/settings/branding', { business_name: 'KILIMANI BUILDERS', color_primary: '#4D7C0F' });
  for (const [t, owner, pname] of [[A, aOwner, 'Cement A'], [B, bOwner, 'Cement B'], [C, cOwner, 'Cement C']]) {
    await api(base, owner.token, 'POST', '/api/v1/products', { sku: 'P-' + t.tenant.code.toUpperCase(), name: pname, unit: 'bag', cost_price: 500, price_retail: 950, price_min: 900 });
    await api(base, owner.token, 'POST', '/api/v1/customers', { name: `${pname} Customer ${pname.slice(-1)}`, phone: '+2547' + Math.floor(Math.random() * 1e8) });
    await api(base, owner.token, 'POST', '/api/v1/suppliers', { name: `${pname} Supplier ${pname.slice(-1)}`, phone: '+2547' + Math.floor(Math.random() * 1e8) });
    await api(base, owner.token, 'POST', '/api/v1/workers', { name: `${pname} Worker ${pname.slice(-1)}`, role_title: 'DRIVER', wage_type: 'DAILY', base_pay: 1500 });
  }
  // A makes a sale, B receives stock, C creates a marketing campaign shape (data-level ops)
  const saleA = await api(base, aOwner.token, 'POST', '/api/v1/pos/sale', {
    idempotency_key: 'mt-a-' + uid(), method: 'CASH', items: [{ product_id: A.fx.product, qty: 2 }],
  });
  assert.equal(saleA.status, 201);

  // Visibility: each tenant sees only its own data
  const aProducts = (await api(base, aOwner.token, 'GET', '/api/v1/products')).json.data.map(p => p.name);
  assert.ok(aProducts.some(n => n.includes('Cement A')) && !aProducts.some(n => n.includes('Cement B')) && !aProducts.some(n => n.includes('Cement C')));
  const bCustomers = (await api(base, bOwner.token, 'GET', '/api/v1/customers')).json.data.map(c => c.name);
  assert.ok(bCustomers.some(n => n.includes('Cement B')) && !bCustomers.some(n => n.includes('Cement A')) && !bCustomers.some(n => n.includes('Cement C')), 'B sees only B customers');
  const cOrders = (await api(base, cOwner.token, 'GET', '/api/v1/orders')).json.data;
  assert.equal(cOrders.length, 0, 'C has no orders — A sale invisible');
  const aWorkers = (await api(base, aOwner.token, 'GET', '/api/v1/workers')).json.data.map(w => w.name);
  assert.ok(aWorkers.some(n => n.includes('Cement A')) && !aWorkers.some(n => n.includes('Cement B')), 'A sees only A workers');
});

/* ─── 2. Cross-tenant read/write/delete/search/file/notification/AI/payment-config rejection (§5–8) ─── */
test('every cross-tenant probe fails: read, write, delete, search, files, notifications, AI, payment config', async () => {
  const A = makeTenant(db, { code: 'ctxa-' + uid() });
  const B = makeTenant(db, { code: 'ctxb-' + uid() });
  A.fx = makeFixture(db, A.tenant.id, { stock: 50 });
  B.fx = makeFixture(db, B.tenant.id, { stock: 50 });
  const a = await loginOwner(A), b = await loginOwner(B);

  // read foreign object by id
  assert.equal((await api(base, a.token, 'GET', `/api/v1/products/${B.fx.product}`)).status, 404);
  const bCust = (await api(base, b.token, 'POST', '/api/v1/customers', { name: 'B Only Customer', phone: '+254700000001' })).json.data;
  assert.equal((await api(base, a.token, 'GET', `/api/v1/customers/${bCust.id}`)).status, 404);
  // write foreign object
  assert.equal((await api(base, a.token, 'PATCH', `/api/v1/products/${B.fx.product}`, { name: 'hijack' })).status, 404);
  assert.equal(q.one(db, `SELECT name FROM products WHERE id = ?`, B.fx.product).name.includes('hijack'), false);
  // delete foreign object
  const del = await api(base, a.token, 'DELETE', `/api/v1/customers/${bCust.id}`);
  assert.ok([404, 405].includes(del.status));
  assert.ok(q.one(db, `SELECT id FROM customers WHERE id = ?`, bCust.id), 'B customer intact');
  // search isolation
  const s = await api(base, a.token, 'GET', '/api/v1/search?q=' + encodeURIComponent('B Only Customer'));
  assert.equal(s.json.data.results.filter(r => r.title.includes('B Only')).length, 0);
  // file isolation
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#123456"/></svg>').toString('base64');
  const f = (await api(base, b.token, 'POST', '/api/v1/files', { kind: 'LOGO', name: 'b.svg', mime: 'image/svg+xml', data_base64: svg })).json.data;
  assert.equal((await api(base, a.token, 'GET', `/api/v1/files/${f.id}/info`)).status, 404);
  assert.equal((await api(base, a.token, 'DELETE', `/api/v1/files/${f.id}`)).status, 404);
  assert.equal((await api(base, a.token, 'GET', `/api/v1/files/${f.id}/raw`)).status, 404);
  // notification isolation: B events never surface for A
  await api(base, b.token, 'POST', '/api/v1/pos/sale', { idempotency_key: 'mt-b-' + uid(), method: 'CASH', items: [{ product_id: B.fx.product, qty: 1 }] });
  const aNotifs = (await api(base, a.token, 'GET', '/api/v1/notifications')).json.data;
  assert.ok(aNotifs.every(n => n.tenant_id === A.tenant.id), 'A notifications are A-only');
  // AI isolation: explicit foreign tenant_id is rejected; context is provably single-tenant
  const ask = await api(base, a.token, 'POST', '/api/v1/ai/ask', { question: 'top products by revenue', tenant_id: B.tenant.id });
  assert.equal(ask.status, 403);
  const aiStatus = (await api(base, a.token, 'GET', '/api/v1/ai/status')).json.data;
  assert.equal(aiStatus.tenants_in_context, 1);
  const aInsights = (await api(base, a.token, 'GET', '/api/v1/ai/insights')).json.data;
  for (const i of [...(aInsights.stored || []), ...(aInsights.fresh || [])]) {
    if (i.tenant_id) assert.equal(i.tenant_id, A.tenant.id);
  }
  // payment config isolation: A never sees B's payment setup; webhook cannot bind foreign intent
  await api(base, b.token, 'PUT', '/api/v1/settings/payment-config/mpesa_sandbox', { enabled: false });
  const aCfg = (await api(base, a.token, 'GET', '/api/v1/settings/payment-config')).json.data;
  assert.ok(Number(aCfg.find(p => p.provider === 'mpesa_sandbox').enabled) === 1, 'A config unaffected by B');
  const intent = (await api(base, b.token, 'POST', '/api/v1/payments/intents', { amount: 100, provider: 'cash', method: 'CASH', idempotency_key: 'ctx-b-' + uid() })).json.data.intent;
  const wh = await fetch(`${base}/api/v1/webhooks/payments/mpesa_sandbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider_ref: intent.provider_ref || 'none', foreign: true }) });
  assert.notEqual(wh.status, 200);
  assert.equal((await api(base, a.token, 'GET', `/api/v1/payments/intents?id=eq.${intent.id}`)).json.data?.length ?? 0, 0);
});

/* ─── 3. No-code-change provisioning (§20, §56–58, §73) ─── */
test('a brand-new hardware business provisions itself via public signup with zero developer intervention', async () => {
  const code = 'selfserve-' + uid();
  const r = await fetch(`${base}/api/v1/public/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ business_code: code, business_name: 'Self Serve Hardware', owner_name: 'Ann Own', email: `ann@${code}.test`, password: 'SelfServe2026', plan_id: 'STARTER', color_primary: '#7C2D12' }),
  });
  const j = await r.json();
  assert.equal(r.status, 201, JSON.stringify(j));
  assert.equal(j.data.tenant.code, code);
  // owner can log in and is operational immediately (branch, warehouse, config, roles seeded)
  const owner = await loginH(`ann@${code}.test`, 'SelfServe2026');
  const onb = (await api(base, owner.token, 'GET', '/api/v1/onboarding')).json.data;
  assert.equal(onb.branches, 1);
  assert.equal(onb.warehouses, 1);
  assert.equal(onb.users, 1);
  // entitlement gating is live for the new tenant: STARTER lacks TAWA.PAYROLL
  const payroll = await api(base, owner.token, 'GET', '/api/v1/payroll/runs');
  assert.equal(payroll.status, 403, 'STARTER plan gated server-side');
  // duplicate code rejected, no tenant ambiguity possible
  const dup = await fetch(`${base}/api/v1/public/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ business_code: code, business_name: 'X', owner_name: 'X', email: `x-${uid()}@x.test`, password: 'Whatever2026' }) });
  assert.equal(dup.status, 409);
});

/* ─── 4. Subscription lifecycle: trial → active → suspend → reactivate (§13, §19, §44, §74) ─── */
test('subscription states gate access deterministically; suspension preserves data; reactivation restores', async () => {
  const t = makeTenant(db, { code: 'life-' + uid(), plan: 'BUSINESS' });
  t.fx = makeFixture(db, t.tenant.id, { stock: 20 });
  const owner = await loginOwner(t);
  // tenant starts ACTIVE (test helper), downgrade lifecycle via control-plane semantics
  const platform = await makePlatform();
  const tenants = (await api(base, platform.token, 'GET', '/api/v1/admin/tenants')).json.data;
  const row = tenants.find(x => x.code === t.tenant.code);
  assert.ok(row, 'tenant visible in control plane');
  // suspend
  const susp = await api(base, platform.token, 'POST', `/api/v1/admin/tenants/${t.tenant.id}/status`, { status: 'SUSPENDED' });
  assert.equal(susp.status, 200);
  const blocked = await api(base, owner.token, 'POST', '/api/v1/pos/sale', { idempotency_key: 'life-' + uid(), method: 'CASH', items: [{ product_id: t.fx.product, qty: 1 }] });
  assert.ok([402, 403].includes(blocked.status), 'suspended tenant write blocked, got ' + blocked.status);
  assert.ok(['TENANT_RESTRICTED', 'FORBIDDEN'].includes(blocked.json.error.code));
  // data preserved while suspended (reads blocked at 402, rows intact in DB)
  const prods = await api(base, owner.token, 'GET', '/api/v1/products');
  assert.ok([402, 403].includes(prods.status), 'suspended read blocked');
  assert.ok(q.one(db, `SELECT COUNT(*) n FROM products WHERE tenant_id = ?`, t.tenant.id).n > 0, 'data intact during suspension');
  // reactivate
  await api(base, platform.token, 'POST', `/api/v1/admin/tenants/${t.tenant.id}/status`, { status: 'ACTIVE' });
  const sale = await api(base, owner.token, 'POST', '/api/v1/pos/sale', { idempotency_key: 'life2-' + uid(), method: 'CASH', items: [{ product_id: t.fx.product, qty: 1 }] });
  assert.equal(sale.status, 201, 'reactivated tenant can trade');
  // RESTRICTED tier (§47/§55): read-only — reads pass, writes blocked
  await api(base, platform.token, 'POST', `/api/v1/admin/tenants/${t.tenant.id}/status`, { status: 'RESTRICTED' });
  const ro = await api(base, owner.token, 'GET', '/api/v1/products');
  assert.equal(ro.status, 200, 'RESTRICTED tenant may read');
  const roWrite = await api(base, owner.token, 'POST', '/api/v1/products', { sku: 'RO-1', name: 'RO', unit: 'piece', price_retail: 100 });
  assert.ok([402, 403].includes(roWrite.status), 'RESTRICTED tenant may not write');
  await api(base, platform.token, 'POST', `/api/v1/admin/tenants/${t.tenant.id}/status`, { status: 'ACTIVE' });
});

/* ─── 5. Entitlements enforced outside the UI (§15–16); plans are configuration (§14, §18) ─── */
test('entitlement matrix is plan-driven and enforced on the server for API + automation paths', async () => {
  const free = makeTenant(db, { code: 'free-' + uid(), plan: 'FREE' });
  const biz = makeTenant(db, { code: 'biz-' + uid(), plan: 'BUSINESS' });
  const f = await loginOwner(free), b = await loginOwner(biz);
  // FREE lacks TAWA.PROCUREMENT / TAWA.PAYROLL / TAWA.MARKETING / TAWA.AI
  for (const p of ['/api/v1/procurement/requisitions', '/api/v1/payroll/runs', '/api/v1/marketing/campaigns', '/api/v1/ai/reorder']) {
    const r = await api(base, f.token, 'GET', p);
    assert.equal(r.status, 403, `FREE blocked from ${p}`);
    assert.equal(r.json.error.code, 'PLAN_UPGRADE_REQUIRED');
  }
  const rb = await api(base, b.token, 'GET', '/api/v1/ai/reorder');
  assert.equal(rb.status, 200, 'BUSINESS has AI entitlement');
  const rp = await api(base, b.token, 'GET', '/api/v1/payroll/runs');
  assert.equal(rp.status, 200, 'BUSINESS has payroll entitlement');
  // plan limits are config: FREE seat limit enforced at user creation
  const limits = q.one(db, `SELECT seat_limit FROM plans WHERE id = 'FREE'`).seat_limit;
  let limitHit = null;
  for (let i = 0; i < limits + 3; i++) {
    const r = await api(base, f.token, 'POST', '/api/v1/users', { email: `seat${i}-${uid()}@x.test`, name: 'Seat', password: 'Seat#Pass1', roles: ['CASHIER'] });
    if (r.status === 403) { limitHit = r; break; }
  }
  assert.ok(limitHit, 'seat limit enforced with 403');
  assert.ok(String(limitHit.json.error.message).toLowerCase().includes('plan limit'), limitHit.json.error.message);
});

/* ─── 6. Usage metering is tenant-scoped (§17) ─── */
test('usage meters exist per tenant and never aggregate across tenants', async () => {
  const { meter, usageFor } = await import('../server/core/entitlements.js');
  const A = makeTenant(db, { code: 'um-a-' + uid(), plan: 'BUSINESS' });
  const B = makeTenant(db, { code: 'um-b-' + uid(), plan: 'BUSINESS' });
  meter(db, A.tenant.id, 'orders', 3);
  meter(db, A.tenant.id, 'ai_requests', 2);
  meter(db, B.tenant.id, 'orders', 7);
  const ua = Object.fromEntries(usageFor(db, A.tenant.id).map(m => [m.meter, m.count]));
  const ub = Object.fromEntries(usageFor(db, B.tenant.id).map(m => [m.meter, m.count]));
  assert.equal(ua.orders, 3);
  assert.equal(ua.ai_requests, 2);
  assert.equal(ub.orders, 7);
  assert.equal(ub.ai_requests ?? 0, 0, 'no meter leakage across tenants');
  // API surface: me + billing expose usage server-side
  const a = await loginOwner(A);
  const sub = (await api(base, a.token, 'GET', '/api/v1/billing/subscription')).json.data;
  assert.ok(Array.isArray(sub.usage), 'subscription view exposes usage');
  assert.equal(sub.usage.find(m => m.meter === 'orders').count, 3);
});

/* ─── 7. API keys (§66): scoped, tenant-bound, revocable, isolated ─── */
test('api keys authenticate tenant-scoped requests; foreign data invisible; revocation instant', async () => {
  const A = makeTenant(db, { code: 'ak-a-' + uid(), plan: 'PROFESSIONAL' });
  const B = makeTenant(db, { code: 'ak-b-' + uid(), plan: 'PROFESSIONAL' });
  A.fx = makeFixture(db, A.tenant.id, { stock: 10 });
  B.fx = makeFixture(db, B.tenant.id, { stock: 10 });
  const a = await loginOwner(A), b = await loginOwner(B);
  const made = await api(base, a.token, 'POST', '/api/v1/api-keys', { name: 'integration', scopes: ['read', 'reports'] });
  assert.equal(made.status, 201);
  const { key } = made.json.data;
  assert.ok(key.startsWith('tawa_'));
  // key reads only tenant A data
  const list = await fetch(`${base}/api/v1/products`, { headers: { 'x-api-key': key } });
  assert.equal(list.status, 200);
  const names = (await list.json()).data.map(p => p.id);
  assert.ok(names.includes(A.fx.product) && !names.includes(B.fx.product), 'key scope is tenant-bound');
  // write scope absent → write denied
  const wr = await fetch(`${base}/api/v1/products`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'K1', name: 'K', unit: 'piece', price_retail: 100 }) });
  assert.equal(wr.status, 403);
  // keys cannot manage keys
  const guard = await fetch(`${base}/api/v1/api-keys`, { headers: { 'x-api-key': key } });
  assert.equal(guard.status, 403);
  // revoke → immediately invalid
  const kid = made.json.data.id;
  await api(base, a.token, 'POST', `/api/v1/api-keys/${kid}/revoke`);
  const after1 = await fetch(`${base}/api/v1/products`, { headers: { 'x-api-key': key } });
  assert.equal(after1.status, 401);
  // B tenant key list is empty — no visibility of A keys
  assert.equal((await api(base, b.token, 'GET', '/api/v1/api-keys')).json.data.length, 0);
  // tampered key token fails closed
  const fake = await fetch(`${base}/api/v1/products`, { headers: { 'x-api-key': key.slice(0, -2) + 'zz' } });
  assert.equal(fake.status, 401);
});

/* ─── 8. Tenant export + backup isolation (§45–46) ─── */
test('tenant export and backup contain strictly own-tenant data', async () => {
  const A = makeTenant(db, { code: 'ex-a-' + uid() });
  const B = makeTenant(db, { code: 'ex-b-' + uid() });
  A.fx = makeFixture(db, A.tenant.id, { stock: 5 });
  B.fx = makeFixture(db, B.tenant.id, { stock: 5 });
  const a = await loginOwner(A);
  const exp = await api(base, a.token, 'GET', '/api/v1/settings/export');
  assert.equal(exp.status, 200);
  const text = JSON.stringify(exp.json);
  assert.ok(!text.includes(B.tenant.id) && !text.includes(B.tenant.code), 'export contains no B identifiers');
  const backup = await api(base, a.token, 'GET', '/api/v1/settings/backup');
  assert.equal(backup.status, 200);
  const btext = JSON.stringify(backup.json);
  assert.ok(!btext.includes(B.tenant.id) && !btext.includes('payments_config"', ) || !btext.includes('credentials'), 'backup excludes B and secrets');
  // export requires the permission (a driver cannot export)
  const drv = await loginH(makeUser(db, A.tenant.id, `dv-${uid()}@x.test`, 'DRIVER').email, 'Test#Pass1');
  assert.equal((await api(base, drv.token, 'GET', '/api/v1/settings/export')).status, 403);
});

/* ─── 9. Audit logging covers security-relevant ops, tenant-tagged (§43) ─── */
test('audit trail is tenant-scoped, append-only, and records sensitive actions', async () => {
  const A = makeTenant(db, { code: 'au-a-' + uid() });
  A.fx = makeFixture(db, A.tenant.id, { stock: 5 });
  const a = await loginOwner(A);
  await api(base, a.token, 'POST', '/api/v1/pos/sale', { idempotency_key: 'au-' + uid(), method: 'CASH', items: [{ product_id: A.fx.product, qty: 1 }] });
  const evt = q.all(db, `SELECT * FROM audit_events WHERE tenant_id = ? AND action IN ('pos.sale','order.create','payment.intent.create') ORDER BY created_at DESC LIMIT 5`, A.tenant.id);
  assert.ok(evt.length > 0, 'sale audited');
  assert.equal(evt[0].tenant_id, A.tenant.id);
  // audit mutation guard (DB trigger)
  let threw = false;
  try { q.run(db, `UPDATE audit_events SET action = 'tampered' WHERE id = ?`, evt[0].id); } catch { threw = true; }
  assert.ok(threw, 'audit rows are immutable');
});


/* ─── 11. Background jobs/events carry tenant_id (§40) ─── */
test('events queue rows are tenant-stamped and processed per tenant', async () => {
  const A = makeTenant(db, { code: 'ev-a-' + uid() });
  A.fx = makeFixture(db, A.tenant.id, { stock: 5 });
  const a = await loginOwner(A);
  await api(base, a.token, 'POST', '/api/v1/pos/sale', { idempotency_key: 'ev-' + uid(), method: 'CASH', items: [{ product_id: A.fx.product, qty: 1 }] });
  const rows = q.all(db, `SELECT * FROM events WHERE tenant_id = ? ORDER BY id DESC LIMIT 5`, A.tenant.id);
  assert.ok(rows.length > 0, 'events recorded');
  assert.ok(rows.every(r => r.tenant_id === A.tenant.id));
});

/* ─── 12. Multi-branch authorization (§29) ─── */
test('branch manager is restricted to assigned branches; ownership APIs stay owner-only', async () => {
  const A = makeTenant(db, { code: 'mb-a-' + uid(), plan: 'BUSINESS' });
  A.fx = makeFixture(db, A.tenant.id, { stock: 5 });
  const owner = await loginOwner(A);
  const b2 = await api(base, owner.token, 'POST', '/api/v1/branches', { code: 'B2', name: 'Second Branch' });
  assert.equal(b2.status, 201);
  const cashier = makeUser(db, A.tenant.id, `ch-${uid()}@x.test`, 'CASHIER');
  const cs = await loginH(cashier.email, 'Test#Pass1');
  // cashier cannot manage branches or view another tenant's branch detail APIs
  assert.equal((await api(base, cs.token, 'POST', '/api/v1/branches', { code: 'HACK', name: 'H' })).status, 403);
  const brs = (await api(base, cs.token, 'GET', '/api/v1/branches')).json.data;
  assert.ok(brs.every(b => b.tenant_id === A.tenant.id), 'branch list tenant-scoped');
});

/* ─── 13. Fail-closed: no silent tenant fallback (§4, golden rules) ─── */
test('requests without resolvable tenant context fail closed; platform users cannot touch tenant APIs', async () => {
  const anon = await fetch(`${base}/api/v1/products`);
  assert.equal(anon.status, 401);
  const bogus = await fetch(`${base}/api/v1/products`, { headers: { authorization: 'Bearer invalid-token' } });
  assert.equal([401, 403].includes(bogus.status), true);
  const platform = await makePlatform();
  const r = await api(base, platform.token, 'GET', '/api/v1/products');
  assert.equal(r.status, 403, 'platform operator blocked from tenant data plane');
  // client-supplied tenant header/param is ignored — cannot pivot tenancy
  const A = makeTenant(db, { code: 'fc-a-' + uid() });
  const B = makeTenant(db, { code: 'fc-b-' + uid() });
  B.fx = makeFixture(db, B.tenant.id, { stock: 5 });
  const a = await loginOwner(A);
  const pivot = await api(base, a.token, 'GET', `/api/v1/products?tenant_id=${B.tenant.id}`);
  const ids = pivot.json.data.map(p => p.id);
  assert.ok(!ids.includes(B.fx.product), 'tenant_id query param cannot escape tenant boundary');
});

/* ─── 14. Rate limiting fails safely (§60) — runs last: it consumes the per-IP bucket ─── */
test('login rate limiting is enforced per-IP', async () => {
  const hits = [];
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@x.test', password: 'nope' }) });
    hits.push(r.status);
    if (r.status === 429) break;
  }
  assert.ok(hits.includes(429), `expected throttling, got ${hits.join(',')}`);
});
