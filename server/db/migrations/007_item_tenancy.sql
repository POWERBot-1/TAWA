-- 007_item_tenancy.sql — defence-in-depth tenancy on line-item tables (§5, §6).
-- order_items / quote_items / po_items inherit tenancy from their parent document.
-- This migration persists that scoping physically (tenant_id column + backfill +
-- insert-time propagation) so storage-layer isolation does not depend solely on
-- join discipline at the application layer.

ALTER TABLE order_items ADD COLUMN tenant_id TEXT;
ALTER TABLE quote_items ADD COLUMN tenant_id TEXT;
ALTER TABLE po_items ADD COLUMN tenant_id TEXT;

UPDATE order_items SET tenant_id = (SELECT o.tenant_id FROM orders o WHERE o.id = order_items.order_id) WHERE tenant_id IS NULL;
UPDATE quote_items SET tenant_id = (SELECT q2.tenant_id FROM quotes q2 WHERE q2.id = quote_items.quote_id) WHERE tenant_id IS NULL;
UPDATE po_items SET tenant_id = (SELECT p.tenant_id FROM purchase_orders p WHERE p.id = po_items.po_id) WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_tenant ON order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_quote_items_tenant ON quote_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_po_items_tenant ON po_items(tenant_id);

-- Future inserts propagate tenancy automatically (statement-level, fails safe:
-- rows whose parent is missing simply remain NULL and are caught by integrity checks).
CREATE TRIGGER IF NOT EXISTS trg_order_items_tenant
AFTER INSERT ON order_items
BEGIN
  UPDATE order_items SET tenant_id = (SELECT o.tenant_id FROM orders o WHERE o.id = order_items.order_id) WHERE tenant_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_quote_items_tenant
AFTER INSERT ON quote_items
BEGIN
  UPDATE quote_items SET tenant_id = (SELECT q2.tenant_id FROM quotes q2 WHERE q2.id = quote_items.quote_id) WHERE tenant_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_po_items_tenant
AFTER INSERT ON po_items
BEGIN
  UPDATE po_items SET tenant_id = (SELECT p.tenant_id FROM purchase_orders p WHERE p.id = po_items.po_id) WHERE tenant_id IS NULL;
END;
