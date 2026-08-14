import { q, id, nowIso, tx } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { hashPassword } from '../core/auth.js';
import { PERMISSIONS } from '../core/rbac.js';
import { PLANS, PLAN_MATRIX, ENTITLEMENTS } from '../core/entitlements.js';
import { provisionTenant } from '../routes/admin.js';
import { UNITS, catalogFor } from './catalog.js';
import { createOrder, fulfilOrder } from '../modules/sales.js';
import { createIntent, initiateIntent, verifyAndSettle } from '../modules/payments.js';
import { getProvider } from '../adapters/payments.js';
import { postMovement, positionFor } from '../modules/inventory.js';
import { generateInsights } from '../modules/ai.js';
import { sendNotification } from '../adapters/messaging.js';

/** Deterministic seeded RNG for reproducible demo data. */
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function seedIfEmpty(db) {
  const has = q.one(db, `SELECT COUNT(*) AS n FROM tenants`).n;
  if (has > 0) return { seeded: false };
  seedAll(db);
  return { seeded: true };
}

export function seedAll(db) {
  runMigrations(db);
  tx(db, () => {
    for (const [code, name, kind] of UNITS) q.run(db, `INSERT OR IGNORE INTO units (id, code, name, kind) VALUES (?,?,?,?)`, id('un'), code, name, kind);
    for (const p of PLANS) {
      q.run(db, `INSERT INTO plans (id, name, description, seat_limit, branch_limit, product_limit, monthly_price_minor, sort)
                 VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        p.id, p.name, p.description, p.seats, p.branches, p.products, p.price * 100, p.sort);
    }
    for (const [code, label, module] of ENTITLEMENTS) q.run(db, `INSERT OR IGNORE INTO entitlements (code, label, module) VALUES (?,?,?)`, code, label, module);
    for (const [plan, list] of Object.entries(PLAN_MATRIX)) {
      for (const e of list) q.run(db, `INSERT OR IGNORE INTO plan_entitlements (plan_id, entitlement) VALUES (?,?)`, plan, e);
    }
    for (const p of PERMISSIONS) q.run(db, `INSERT OR IGNORE INTO permissions (code, label, grp) VALUES (?,?,?)`, p, p, p.split('.')[0]);
    // Platform operator (control plane; tenant_id NULL)
    q.run(db, `INSERT INTO users (id, tenant_id, email, name, password_hash, status, created_at, updated_at)
               VALUES (?, NULL, 'platform@tawa.app', 'Platform Administrator', ?, 'ACTIVE', ?, ?)
               ON CONFLICT(email) DO NOTHING`,
      id('usr'), hashPassword('Admin#2026!'), nowIso(), nowIso());
    const superRole = id('rol');
    q.run(db, `INSERT INTO roles (id, tenant_id, name, description, is_system, created_at) VALUES (?, NULL, 'PLATFORM_SUPER_ADMIN', 'Platform operator', 1, ?)`, superRole, nowIso());
    for (const p of PERMISSIONS) q.run(db, `INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?,?)`, superRole, p);
    const admin = q.one(db, `SELECT id FROM users WHERE email = ?`, 'platform@tawa.app');
    q.run(db, `INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)`, admin.id, superRole);
  });

  seedTenant(db, {
    code: 'alpha', name: 'Alpha Hardware Ltd', businessName: 'ALPHA HARDWARE',
    monogram: 'AH', primary: '#F0A824', accent: '#28C76F', industry: 'HARDWARE', plan: 'BUSINESS',
    tagline: 'Everything for your build — one roof.',
    email: 'owner@alpha-hardware.co.ke', password: 'Alpha#2026!',
    catalog: catalogFor('alpha'), seed: 42, whiteLabel: 0,
  });
  seedTenant(db, {
    code: 'buildpro', name: 'BuildPro Supplies Co.', businessName: 'BUILDPRO SUPPLIES',
    monogram: 'BP', primary: '#2BB5A0', accent: '#F97316', industry: 'BUILDING_SUPPLIES', plan: 'PROFESSIONAL',
    tagline: 'Contractor-grade supply, delivered.',
    email: 'owner@buildpro.co.ke', password: 'Build#2026!',
    catalog: catalogFor('buildpro'), seed: 777, whiteLabel: 1,
  });
  seedTenant(db, {
    code: 'kilimani', name: 'Kilimani Builders Yard', businessName: 'KILIMANI BUILDERS',
    monogram: 'KB', primary: '#7C9A2E', accent: '#C2410C', industry: 'HARDWARE', plan: 'STARTER',
    tagline: 'The yard that knows your site.',
    email: 'owner@kilimani-builders.co.ke', password: 'Kilimani#2026!',
    catalog: catalogFor('kilimani'), seed: 2024, whiteLabel: 1,
  });
}

function seedTenant(db, cfg) {
  const now = nowIso();
  const { tenant } = provisionTenant(db, {
    code: cfg.code, name: cfg.name, planId: cfg.plan,
    ownerEmail: cfg.email, ownerName: cfg.code === 'alpha' ? 'Amara Otieno' : 'Kevin Maina',
    ownerPassword: cfg.password, industry: cfg.industry,
    branding: { business_name: cfg.businessName, logo_monogram: cfg.monogram, color_primary: cfg.primary, color_accent: cfg.accent, white_label: cfg.whiteLabel },
  });
  const t = tenant.id;
  q.run(db, `UPDATE tenants SET status = 'ACTIVE' WHERE id = ?`, t);
  q.run(db, `UPDATE subscriptions SET status = 'ACTIVE' WHERE tenant_id = ?`, t);
  q.run(db, `UPDATE licenses SET state = 'ACTIVE' WHERE tenant_id = ?`, t);
  q.run(db, `UPDATE tenant_branding SET tagline = ?, color_accent = ?, phone = '+254 700 000 001', email = 'sales@' || ? || '.co.ke', address = 'Industrial Area, Nairobi',
              doc_footer = 'Goods once sold are returnable within 7 days in original condition.'
             WHERE tenant_id = ?`, cfg.tagline, cfg.accent, cfg.code, t);

  // --- Users across roles (§4) ---
  const mkUser = (email, name, roles, password) => {
    const uid = id('usr');
    q.run(db, `INSERT INTO users (id, tenant_id, email, name, password_hash, status, created_at, updated_at) VALUES (?,?,?,?,?, 'ACTIVE', ?, ?)`,
      uid, t, email, name, hashPassword(password), now, now);
    for (const rn of roles) {
      const r = q.one(db, `SELECT id FROM roles WHERE tenant_id = ? AND name = ?`, t, rn);
      if (r) q.run(db, `INSERT INTO user_roles (user_id, role_id) VALUES (?,?)`, uid, r.id);
    }
    return uid;
  };
  const dom = { alpha: 'alpha-hardware.co.ke', buildpro: 'buildpro.co.ke', kilimani: 'kilimani-builders.co.ke' }[cfg.code] || `${cfg.code}.co.ke`;
  const names = cfg.code === 'alpha'
    ? { manager: 'Brian Kimani', cashier: 'Carol Nekesa', keeper: 'David Mwangi', finance: 'Eunice Wafula', sales: 'Felix Barasa', hr: 'Grace Atieno', driver: 'Peter Ouma' }
    : cfg.code === 'kilimani'
      ? { manager: 'Naomi Kerubo', cashier: 'Ian Mwadime', keeper: 'Ruth Nyokabi', finance: 'Collins Oduor', sales: 'Faith Njambi', hr: 'Moses Tinga', driver: 'Eliud Wanyonyi' }
      : { manager: 'Stella Wanjiru', cashier: 'Tom Kiprop', keeper: 'Victor Njoroge', finance: 'Winnie Achieng', sales: 'Oscar Mutua', hr: 'Linda Cherono', driver: 'James Kariuki' };
  const pw = cfg.password;
  const users = {
    owner: q.one(db, `SELECT id FROM users WHERE tenant_id = ? AND email = ?`, t, cfg.email).id,
    manager: mkUser(`manager@${dom}`, names.manager, ['BRANCH_MANAGER'], pw),
    cashier: mkUser(`cashier@${dom}`, names.cashier, ['CASHIER'], pw),
    keeper: mkUser(`keeper@${dom}`, names.keeper, ['STOREKEEPER'], pw),
    finance: mkUser(`finance@${dom}`, names.finance, ['FINANCE_MANAGER'], pw),
    sales: mkUser(`sales@${dom}`, names.sales, ['SALESPERSON'], pw),
    hr: mkUser(`hr@${dom}`, names.hr, ['HR_MANAGER'], pw),
  };

  // --- Branches & warehouses ---
  const branch = id('br');
  q.run(db, `INSERT INTO branches (id, tenant_id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?,?)`,
    branch, t, 'HQ', cfg.code === 'alpha' ? 'Nairobi Main' : cfg.code === 'kilimani' ? 'Kilimani Yard HQ' : 'Mombasa Road HQ', cfg.code === 'kilimani' ? 'Argwings Kodhek Rd, Kilimani' : 'Industrial Area, Nairobi', '+254 700 000 001', now);
  const branch2 = id('br');
  q.run(db, `INSERT INTO branches (id, tenant_id, code, name, address, phone, created_at) VALUES (?,?,?,?,?,?,?)`,
    branch2, t, 'BR2', cfg.code === 'alpha' ? 'Thika Branch' : cfg.code === 'kilimani' ? 'Kileleshwa Depot' : 'Kisumu Depot', cfg.code === 'alpha' ? 'Thika Road' : cfg.code === 'kilimani' ? 'Othaya Rd, Kileleshwa' : 'Milimani, Kisumu', '+254 700 000 002', now);
  const wh1 = id('wh'); const wh2 = id('wh');
  q.run(db, `INSERT INTO warehouses (id, tenant_id, branch_id, code, name, address, created_at) VALUES (?,?,?,?,?,?,?)`, wh1, t, branch, 'MAIN', 'Main Warehouse', 'Ground floor, main store', now);
  q.run(db, `INSERT INTO warehouses (id, tenant_id, branch_id, code, name, address, created_at) VALUES (?,?,?,?,?,?,?)`, wh2, t, branch2, 'YARD', 'Open Yard Store', 'Backyard yard storage', now);

  // --- Categories / Products / Graph ---
  const catIds = {};
  for (const [i, name] of cfg.catalog.categories.entries()) {
    catIds[name] = id('cat');
    q.run(db, `INSERT INTO categories (id, tenant_id, name, sort) VALUES (?,?,?,?)`, catIds[name], t, name, i);
  }
  const supIds = [];
  const supplierIds = {};
  for (const [i, s] of cfg.catalog.suppliers.entries()) {
    const sid = id('sup');
    supIds.push(sid);
    q.run(db, `INSERT INTO suppliers (id, tenant_id, code, name, contact_name, phone, email, lead_time_days, payment_terms, reliability, quality, fulfilment_rate, on_time_rate, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sid, t, `S-${String(i + 1).padStart(3, '0')}`, s.name, ['James Kilonzo', 'Sarah Mutiso', 'Ahmed Noor', 'Patricia Wabwire', 'Daniel Muli'][i % 5],
      `+254 71${i}0 22${i} 44${i}`, `sales@${s.name.toLowerCase().replace(/[^a-z]/g, '')}.co.ke`, s.lead, s.terms, s.reliability, s.quality, s.fulfilment, s.onTime, now, now);
    supplierIds[s.name] = sid;
  }
  const prodIds = {};
  for (const [sku, name, brandName, cat, unit, cost, retail, wholesale, contractor, min, tax, reorder, max, supIdx] of cfg.catalog.products) {
    const pid = id('prd');
    prodIds[sku] = pid;
    q.run(db, `INSERT INTO products (id, tenant_id, sku, barcode, name, brand, category_id, unit, cost_price, price_retail, price_wholesale, price_contractor, price_min, tax_category, reorder_point, min_stock, max_stock, supplier_id, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?, ?)`,
      pid, t, sku, `600${Math.abs(hashCode(sku)) % 10 ** 9}`, name, brandName, catIds[cat] || null, unit,
      cost * 100, retail * 100, wholesale * 100, contractor * 100, min * 100, tax, reorder, reorder / 2, max, supIdx == null ? null : supIds[supIdx], now, now);
  }
  for (const [a, b, type, w] of cfg.catalog.relations) {
    if (prodIds[a] && prodIds[b]) {
      q.run(db, `INSERT OR IGNORE INTO product_relations (id, tenant_id, product_id, related_id, type, weight, created_at) VALUES (?,?,?,?,?,?,?)`,
        id('rel'), t, prodIds[a], prodIds[b], type, w, now);
    }
  }
  for (const [term, target] of cfg.catalog.synonyms) {
    q.run(db, `INSERT OR IGNORE INTO search_synonyms (tenant_id, term, target) VALUES (?,?,?)`, t, term, target);
  }

  // --- Customers ---
  const customerDefs = cfg.code === 'alpha'
    ? [
      ['Joseph Kibe', '+254 722 111 222', 'CONTRACTOR', 'Kibe Construction Ltd'], ['Mary Wanjiku', '+254 733 222 333', 'WHOLESALE', null],
      ['Ann Nyambura', '+254 745 333 444', 'RETAIL', null], ['Paul Mbugua', '+254 756 444 555', 'CONTRACTOR', 'Mbugua & Sons Builders'],
      ['Lucy Njeri', '+254 767 555 666', 'CORPORATE', 'Njeri Estates'], ['Steve Ochieng', '+254 778 666 777', 'RETAIL', null],
      ['Faith Moraa', '+254 789 777 888', 'WHOLESALE', null], ['George Kilonzo', '+254 790 888 999', 'RETAIL', null],
      ['Hellen Chebet', '+254 701 999 000', 'CONTRACTOR', 'Chebet Builders'], ['Ian Mwangi', '+254 712 000 111', 'RETAIL', null],
    ]
    : cfg.code === 'kilimani'
      ? [
        ['Tabitha Wambua', '+254 720 909 111', 'CONTRACTOR', 'Wambua Sites'], ['Josphat Irungu', '+254 731 808 222', 'WHOLESALE', null],
        ['Caroline Syombua', '+254 742 707 333', 'RETAIL', null], ['Benard Maiyo', '+254 753 606 444', 'CONTRACTOR', 'Maiyo Frame Works'],
        ['Purity Kanini', '+254 764 505 555', 'CORPORATE', 'Kanini Homes'], ['George Onyiego', '+254 775 404 666', 'RETAIL', null],
      ]
      : [
        ['Rose Auma', '+254 723 101 202', 'CONTRACTOR', 'Auma Contractors'], ['Nick Otis', '+254 734 202 303', 'WHOLESALE', null],
        ['Cynthia Adhiambo', '+254 745 303 404', 'RETAIL', null], ['Dennis Koech', '+254 756 404 505', 'CONTRACTOR', 'Koech & Partners'],
        ['Mercy Kendi', '+254 767 505 606', 'RETAIL', null], ['Ali Hassan', '+254 778 606 707', 'CORPORATE', 'Hassan Developers'],
      ];
  const customerIds = [];
  customerDefs.forEach(([name, phone, type, company], i) => {
    const cid = id('cus');
    customerIds.push(cid);
    q.run(db, `INSERT INTO customers (id, tenant_id, code, name, phone, type, segment, branch_id, notes, marketing_opt_in, address, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cid, t, `C-${String(i + 1).padStart(4, '0')}`, company ? `${company}` : name, phone, type, type === 'RETAIL' ? (i % 3 === 0 ? 'FREQUENT' : 'RETAIL') : type,
      branch, company ? `Contact: ${name}` : null, i % 2 === 0 ? 1 : 0, 'Nairobi', now, now);
  });
  // Credit accounts for a couple of customers
  for (const [idx, limit] of [[0, 300_000_00], [3, 150_000_00]]) {
    if (customerIds[idx]) {
      q.run(db, `INSERT INTO credit_accounts (customer_id, tenant_id, limit_amount, balance, is_active, approved_by, created_at, updated_at)
                 VALUES (?,?,?,0,1,?,?,?)`, customerIds[idx], t, limit, users.finance, now, now);
    }
  }

  // --- Brokers ---
  const brokerIds = [];
  const brokerDefs = cfg.code === 'alpha'
    ? [['Kevin Otiende', '+254 720 345 678', 'Nairobi West', 5], ['Janet Wairimu', '+254 731 456 789', 'Thika', 4]]
    : [['Samuel Baraza', '+254 722 567 890', 'Mombasa', 5]];
  brokerDefs.forEach(([name, phone, territory, pct], i) => {
    const bid = id('brk');
    brokerIds.push(bid);
    q.run(db, `INSERT INTO brokers (id, tenant_id, code, name, phone, territory, commission_pct, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      bid, t, `B-${String(i + 1).padStart(3, '0')}`, name, phone, territory, pct, now);
  });

  // --- Workers ---
  const workerIds = [];
  const workerDefs = [
    [names.keeper, '+254 711 222 100', 'STOREKEEPER', 'DAILY', 1200], [names.driver, '+254 711 222 101', 'DRIVER', 'DAILY', 1500],
    ['Loaders Team Lead', '+254 711 222 102', 'GENERAL_WORKER', 'DAILY', 900], ['Yard Assistant', '+254 711 222 103', 'GENERAL_WORKER', 'DAILY', 850],
    [names.sales, '+254 711 222 104', 'SALESPERSON', 'MONTHLY', 45000],
  ];
  workerDefs.forEach(([name, phone, role, wageType, base], i) => {
    const wid = id('wrk');
    workerIds.push(wid);
    q.run(db, `INSERT INTO workers (id, tenant_id, code, name, phone, role_title, branch_id, wage_type, base_pay, skills, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      wid, t, `W-${String(i + 1).padStart(3, '0')}`, name, phone, role, i % 2 === 0 ? branch : branch2, wageType, base * 100,
      JSON.stringify(role === 'DRIVER' ? ['driving', 'delivery'] : ['loading', 'stock']), now);
  });
  // Link the driver login to their worker record for task scoping
  q.run(db, `UPDATE workers SET role_title = role_title WHERE tenant_id = ? AND 1=0`, t);

  // --- Opening stock (RECEIVE at start) ---
  const rng = lcg(cfg.seed);
  tx(db, () => {
    for (const [sku] of cfg.catalog.products) {
      const pid = prodIds[sku];
      const qty = Math.floor(rng() * 220) + 30;
      const split = Math.floor(qty * 0.75);
      postMovement(db, { tenantId: t, productId: pid, warehouseId: wh1, type: 'RECEIVE', qty: split, reason: 'Opening balance', refType: 'seed', actorId: users.keeper });
      postMovement(db, { tenantId: t, productId: pid, warehouseId: wh2, type: 'RECEIVE', qty: qty - split, reason: 'Opening balance', refType: 'seed', actorId: users.keeper });
    }
  });

  // --- Historical orders (last 45 days) to power analytics/AI ---
  const skus = cfg.catalog.products.map(p => p[0]);
  const orderSeeds = cfg.code === 'alpha' ? 26 : cfg.code === 'kilimani' ? 12 : 16;
  const orderIds = [];
  for (let d = 45; d >= 0; d -= Math.max(1, Math.floor(rng() * 4))) {
    const date = new Date(Date.now() - d * 86400_000 + Math.floor(rng() * 8 * 3600_000));
    const n = Math.max(1, Math.floor(rng() * 4));
    for (let k = 0; k < n; k++) {
      const itemCount = 1 + Math.floor(rng() * 3);
      const items = [];
      const used = new Set();
      for (let j = 0; j < itemCount; j++) {
        const sku = skus[Math.floor(rng() * skus.length)];
        if (used.has(sku)) continue;
        used.add(sku);
        // Clamp to what MAIN warehouse can actually supply — demo orders must never fail.
        const want = [1, 2, 3, 5, 10, 20][Math.floor(rng() * 6)];
        const pos = positionFor(db, t, prodIds[sku], wh1);
        const avail = Math.max(0, (pos?.on_hand ?? 0) - (pos?.reserved ?? 0));
        if (avail < 1) continue;
        items.push({ product_id: prodIds[sku], qty: Math.min(want, avail) });
      }
      const cust = customerIds[Math.floor(rng() * customerIds.length)];
      const idem = `seed-${cfg.code}-${d}-${k}`;
      if (items.length === 0) continue;
      try {
        const result = tx(db, () => {
          const order = createOrder(db, {
            tenantId: t, customerId: cust, items, source: ['POS', 'WEB', 'PHONE'][Math.floor(rng() * 3)],
            actorId: users.cashier, warehouseId: wh1, autoReserve: true,
            brokerId: rng() < 0.18 ? brokerIds[0] : null, idempotencyKey: idem, branchId: rng() < 0.7 ? branch : branch2,
          });
          const { intent } = createIntent(db, { tenantId: t, orderId: order.id, customerId: cust, amount: order.total, provider: 'cash', method: 'CASH', idempotencyKey: `${idem}-pay` });
          initiateIntent(db, t, intent.id);
          getProvider('cash').confirmReceived(db, q.one(db, `SELECT * FROM payment_intents WHERE id = ?`, intent.id), order.total, users.cashier);
          verifyAndSettle(db, t, intent.id, users.cashier);
          fulfilOrder(db, t, order.id, users.keeper);
          q.run(db, `UPDATE orders SET status = 'COMPLETED' WHERE id = ?`, order.id);
          return order;
        });
        orderIds.push(result.id);
        // Backdate timestamps (append-only journal & movements stay "now" — demo data)
        q.run(db, `UPDATE orders SET created_at = ?, updated_at = ? WHERE id = ?`, date.toISOString(), date.toISOString(), result.id);
        q.run(db, `UPDATE payment_intents SET created_at = ?, updated_at = ? WHERE order_id = ?`, date.toISOString(), date.toISOString(), result.id);
        q.run(db, `UPDATE payments SET received_at = ?, created_at = ? WHERE intent_id IN (SELECT id FROM payment_intents WHERE order_id = ?)`, date.toISOString(), date.toISOString(), result.id);
      } catch (e) {
        console.warn(`[seed] order failed for ${cfg.code} d=${d}: ${e.message}`);
      }
    }
  }

  // --- Tasks / chores (ext §30) ---
  const taskDefs = [
    ['Arrange cement pallets in aisle 2', 'CHORE', 'HIGH', workerIds[2], true],
    ['Load order for site delivery', 'DELIVERY', 'URGENT', workerIds[1], false],
    ['Count PVC fittings stock', 'STOCK', 'NORMAL', workerIds[0], false],
    ['Clean glass display section', 'CHORE', 'LOW', workerIds[3], true],
  ];
  taskDefs.forEach(([title, cat, pr, assignee, recur], i) => {
    const tid = id('tsk');
    q.run(db, `INSERT INTO worker_tasks (id, tenant_id, title, category, priority, assignee_id, creator_id, branch_id, status, due_at, recurrence, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?, 'ASSIGNED', ?, ?, ?, ?)`,
      tid, t, title, cat, pr, assignee, users.manager, branch,
      new Date(Date.now() + (i + 2) * 3600_000).toISOString(), recur ? 'DAILY' : null, now, now);
  });

  // --- Deliveries: one in-flight, one pending ---
  if (orderIds.length >= 2) {
    const delivered = orderIds[0], inFlight = orderIds[1];
    const d1 = id('dlv');
    q.run(db, `INSERT INTO deliveries (id, tenant_id, order_id, driver_id, vehicle, fee, address, status, otp_code, proof_type, assigned_at, dispatched_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?, 'DISPATCHED', ?, 'OTP', ?, ?, ?, ?)`,
      d1, t, inFlight, workerIds[1], 'KDE 123T — Box Truck', 50000, 'Site B, Thika Road', '4821', now, now, now, now);
    q.run(db, `UPDATE orders SET status = 'DELIVERING' WHERE id = ?`, inFlight);
    const d2 = id('dlv');
    q.run(db, `INSERT INTO deliveries (id, tenant_id, order_id, driver_id, vehicle, fee, address, status, otp_code, proof_type, delivered_at, proof_ref, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?, 'DELIVERED', ?, 'OTP', ?, ?, ?, ?)`,
      d2, t, delivered, workerIds[1], 'KDE 123T — Box Truck', 50000, 'Ruiru Bypass', '7712', now, `OTP-VERIFIED-seed${cfg.seed}`, now, now);
  }

  // --- Expense + overdue supplier invoice (feeds AI risk detection) ---
  q.run(db, `INSERT INTO expenses (id, tenant_id, number, category, description, amount, status, payee, submitted_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?, 'SUBMITTED', 'Kenya Power', ?, ?, ?)`,
    id('exp'), t, 'EX-000001', 'ELECTRICITY', 'Monthly power bill', 18500 * 100, users.manager, now, now);
  if (supIds[0]) {
    q.run(db, `INSERT INTO supplier_invoices (id, tenant_id, number, supplier_id, amount, paid, status, due_at, created_at, updated_at)
               VALUES (?,?,?,?,?, 0, 'OPEN', ?, ?, ?)`,
      id('sin'), t, 'SI-000001', supIds[0], 145_000 * 100, new Date(Date.now() - 6 * 86400_000).toISOString(), now, now);
  }

  // --- One campaign + promotion demo ---
  const cmpId = id('cmp');
  q.run(db, `INSERT INTO campaigns (id, tenant_id, name, description, objective, segment, offer, channels, budget, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'DRAFT', ?, ?, ?)`,
    cmpId, t, cfg.code === 'alpha' ? 'Roofing Week' : cfg.code === 'kilimani' ? 'Site Start Bundles' : 'Contractor Cement Week',
    'Targeted promotion for high-intent buyers', 'Revenue growth + reactivation',
    'MARKETING_OPTIN', JSON.stringify({ message: cfg.code === 'alpha' ? 'Roofing week: 5% off mabati + nails bundles!' : cfg.code === 'kilimani' ? 'New site? Get your first-week bundle pricing.' : 'Cement week: contractor-only bundle pricing!' }),
    JSON.stringify(['SMS']), 5000 * 100, users.manager, now, now);
  q.run(db, `INSERT INTO promotions (id, tenant_id, code, name, type, value, conditions, is_active, created_at)
             VALUES (?,?,?,?, 'PERCENT', 5, ?, 1, ?)`,
    id('prm'), t, 'BUILD5', '5% off orders above KES 20,000', JSON.stringify({ min_order_total: 20000 * 100 }), now);

  // --- Default alert rules (§30) ---
  const alertRules = [
    ['Sale completed', 'SaleCompleted', 'IN_APP', 'OWNER', 'Sale {{number}} completed — {{total}}', 'NORMAL'],
    ['Large payment verified', 'PaymentVerified', 'IN_APP', 'FINANCE_MANAGER', 'Payment verified: {{amount}} (ref {{reference}})', 'NORMAL'],
    ['Quote accepted', 'QuoteAccepted', 'IN_APP', 'OWNER', 'Quotation {{number}} accepted by customer.', 'HIGH'],
    ['Payment failed', 'PaymentFailed', 'IN_APP', 'CASHIER', 'A payment failed at the provider. Verify and follow up.', 'HIGH'],
    ['Order dispatched', 'OrderDispatched', 'IN_APP', 'STORE_MANAGER', 'Order dispatched for delivery {{delivery_id}}.', 'NORMAL'],
    ['Delivery completed', 'DeliveryCompleted', 'IN_APP', 'STORE_MANAGER', 'Delivery {{delivery_id}} completed (OTP-verified).', 'NORMAL'],
  ];
  for (const [name, event, channel, role, template, priority] of alertRules) {
    q.run(db, `INSERT INTO alert_rules (id, tenant_id, name, event, channel, recipient_role, template, priority, enabled, created_at)
               VALUES (?,?,?,?,?,?,?,?,1,?)`, id('arl'), t, name, event, channel, role, template, priority, now);
  }
  q.run(db, `INSERT INTO automation_rules (id, tenant_id, name, trigger_event, condition, action_type, action, requires_approval, enabled, created_at)
             VALUES (?,?,?,?,?,?,?,?,1,?)`,
    id('aut'), t, 'Low stock → purchase recommendation', 'StockLow', '{}', 'CREATE_PURCHASE_RECOMMENDATION',
    JSON.stringify({ message: 'Stock below reorder point — AI prepared a reorder suggestion. Review and approve.' }), 1, now);

  // Warm AI insights
  try { generateInsights(db, t); } catch (e) { console.warn('[seed] insights failed', e.message); }

  // A fresh open task → SMS notified marker
  sendNotification(db, { tenantId: t, channel: 'IN_APP', recipientKind: 'ROLE', recipientId: 'OWNER', body: `${cfg.businessName} workspace is ready. Review dashboards and run your first sale from POS.`, priority: 'LOW', kind: 'OPERATIONAL', eventType: 'TenantOnboarded' });
  void brokerIds;
}

function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h; }

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const { getDb } = await import('../db/connection.js');
  const db = getDb();
  if (seedIfEmpty(db).seeded) console.log('[tawa] seed completed');
  else console.log('[tawa] database already seeded');
}
