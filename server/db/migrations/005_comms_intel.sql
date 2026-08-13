-- ============================================================
-- TAWA 005 — Events, Notifications, Alerts, Marketing, Loyalty,
--            AI, Automation, Usage metering
-- ============================================================

-- Domain event log (§42). Append-only, drives alerts/automation/analytics.
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT,
  type       TEXT NOT NULL,                     -- OrderCreated, PaymentVerified ...
  payload    TEXT NOT NULL DEFAULT '{}',
  actor_id   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_tenant ON events(tenant_id, type, created_at DESC);

-- Universal notifications (§30). SMS/WhatsApp providers are sandbox adapters.
CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT,
  channel        TEXT NOT NULL CHECK (channel IN ('IN_APP','SMS','WHATSAPP','EMAIL','PUSH')),
  recipient_kind TEXT NOT NULL DEFAULT 'USER',  -- USER | CUSTOMER | WORKER | SUPPLIER | BROKER | ROLE
  recipient_id   TEXT,
  to_addr        TEXT,
  subject        TEXT,
  body           TEXT NOT NULL,
  priority       TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('INFO','LOW','NORMAL','HIGH','URGENT','CRITICAL')),
  status         TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','DELIVERED','FAILED','READ')),
  kind           TEXT NOT NULL DEFAULT 'TRANSACTIONAL' CHECK (kind IN ('TRANSACTIONAL','MARKETING','OPERATIONAL','SECURITY')),
  event_type     TEXT,
  ref_type       TEXT,
  ref_id         TEXT,
  provider       TEXT,
  provider_ref   TEXT,
  campaign_id    TEXT,
  created_at     TEXT NOT NULL,
  sent_at        TEXT,
  read_at        TEXT
);
CREATE INDEX IF NOT EXISTS ix_notif_tenant ON notifications(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_notif_recipient ON notifications(recipient_id, status);

-- Configurable alert rules (tenant)
CREATE TABLE IF NOT EXISTS alert_rules (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  event      TEXT NOT NULL,
  condition  TEXT NOT NULL DEFAULT '{}',
  channel    TEXT NOT NULL DEFAULT 'IN_APP',
  recipient_role TEXT,                          -- role name broadcast
  template   TEXT NOT NULL,
  priority   TEXT NOT NULL DEFAULT 'NORMAL',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Marketing (§33, Marketing extension §2–8)
CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  description TEXT,
  objective   TEXT,
  segment     TEXT NOT NULL DEFAULT 'ALL',
  offer       TEXT NOT NULL DEFAULT '{}',       -- {type,value,products[]}
  channels    TEXT NOT NULL DEFAULT '["SMS"]',
  budget      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','PAUSED','COMPLETED','CANCELLED')),
  starts_at   TEXT,
  ends_at     TEXT,
  created_by  TEXT,
  approved_by TEXT,
  ai_prepared INTEGER NOT NULL DEFAULT 0,
  stats       TEXT NOT NULL DEFAULT '{"recipients":0,"sent":0,"delivered":0,"orders":0,"revenue":0}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('PERCENT','FIXED','BXY','BUNDLE','QUANTITY')),
  value      REAL NOT NULL DEFAULT 0,
  buy_qty    REAL NOT NULL DEFAULT 0,
  get_qty    REAL NOT NULL DEFAULT 0,
  conditions TEXT NOT NULL DEFAULT '{}',
  starts_at  TEXT,
  ends_at    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS loyalty_tiers (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  min_points  INTEGER NOT NULL DEFAULT 0,
  perks       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, name)
);

-- AI insight cache + full AI action audit (§31, §28-29 security extension)
CREATE TABLE IF NOT EXISTS ai_insights (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'INFO',
  body       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  action     TEXT,
  status     TEXT NOT NULL DEFAULT 'FRESH' CHECK (status IN ('FRESH','ACKED','ACTIONED','DISMISSED')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_action_log (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  actor_id     TEXT,
  action_class TEXT NOT NULL CHECK (action_class IN ('READ','ANALYSE','RECOMMEND','PREPARE','EXECUTE')),
  question     TEXT,
  detail       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

-- Automation engine (§43): IF event+condition THEN action
CREATE TABLE IF NOT EXISTS automation_rules (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  name              TEXT NOT NULL,
  trigger_event     TEXT NOT NULL,
  condition         TEXT NOT NULL DEFAULT '{}',
  action_type       TEXT NOT NULL,              -- CREATE_PURCHASE_RECOMMENDATION | NOTIFY | ESCALATE | PREPARE_TASK
  action            TEXT NOT NULL DEFAULT '{}',
  requires_approval INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_fired_at     TEXT,
  created_at        TEXT NOT NULL
);

-- JATA Qi usage metering seam (§14): tenant-scoped, server-side counters
CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id TEXT NOT NULL,
  meter     TEXT NOT NULL,                     -- orders | api_calls | ai_requests | messages_sent | documents | deliveries
  period    TEXT NOT NULL,                     -- YYYY-MM
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, meter, period)
);
