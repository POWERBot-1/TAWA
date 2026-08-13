-- ============================================================
-- TAWA 006 — Sandbox provider records + Auto-Pay module
-- ============================================================

-- SANDBOX payment provider ledger: emulates provider-side state so that
-- verification is real (server asks provider, not client). §20.
CREATE TABLE IF NOT EXISTS sandbox_provider_records (
  provider_ref TEXT PRIMARY KEY,
  intent_id    TEXT NOT NULL,
  provider     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCESS','FAILED','TIMEOUT','REVERSED')),
  amount       INTEGER NOT NULL,
  phone        TEXT,
  receipt_no   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Optional Auto-Pay module (§26 evolution spec §19). Entitlement-gated.
CREATE TABLE IF NOT EXISTS autopay_rules (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  name          TEXT NOT NULL,
  purpose       TEXT NOT NULL CHECK (purpose IN ('SUPPLIER_PAYMENT','WORKER_PAYMENT','BROKER_COMMISSION','EXPENSE','SUBSCRIPTION','OTHER')),
  payee_id      TEXT,
  funding_source TEXT NOT NULL DEFAULT 'MPESA',
  max_amount    INTEGER NOT NULL CHECK (max_amount > 0),
  frequency     TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','ON_APPROVAL')),
  approval_policy TEXT NOT NULL DEFAULT 'REQUIRE_CONFIRMATION' CHECK (approval_policy IN ('REQUIRE_CONFIRMATION','AMOUNT_LIMIT_ONLY')),
  failure_policy TEXT NOT NULL DEFAULT 'NOTIFY',
  notify_policy  TEXT NOT NULL DEFAULT 'ALWAYS',
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  last_run_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_autopay_tenant ON autopay_rules(tenant_id);
