-- ============================================================
-- TAWA 002 — Branches, Warehouses, Catalogue, Product Graph, Inventory
-- ============================================================

CREATE TABLE IF NOT EXISTS branches (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  address   TEXT,
  phone     TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS warehouses (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  branch_id TEXT REFERENCES branches(id),
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  address   TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS categories (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name      TEXT NOT NULL,
  parent_id TEXT REFERENCES categories(id),
  sort      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS units (
  id     TEXT PRIMARY KEY,
  code   TEXT NOT NULL UNIQUE,                  -- piece, bag, meter, kg, litre, roll, box, carton, bundle, pallet, set, packet
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL DEFAULT 'COUNT'          -- COUNT | LENGTH | MASS | VOLUME
);

CREATE TABLE IF NOT EXISTS unit_conversions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  product_id TEXT,                              -- NULL = tenant-wide rule
  from_unit  TEXT NOT NULL REFERENCES units(code),
  to_unit    TEXT NOT NULL REFERENCES units(code),
  factor     REAL NOT NULL CHECK (factor > 0)
);

CREATE TABLE IF NOT EXISTS products (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  sku            TEXT NOT NULL,
  barcode        TEXT,
  qr_code        TEXT,
  name           TEXT NOT NULL,
  brand          TEXT,
  category_id    TEXT REFERENCES categories(id),
  description    TEXT,
  image_url      TEXT,
  video_url      TEXT,
  unit           TEXT NOT NULL REFERENCES units(code),
  pack_size      TEXT,
  weight_kg      REAL,
  dimensions     TEXT,
  supplier_id    TEXT,
  supplier_sku   TEXT,
  cost_price     INTEGER NOT NULL DEFAULT 0,    -- minor units
  price_retail   INTEGER NOT NULL DEFAULT 0,
  price_wholesale INTEGER NOT NULL DEFAULT 0,
  price_contractor INTEGER NOT NULL DEFAULT 0,
  price_min      INTEGER NOT NULL DEFAULT 0,
  tax_category   TEXT NOT NULL DEFAULT 'VAT16' CHECK (tax_category IN ('VAT16','ZERO','EXEMPT')),
  reorder_point  REAL NOT NULL DEFAULT 0,
  min_stock      REAL NOT NULL DEFAULT 0,
  max_stock      REAL NOT NULL DEFAULT 0,
  location       TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DRAFT','ARCHIVED')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS ix_products_tenant_name ON products(tenant_id, name);
CREATE INDEX IF NOT EXISTS ix_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS ix_products_barcode ON products(tenant_id, barcode);

-- Hardware product relationship graph (§8)
CREATE TABLE IF NOT EXISTS product_relations (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  related_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('FBO','COMPATIBLE','ALTERNATIVE','REPLACEMENT','ACCESSORY','REQUIRED','BUNDLE')),
  weight     REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(product_id, related_id, type)
);

-- Hardware synonym / alias index (§36) e.g. "pvc bend" -> "pvc elbow"
CREATE TABLE IF NOT EXISTS search_synonyms (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  term      TEXT NOT NULL,
  target    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, term)
);

-- Inventory position (derived from movements; authoritative cache)
CREATE TABLE IF NOT EXISTS inventory_items (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  product_id   TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  on_hand      REAL NOT NULL DEFAULT 0, -- negative guarded in code; allowed only via explicit tenant permit
  reserved     REAL NOT NULL DEFAULT 0,
  damaged      REAL NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, product_id, warehouse_id)
);

-- IMMUTABLE movement audit (§9 §51). DB triggers forbid mutation.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  warehouse_id  TEXT NOT NULL REFERENCES warehouses(id),
  type          TEXT NOT NULL CHECK (type IN ('RECEIVE','ISSUE','ADJUST','TRANSFER_OUT','TRANSFER_IN','RESERVE','RELEASE','RETURN','DAMAGE','COUNT')),
  qty_delta     REAL NOT NULL,                  -- signed, in base units
  on_hand_after REAL NOT NULL,
  reason        TEXT,
  ref_type      TEXT,                           -- order | grn | transfer | adjustment | pos
  ref_id        TEXT,
  actor_id      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_moves_product ON inventory_movements(product_id, warehouse_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_moves_tenant ON inventory_movements(tenant_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS moves_no_update BEFORE UPDATE ON inventory_movements
BEGIN SELECT RAISE(ABORT, 'inventory_movements is append-only'); END;
CREATE TRIGGER IF NOT EXISTS moves_no_delete BEFORE DELETE ON inventory_movements
BEGIN SELECT RAISE(ABORT, 'inventory_movements is append-only'); END;

-- Reserved/held stock against orders
CREATE TABLE IF NOT EXISTS stock_reservations (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  order_id   TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  qty        REAL NOT NULL CHECK (qty > 0),
  status     TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FULFILLED','RELEASED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_resv_order ON stock_reservations(order_id);
