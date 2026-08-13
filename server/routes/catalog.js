import { q, id, nowIso } from '../db/connection.js';
import { ok, created, err, readBody, reqStr, optStr, reqNum, reqMoney, reqOneOf, reqArr, pageParams } from '../core/http.js';
import { mustPerm, hasPerm } from '../core/auth.js';
import { audit } from '../core/audit.js';
import { productRecommendations } from '../modules/ai.js';

const UNITS = ['piece', 'box', 'packet', 'bag', 'roll', 'meter', 'kg', 'litre', 'set', 'carton', 'bundle', 'pallet', 'length', 'sheet', 'drum'];

export function registerCatalog(router, db) {
  router.get('/api/v1/units', (req, res) => { ok(res, q.all(db, `SELECT * FROM units ORDER BY name`)); });

  router.get('/api/v1/categories', (req, res) => {
    mustPerm(req, 'catalog.view');
    ok(res, q.all(db, `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
                       FROM categories c WHERE c.tenant_id = ? ORDER BY c.sort, c.name`, req.tenantId));
  });
  router.post('/api/v1/categories', async (req, res) => {
    mustPerm(req, 'catalog.manage');
    const body = await readBody(req);
    const cid = id('cat');
    q.run(db, `INSERT INTO categories (id, tenant_id, name, parent_id, sort) VALUES (?,?,?,?,?)`,
      cid, req.tenantId, reqStr(body.name, 'name'), body.parent_id || null, Number(body.sort || 0));
    created(res, q.one(db, `SELECT * FROM categories WHERE id = ?`, cid));
  });

  /** Universal product search with hardware synonyms (§36) + barcode. */
  router.get('/api/v1/products', (req, res) => {
    mustPerm(req, 'catalog.view');
    const { limit, page, offset } = pageParams(req);
    const filters = ['p.tenant_id = ?'];
    const params = [req.tenantId];
    if (req.query.q) {
      let term = String(req.query.q).toLowerCase().trim();
      const syn = q.one(db, `SELECT target FROM search_synonyms WHERE tenant_id = ? AND term = ?`, req.tenantId, term);
      if (syn) term = syn.target;
      filters.push(`(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR p.barcode = ? OR LOWER(p.brand) LIKE ?)`);
      params.push(`%${term}%`, `%${term}%`, term, `%${term}%`);
    }
    if (req.query.category_id) { filters.push('p.category_id = ?'); params.push(req.query.category_id); }
    if (req.query.status) { filters.push('p.status = ?'); params.push(req.query.status); }
    if (req.query.active !== '0') filters.push('p.is_active = 1');
    const where = filters.join(' AND ');
    const total = q.one(db, `SELECT COUNT(*) AS n FROM products p WHERE ${where}`, ...params).n;
    const rows = q.all(db, `SELECT p.*, c.name AS category_name,
        (SELECT COALESCE(SUM(on_hand),0) FROM inventory_items i WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id) AS on_hand,
        (SELECT COALESCE(SUM(reserved),0) FROM inventory_items i WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id) AS reserved
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where} ORDER BY p.name LIMIT ? OFFSET ?`, ...params, limit, offset);
    ok(res, rows, { total, page, limit });
  });

  router.get('/api/v1/products/:id', (req, res) => {
    mustPerm(req, 'catalog.view');
    const p = q.one(db, `SELECT p.*, c.name AS category_name, s.name AS supplier_name FROM products p
      LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = ? AND p.tenant_id = ?`, req.params.id, req.tenantId);
    if (!p) throw err.notFound('Product not found');
    const stock = q.all(db, `SELECT i.*, w.name AS warehouse_name FROM inventory_items i JOIN warehouses w ON w.id = i.warehouse_id WHERE i.product_id = ? AND i.tenant_id = ?`, p.id, req.tenantId);
    const movements = q.all(db, `SELECT * FROM inventory_movements WHERE product_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 25`, p.id, req.tenantId);
    ok(res, { ...p, stock, movements, recommendations: productRecommendations(db, req.tenantId, p.id) });
  });

  router.post('/api/v1/products', async (req, res) => {
    mustPerm(req, 'catalog.manage');
    const body = await readBody(req);
    const v = validateProduct(body);
    if (q.one(db, `SELECT id FROM products WHERE tenant_id = ? AND sku = ?`, req.tenantId, v.sku)) throw err.conflict(`SKU ${v.sku} already exists`);
    const pid = id('prd');
    q.run(db, `INSERT INTO products (id, tenant_id, sku, barcode, name, brand, category_id, description, unit, pack_size, cost_price, price_retail, price_wholesale, price_contractor, price_min, tax_category, reorder_point, min_stock, max_stock, location, status, created_at, updated_at)
      VALUES (@id,@tenant_id,@sku,@barcode,@name,@brand,@category_id,@description,@unit,@pack_size,@cost_price,@price_retail,@price_wholesale,@price_contractor,@price_min,@tax_category,@reorder_point,@min_stock,@max_stock,@location,'ACTIVE',@created_at,@updated_at)`,
      { ...v, id: pid, tenant_id: req.tenantId, created_at: nowIso(), updated_at: nowIso() });
    audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'product.create', resource: 'product', resourceId: pid, metadata: { sku: v.sku, name: v.name } });
    created(res, q.one(db, `SELECT * FROM products WHERE id = ?`, pid));
  });

  router.patch('/api/v1/products/:id', async (req, res) => {
    mustPerm(req, 'catalog.manage');
    const p = q.one(db, `SELECT * FROM products WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId);
    if (!p) throw err.notFound('Product not found');
    const body = await readBody(req);
    const priceFields = ['price_retail', 'price_wholesale', 'price_contractor', 'price_min', 'cost_price'];
    const changedPrices = {};
    const sets = [];
    const params = {};
    for (const f of ['name', 'brand', 'description', 'barcode', 'unit', 'pack_size', 'location', 'status', 'tax_category', 'image_url']) {
      if (body[f] !== undefined) { sets.push(`${f} = @${f}`); params[f] = body[f]; }
    }
    for (const f of priceFields) {
      if (body[f] !== undefined) {
        const v = reqMoney(body[f], f);
        sets.push(`${f} = @${f}`); params[f] = v;
        if (v !== p[f]) changedPrices[f] = { from: p[f], to: v };
      }
    }
    for (const f of ['reorder_point', 'min_stock', 'max_stock']) {
      if (body[f] !== undefined) { sets.push(`${f} = @${f}`); params[f] = reqNum(body[f], f, { min: 0 }); }
    }
    if (body.category_id !== undefined) { sets.push('category_id = @category_id'); params.category_id = body.category_id || null; }
    if (Object.keys(changedPrices).length && !hasPerm(req, 'sales.discount') && !hasPerm(req, 'catalog.manage')) {} else {
      // Price change is a sensitive audited action (§39).
      if (Object.keys(changedPrices).length) {
        audit(db, { tenantId: req.tenantId, actorId: req.auth.user.id, action: 'product.price_change', resource: 'product', resourceId: p.id, metadata: { sku: p.sku, changes: changedPrices } });
      }
    }
    if (!sets.length) return ok(res, p);
    sets.push('updated_at = @updated_at'); params.updated_at = nowIso(); params.pid = p.id;
    q.run(db, `UPDATE products SET ${sets.join(', ')} WHERE id = @pid`, params);
    ok(res, q.one(db, `SELECT * FROM products WHERE id = ?`, p.id));
  });

  /** Product relationship graph (§8). */
  router.get('/api/v1/products/:id/relations', (req, res) => {
    mustPerm(req, 'catalog.view');
    if (!q.one(db, `SELECT id FROM products WHERE id = ? AND tenant_id = ?`, req.params.id, req.tenantId)) throw err.notFound('Product not found');
    ok(res, productRecommendations(db, req.tenantId, req.params.id));
  });
  router.post('/api/v1/products/:id/relations', async (req, res) => {
    mustPerm(req, 'catalog.manage');
    const body = await readBody(req);
    const type = reqOneOf(body.type, 'type', ['FBO', 'COMPATIBLE', 'ALTERNATIVE', 'REPLACEMENT', 'ACCESSORY', 'REQUIRED', 'BUNDLE']);
    const [a, b] = [req.params.id, reqStr(body.related_id, 'related_id')];
    if (a === b) throw err.unprocessable('A product cannot relate to itself');
    for (const pid of [a, b]) if (!q.one(db, `SELECT id FROM products WHERE id = ? AND tenant_id = ?`, pid, req.tenantId)) throw err.notFound('Product not found');
    q.run(db, `INSERT INTO product_relations (id, tenant_id, product_id, related_id, type, weight, created_at) VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(product_id, related_id, type) DO UPDATE SET weight = excluded.weight`,
      id('rel'), req.tenantId, a, b, type, Number(body.weight || 1), nowIso());
    created(res, { created: true });
  });

  /** Synonym manager for hardware aliases. */
  router.get('/api/v1/synonyms', (req, res) => {
    mustPerm(req, 'catalog.view');
    ok(res, q.all(db, `SELECT * FROM search_synonyms WHERE tenant_id = ? ORDER BY term`, req.tenantId));
  });
  router.post('/api/v1/synonyms', async (req, res) => {
    mustPerm(req, 'catalog.manage');
    const body = await readBody(req);
    q.run(db, `INSERT INTO search_synonyms (tenant_id, term, target) VALUES (?,?,?)
               ON CONFLICT(tenant_id, term) DO UPDATE SET target = excluded.target`,
      req.tenantId, reqStr(body.term, 'term').toLowerCase(), reqStr(body.target, 'target').toLowerCase());
    created(res, { saved: true });
  });
  void UNITS; void reqArr;
}

function validateProduct(body) {
  return {
    sku: reqStr(body.sku, 'sku', { max: 60 }).toUpperCase(),
    name: reqStr(body.name, 'name', { max: 200 }),
    brand: optStr(body.brand, 'brand'),
    barcode: optStr(body.barcode, 'barcode'),
    description: optStr(body.description, 'description', { max: 2000 }),
    category_id: optStr(body.category_id, 'category_id'),
    unit: reqOneOf(reqStr(body.unit, 'unit'), 'unit', validUnits),
    pack_size: optStr(body.pack_size, 'pack_size'),
    cost_price: body.cost_price != null ? reqMoney(body.cost_price, 'cost_price') : 0,
    price_retail: reqMoney(body.price_retail, 'price_retail'),
    price_wholesale: body.price_wholesale != null ? reqMoney(body.price_wholesale, 'price_wholesale') : 0,
    price_contractor: body.price_contractor != null ? reqMoney(body.price_contractor, 'price_contractor') : 0,
    price_min: body.price_min != null ? reqMoney(body.price_min, 'price_min') : 0,
    tax_category: reqOneOf(body.tax_category || 'VAT16', 'tax_category', ['VAT16', 'ZERO', 'EXEMPT']),
    reorder_point: reqNum(body.reorder_point ?? 0, 'reorder_point', { min: 0 }),
    min_stock: reqNum(body.min_stock ?? 0, 'min_stock', { min: 0 }),
    max_stock: reqNum(body.max_stock ?? 0, 'max_stock', { min: 0 }),
    location: optStr(body.location, 'location'),
  };
}
const validUnits = ['piece', 'box', 'packet', 'bag', 'roll', 'meter', 'kg', 'litre', 'set', 'carton', 'bundle', 'pallet', 'length', 'sheet', 'drum'];
