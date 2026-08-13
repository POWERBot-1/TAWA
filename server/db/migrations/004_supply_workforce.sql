-- ============================================================
-- TAWA 004 — Suppliers, Procurement, Brokers, Workers, Tasks,
--            Payroll, Deliveries
-- ============================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 3,
  payment_terms TEXT NOT NULL DEFAULT 'NET30',
  credit_limit INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  -- performance scorecard (computed)
  reliability  REAL NOT NULL DEFAULT 0.9,
  quality      REAL NOT NULL DEFAULT 0.9,
  fulfilment_rate REAL NOT NULL DEFAULT 0.95,
  on_time_rate REAL NOT NULL DEFAULT 0.9,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  number     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CONVERTED')),
  reason     TEXT,
  source     TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','AI_REORDER','AUTOMATION')),
  requested_by TEXT,
  approved_by  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);

CREATE TABLE IF NOT EXISTS purchase_requisition_items (
  id         TEXT PRIMARY KEY,
  requisition_id TEXT NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  qty        REAL NOT NULL CHECK (qty > 0),
  est_cost   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  number      TEXT NOT NULL,
  requisition_id TEXT REFERENCES purchase_requisitions(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  warehouse_id TEXT REFERENCES warehouses(id),
  status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  subtotal    INTEGER NOT NULL DEFAULT 0,
  tax         INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  expected_at TEXT,
  created_by  TEXT,
  approved_by TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);

CREATE TABLE IF NOT EXISTS po_items (
  id         TEXT PRIMARY KEY,
  po_id      TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  name_snap  TEXT NOT NULL DEFAULT '',
  qty        REAL NOT NULL CHECK (qty > 0),
  received_qty REAL NOT NULL DEFAULT 0,
  unit_cost  INTEGER NOT NULL CHECK (unit_cost >= 0),
  total      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_po_items ON po_items(po_id);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  number     TEXT NOT NULL,
  po_id      TEXT NOT NULL REFERENCES purchase_orders(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  received_by TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);

CREATE TABLE IF NOT EXISTS grn_items (
  id         TEXT PRIMARY KEY,
  grn_id     TEXT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  qty        REAL NOT NULL CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  number      TEXT NOT NULL,
  po_id       TEXT REFERENCES purchase_orders(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  paid        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL','PAID','DISPUTED','CANCELLED')),
  due_at      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);

-- Broker / agent ecosystem (§19)
CREATE TABLE IF NOT EXISTS brokers (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  phone     TEXT,
  email     TEXT,
  territory TEXT,
  commission_pct REAL NOT NULL DEFAULT 5,      -- percent of order subtotal
  status    TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  broker_id   TEXT NOT NULL REFERENCES brokers(id),
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ACCEPTED','CONVERTED','REJECTED')),
  customer_id TEXT REFERENCES customers(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commissions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  broker_id  TEXT NOT NULL REFERENCES brokers(id),
  order_id   TEXT NOT NULL REFERENCES orders(id),
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  status     TEXT NOT NULL DEFAULT 'EARNED' CHECK (status IN ('EARNED','APPROVED','PAID','REVERSED')),
  approved_by TEXT,
  paid_ref   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id, broker_id)                  -- commission cannot be computed twice
);

-- Workforce (§22)
CREATE TABLE IF NOT EXISTS workers (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  phone     TEXT,
  pin_hash  TEXT,                               -- optional task kiosk pin
  role_title TEXT NOT NULL DEFAULT 'GENERAL_WORKER',
  branch_id TEXT REFERENCES branches(id),
  skills    TEXT NOT NULL DEFAULT '[]',
  wage_type TEXT NOT NULL DEFAULT 'DAILY' CHECK (wage_type IN ('MONTHLY','DAILY','WEEKLY','COMMISSION','CONTRACT')),
  base_pay  INTEGER NOT NULL DEFAULT 0,         -- minor units per wage period
  commission_pct REAL NOT NULL DEFAULT 0,
  status    TEXT NOT NULL DEFAULT 'ACTIVE',
  hired_at  TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS attendance (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  worker_id  TEXT NOT NULL REFERENCES workers(id),
  day        TEXT NOT NULL,                     -- YYYY-MM-DD (tenant tz)
  status     TEXT NOT NULL DEFAULT 'PRESENT' CHECK (status IN ('PRESENT','ABSENT','HALF_DAY','LEAVE')),
  hours      REAL NOT NULL DEFAULT 8,
  recorded_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(worker_id, day)
);

CREATE TABLE IF NOT EXISTS worker_tasks (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'GENERAL',  -- CHORE | ORDER | DELIVERY | STOCK | CLEANING | MAINTENANCE
  priority    TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  assignee_id TEXT NOT NULL REFERENCES workers(id),
  creator_id  TEXT,
  branch_id   TEXT REFERENCES branches(id),
  status      TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('CREATED','ASSIGNED','ACKNOWLEDGED','IN_PROGRESS','COMPLETED','VERIFIED','DECLINED','BLOCKED','OVERDUE','CANCELLED')),
  due_at      TEXT,
  recurrence  TEXT,                             -- NULL | DAILY | WEEKLY | MONTHLY
  ref_type    TEXT,                             -- order | delivery | grn ...
  ref_id      TEXT,
  evidence    TEXT NOT NULL DEFAULT '[]',
  sms_notified INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  completed_at  TEXT,
  verified_by   TEXT,
  score         REAL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON worker_tasks(assignee_id, status);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  number      TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'CALCULATED' CHECK (status IN ('CALCULATED','REVIEWED','APPROVED','EXECUTED','CANCELLED')),
  total_gross INTEGER NOT NULL DEFAULT 0,
  total_net   INTEGER NOT NULL DEFAULT 0,
  calculated_by TEXT,
  reviewed_by   TEXT,
  approved_by   TEXT,
  executed_by   TEXT,
  executed_at   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  worker_id   TEXT NOT NULL REFERENCES workers(id),
  days_worked REAL NOT NULL DEFAULT 0,
  gross       INTEGER NOT NULL DEFAULT 0,
  allowances  INTEGER NOT NULL DEFAULT 0,
  overtime    INTEGER NOT NULL DEFAULT 0,
  commission  INTEGER NOT NULL DEFAULT 0,
  deductions  INTEGER NOT NULL DEFAULT 0,
  advances    INTEGER NOT NULL DEFAULT 0,
  net         INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED')),
  paid_ref    TEXT,
  UNIQUE(run_id, worker_id)                     -- payroll cannot be computed twice per worker per run
);

-- Deliveries (§21)
CREATE TABLE IF NOT EXISTS deliveries (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  order_id    TEXT NOT NULL REFERENCES orders(id),
  driver_id   TEXT REFERENCES workers(id),
  vehicle     TEXT,
  route       TEXT,
  fee         INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PICKING','PACKED','READY','ASSIGNED','DISPATCHED','IN_TRANSIT','ARRIVED','DELIVERED','FAILED','RETURNED')),
  courier     TEXT,                             -- third-party provider code
  address     TEXT,
  instructions TEXT,
  otp_code    TEXT,                             -- customer verification code
  proof_type  TEXT,                             -- OTP | SIGNATURE | PHOTO | CONFIRM
  proof_ref   TEXT,
  assigned_at TEXT,
  dispatched_at TEXT,
  delivered_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_deliveries_status ON deliveries(tenant_id, status);
