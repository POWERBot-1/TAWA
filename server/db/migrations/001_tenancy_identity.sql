-- ============================================================
-- TAWA 001 — Tenancy, Identity, RBAC, Licensing, Audit
-- JATA Qi platform seam: identity/entitlement/licensing rows are
-- owned here but synchronized through the JataQiAdapter boundary.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,            -- alpha, buildpro
  name          TEXT NOT NULL,
  legal_name    TEXT,
  industry      TEXT NOT NULL DEFAULT 'HARDWARE',  -- HARDWARE | BUILDING_SUPPLIES | ELECTRICAL | PLUMBING | PAINT | INDUSTRIAL
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('TRIAL','ACTIVE','GRACE','RESTRICTED','SUSPENDED','EXPIRED','CANCELLED')),
  currency      TEXT NOT NULL DEFAULT 'KES',
  timezone      TEXT NOT NULL DEFAULT 'Africa/Nairobi',
  country       TEXT NOT NULL DEFAULT 'KE',
  locale        TEXT NOT NULL DEFAULT 'en-KE',
  tax_regime    TEXT NOT NULL DEFAULT 'VAT_16',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_domains (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  host        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'SUBDOMAIN' CHECK (kind IN ('SUBDOMAIN','CUSTOM','STOREFRONT','API')),
  is_primary  INTEGER NOT NULL DEFAULT 0,
  verified    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_domains_tenant ON tenant_domains(tenant_id);

-- White-label branding (per tenant). Semantic tokens; validated for contrast at write time.
CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id      TEXT PRIMARY KEY REFERENCES tenants(id),
  business_name  TEXT NOT NULL,
  tagline        TEXT,
  logo_monogram  TEXT NOT NULL DEFAULT 'T',
  logo_url       TEXT,
  favicon_url    TEXT,
  theme_mode     TEXT NOT NULL DEFAULT 'dark' CHECK (theme_mode IN ('dark','light')),
  color_primary  TEXT NOT NULL DEFAULT '#F5A524',
  color_secondary TEXT NOT NULL DEFAULT '#2A323D',
  color_accent   TEXT NOT NULL DEFAULT '#F5A524',
  color_background TEXT NOT NULL DEFAULT '#0C0F13',
  color_surface  TEXT NOT NULL DEFAULT '#141920',
  color_text     TEXT NOT NULL DEFAULT '#E9EDF2',
  color_success  TEXT NOT NULL DEFAULT '#3DDC84',
  color_warning  TEXT NOT NULL DEFAULT '#FFB020',
  color_error    TEXT NOT NULL DEFAULT '#F4503C',
  font_family    TEXT NOT NULL DEFAULT 'system',
  white_label    INTEGER NOT NULL DEFAULT 0,   -- 1 = TAWA marks removed from customer surfaces
  email_from     TEXT,
  sms_sender     TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  website        TEXT,
  socials        TEXT NOT NULL DEFAULT '{}',   -- {facebook,instagram,x,whatsapp}
  terms_url      TEXT,
  privacy_url    TEXT,
  doc_footer     TEXT,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  receipt_prefix TEXT NOT NULL DEFAULT 'RCP',
  quote_prefix   TEXT NOT NULL DEFAULT 'QTN',
  order_prefix   TEXT NOT NULL DEFAULT 'ORD',
  po_prefix      TEXT NOT NULL DEFAULT 'POR',
  updated_at     TEXT NOT NULL
);

-- Subscription plans (JATA Qi commercial configuration layer)
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,                -- FREE | STARTER | PROFESSIONAL | BUSINESS | ENTERPRISE | GOV_EDU
  name        TEXT NOT NULL,
  description TEXT,
  seat_limit  INTEGER NOT NULL DEFAULT 2,
  branch_limit INTEGER NOT NULL DEFAULT 1,
  product_limit INTEGER NOT NULL DEFAULT 50,
  monthly_price_minor INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'KES',
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entitlements (
  code    TEXT PRIMARY KEY,                    -- TAWA.POS, TAWA.AI ...
  label   TEXT NOT NULL,
  module  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan_id       TEXT NOT NULL REFERENCES plans(id),
  entitlement   TEXT NOT NULL REFERENCES entitlements(code),
  PRIMARY KEY (plan_id, entitlement)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('TRIAL','ACTIVE','GRACE','RESTRICTED','SUSPENDED','EXPIRED','CANCELLED')),
  starts_at   TEXT NOT NULL,
  renews_at   TEXT,
  trial_ends_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  product         TEXT NOT NULL DEFAULT 'tawa',
  product_version TEXT NOT NULL DEFAULT '1.0.0',
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  state           TEXT NOT NULL CHECK (state IN ('TRIAL','ACTIVE','GRACE','SUSPENDED','EXPIRED','CANCELLED')),
  starts_at       TEXT NOT NULL,
  expires_at      TEXT,
  issued_by       TEXT NOT NULL DEFAULT 'tawa-control-plane',
  environment     TEXT NOT NULL DEFAULT 'production',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feature_flags (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  flag      TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, flag)
);

-- Identity (tenant users; tenant_id NULL => platform operator)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,                 -- scrypt$N$salt$hash
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INVITED','SUSPENDED','LOCKED')),
  mfa_enabled   INTEGER NOT NULL DEFAULT 0,
  mfa_secret    TEXT,                          -- encrypted in prod; never logged
  linked_broker_id TEXT,
  linked_worker_id TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS roles (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),        -- NULL = system role template
  name      TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,                        -- inventory.adjust, payments.refund ...
  label TEXT NOT NULL,
  grp   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                 -- sha256(token)
  user_id    TEXT NOT NULL REFERENCES users(id),
  tenant_id  TEXT REFERENCES tenants(id),      -- server-derived; NEVER from client
  csrf       TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- Tamper-resistant audit (append-only; triggers block UPDATE/DELETE)
CREATE TABLE IF NOT EXISTS audit_events (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT,                          -- NULL only for platform-plane events
  actor_id       TEXT,
  actor_name     TEXT,
  action         TEXT NOT NULL,                 -- auth.login, inventory.adjust ...
  resource       TEXT,
  resource_id    TEXT,
  result         TEXT NOT NULL DEFAULT 'SUCCESS' CHECK (result IN ('SUCCESS','DENIED','FAILED')),
  reason         TEXT,
  metadata       TEXT NOT NULL DEFAULT '{}',    -- JSON metadata, never secrets
  ip             TEXT,
  correlation_id TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_tenant ON audit_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_events(action);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
