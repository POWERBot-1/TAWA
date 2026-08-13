-- ============================================================
-- TAWA 003 — Customers, Quotes, Orders, Payments, Credit, Expenses, Ledger
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  type        TEXT NOT NULL DEFAULT 'RETAIL' CHECK (type IN ('RETAIL','WHOLESALE','CONTRACTOR','CORPORATE')),
  segment     TEXT NOT NULL DEFAULT 'RETAIL',
  branch_id   TEXT REFERENCES branches(id),
  broker_id   TEXT,
  loyalty_tier TEXT NOT NULL DEFAULT 'BRONZE',
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  notify_prefs TEXT NOT NULL DEFAULT '{"invoice":true,"payment":true,"dispatch":true,"delivery":true,"marketing":false}',
  address     TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_customers_tenant ON customers(tenant_id, name);

CREATE TABLE IF NOT EXISTS quotes (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  number       TEXT NOT NULL,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  project      TEXT,
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REVIEW','SENT','VIEWED','ACCEPTED','REJECTED','EXPIRED','CONVERTED')),
  valid_until  TEXT,
  salesperson_id TEXT,
  broker_id    TEXT,
  branch_id    TEXT REFERENCES branches(id),
  subtotal     INTEGER NOT NULL DEFAULT 0,
  discount     INTEGER NOT NULL DEFAULT 0,
  tax          INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  terms        TEXT,
  notes        TEXT,
  order_id     TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id        TEXT PRIMARY KEY,
  quote_id  TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  name_snap TEXT NOT NULL,
  qty       REAL NOT NULL CHECK (qty > 0),
  unit      TEXT NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  discount  INTEGER NOT NULL DEFAULT 0,
  tax       INTEGER NOT NULL DEFAULT 0,
  total     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_qitems_quote ON quote_items(quote_id);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  number        TEXT NOT NULL,
  customer_id   TEXT REFERENCES customers(id),
  quote_id      TEXT REFERENCES quotes(id),
  source        TEXT NOT NULL DEFAULT 'POS' CHECK (source IN ('POS','WEB','PHONE','WHATSAPP','BROKER','CORPORATE')),
  status        TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('DRAFT','CONFIRMED','PARTIALLY_FULFILLED','DELIVERING','DELIVERED','COMPLETED','CANCELLED')),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PARTIAL','PAID','REFUNDED','PARTIALLY_REFUNDED')),
  salesperson_id TEXT,
  broker_id     TEXT,
  branch_id     TEXT REFERENCES branches(id),
  warehouse_id  TEXT REFERENCES warehouses(id),
  subtotal      INTEGER NOT NULL DEFAULT 0,
  discount      INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  delivery_fee  INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  amount_paid   INTEGER NOT NULL DEFAULT 0,
  promotions    TEXT NOT NULL DEFAULT '[]',
  address       TEXT,
  notes         TEXT,
  is_credit     INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_idem ON orders(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_orders_tenant ON orders(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
  id        TEXT PRIMARY KEY,
  order_id  TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  name_snap TEXT NOT NULL,
  qty       REAL NOT NULL CHECK (qty > 0),
  unit      TEXT NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  cost_price INTEGER NOT NULL DEFAULT 0,
  discount  INTEGER NOT NULL DEFAULT 0,
  tax       INTEGER NOT NULL DEFAULT 0,
  total     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_oitems_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS ix_oitems_product ON order_items(product_id);

-- Payment engine (§18/19 Intent → Provider → Verification → Ledger)
CREATE TABLE IF NOT EXISTS payment_intents (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  order_id        TEXT REFERENCES orders(id),
  customer_id     TEXT REFERENCES customers(id),
  payee_type      TEXT NOT NULL DEFAULT 'TENANT' CHECK (payee_type IN ('TENANT','SUPPLIER','WORKER','BROKER','EXPENSE','REFUND','OTHER')),
  payee_id        TEXT,
  purpose         TEXT NOT NULL DEFAULT 'SALE' CHECK (purpose IN ('SALE','SUPPLIER_PAYMENT','WORKER_PAYMENT','BROKER_COMMISSION','EXPENSE','REFUND','SUBSCRIPTION','CREDIT_PAYMENT','OTHER')),
  amount          INTEGER NOT NULL CHECK (amount > 0),     -- minor units
  currency        TEXT NOT NULL DEFAULT 'KES',
  provider        TEXT NOT NULL,                           -- mpesa_sandbox | cash | card_sandbox | bank_manual
  method          TEXT NOT NULL,                           -- MPESA | CARD | BANK | CASH | MOBILE_MONEY | CREDIT
  status          TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','REQUIRES_ACTION','PROCESSING','PROVIDER_CONFIRMED','VERIFIED','SETTLED','FAILED','CANCELLED','EXPIRED','PARTIALLY_REFUNDED','REFUNDED')),
  idempotency_key TEXT NOT NULL,
  provider_ref    TEXT,
  phone           TEXT,
  authorized_by   TEXT,                                    -- human authorization record for outgoing/high-risk
  authorized_at   TEXT,
  meta            TEXT NOT NULL DEFAULT '{}',
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ix_intents_order ON payment_intents(order_id);

-- Payment events incl. webhook dedupe (§22)
CREATE TABLE IF NOT EXISTS payment_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  intent_id     TEXT,
  type          TEXT NOT NULL,
  provider      TEXT,
  provider_event_id TEXT,
  payload_hash  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(provider, provider_event_id)          -- replay protection at DB layer
);

-- Verified money movements only (verified server-side; never client-claimed)
CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  intent_id  TEXT NOT NULL REFERENCES payment_intents(id),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  fee        INTEGER NOT NULL DEFAULT 0,
  net        INTEGER NOT NULL DEFAULT 0,
  currency   TEXT NOT NULL DEFAULT 'KES',
  method     TEXT NOT NULL,
  provider   TEXT NOT NULL,
  reference  TEXT NOT NULL,                    -- provider reference / receipt no
  status     TEXT NOT NULL DEFAULT 'SETTLED' CHECK (status IN ('VERIFIED','SETTLED','REVERSED')),
  direction  TEXT NOT NULL DEFAULT 'INBOUND' CHECK (direction IN ('INBOUND','OUTBOUND')),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, provider, reference)
);
CREATE INDEX IF NOT EXISTS ix_payments_tenant ON payments(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','AUTHORIZED','PROCESSED','REJECTED')),
  requested_by TEXT,
  authorized_by TEXT,
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Credit engine (§27)
CREATE TABLE IF NOT EXISTS credit_accounts (
  customer_id  TEXT PRIMARY KEY REFERENCES customers(id),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  limit_amount INTEGER NOT NULL DEFAULT 0,
  balance      INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  approved_by  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  account_id   TEXT NOT NULL REFERENCES credit_accounts(customer_id),
  type         TEXT NOT NULL CHECK (type IN ('CHARGE','PAYMENT','ADJUST','LIMIT_CHANGE')),
  amount       INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_type     TEXT,
  ref_id       TEXT,
  actor_id     TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  number      TEXT NOT NULL,
  category    TEXT NOT NULL,
  description TEXT,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  status      TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','PAID')),
  payee       TEXT,
  method      TEXT,
  submitted_by TEXT,
  approved_by  TEXT,
  paid_ref     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(tenant_id, number)
);

-- Double-entry accounting (§29). Journal lines must balance per entry,
-- enforced in post() and by db trigger. Journal is append-only.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  parent_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  entry_no   TEXT NOT NULL,
  ref_type   TEXT,                            -- payment | sale_cogs | expense | payroll | supplier_payment | refund | credit
  ref_id     TEXT,
  memo       TEXT,
  actor_id   TEXT,
  posted_at  TEXT NOT NULL,
  UNIQUE(tenant_id, entry_no)
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id        TEXT PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  debit     INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit    INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0)
);
CREATE INDEX IF NOT EXISTS ix_jlines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS ix_jlines_acct ON journal_lines(account_id);

CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'journal_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS jlines_no_update BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'journal_lines is append-only'); END;

-- Document numbering registry (tenant-scoped, monotonic)
CREATE TABLE IF NOT EXISTS doc_counters (
  tenant_id TEXT NOT NULL,
  kind      TEXT NOT NULL,                    -- invoice | receipt | quote | order | po | expense | payroll
  next      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, kind)
);
