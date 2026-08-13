import { q, id, nowIso } from '../db/connection.js';
import { err } from '../core/http.js';
import { docNo } from './ledger.js';
import { fmtMoney } from './payments.js';
import { meter } from '../core/entitlements.js';

/**
 * Document engine (§37). Every document is branded per tenant branding.
 * Rendered as print-optimized HTML (browser → PDF adapter seam for later).
 */
function brand(db, tenantId) {
  return q.one(db, `SELECT * FROM tenant_branding WHERE tenant_id = ?`, tenantId) || {
    business_name: 'TAWA', logo_monogram: 'T', color_primary: '#F5A524', color_text: '#111',
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function nextDocumentNumber(db, tenantId, kind, prefixOverride = null) {
  const b = brand(db, tenantId);
  const prefix = prefixOverride || ({ invoice: b.invoice_prefix, receipt: b.receipt_prefix, quote: b.quote_prefix, order: b.order_prefix, po: b.po_prefix }[kind]) || 'DOC';
  return `${prefix}-${docNo(db, tenantId, kind)}`;
}

function shell(b, title, inner, { docNo, date, footer } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root { --primary: ${esc(b.color_primary)}; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #15181d; margin: 0; background: #f2f3f5; }
  .doc { max-width: 820px; margin: 24px auto; background: #fff; padding: 40px 44px; box-shadow: 0 2px 16px rgba(0,0,0,.08); border-radius: 8px;}
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 4px solid var(--primary); padding-bottom: 18px; margin-bottom: 22px; }
  .mono { width: 54px; height: 54px; border-radius: 12px; background: var(--primary); color: #15181d; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:26px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .5px; }
  .meta { color:#5b6470; font-size: 12.5px; line-height: 1.55; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0 8px; font-size: 13px; }
  th { text-align: left; text-transform: uppercase; font-size: 10.5px; letter-spacing: .8px; color: #5b6470; border-bottom: 2px solid #e4e7eb; padding: 8px 6px; }
  td { border-bottom: 1px solid #eef0f3; padding: 9px 6px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; width: 280px; font-size: 13px; }
  .totals div { display:flex; justify-content: space-between; padding: 5px 0; }
  .grand { font-size: 17px; font-weight: 800; border-top: 2px solid var(--primary); padding-top: 8px !important; }
  .status { display:inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #eceff3; }
  .foot { margin-top: 34px; padding-top: 14px; border-top: 1px solid #e4e7eb; color: #7b8492; font-size: 11.5px; line-height: 1.6; }
  .toolbar { max-width: 820px; margin: 18px auto 0; text-align: right; }
  .toolbar button { background: var(--primary); border:0; color:#15181d; font-weight:700; padding: 10px 18px; border-radius: 8px; cursor:pointer; }
  @media print { body{background:#fff} .doc{box-shadow:none;margin:0} .toolbar{display:none} }
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Print / Save PDF</button></div>
<div class="doc">
  <div class="head">
    <div style="display:flex; gap:14px; align-items:center">
      <div class="mono">${esc(b.logo_monogram || 'T')}</div>
      <div><h1>${esc(b.business_name)}</h1>
      <div class="meta">${esc(b.address || '')}${b.phone ? ' · ' + esc(b.phone) : ''}${b.email ? ' · ' + esc(b.email) : ''}</div></div>
    </div>
    <div class="meta" style="text-align:right">
      <div style="font-size:16px;font-weight:800;color:#15181d">${esc(title)}</div>
      <div>${esc(docNo || '')}</div><div>${esc(date || '')}</div>
    </div>
  </div>
  ${inner}
  <div class="foot">${esc(footer || b.doc_footer || 'Thank you for your business.')}${b.white_label ? '' : ' · Powered by TAWA'}</div>
</div></body></html>`;
}

const moneyRow = (label, value, cls = '') => `<div class="${cls}"><span>${esc(label)}</span><span>${value}</span></div>`;

export function invoiceDoc(db, tenantId, orderId) {
  const order = q.one(db, `SELECT * FROM orders WHERE id = ? AND tenant_id = ?`, orderId, tenantId);
  if (!order) throw err.notFound('Order not found');
  const items = q.all(db, `SELECT * FROM order_items WHERE order_id = ?`, orderId);
  const customer = order.customer_id ? q.one(db, `SELECT * FROM customers WHERE id = ?`, order.customer_id) : null;
  const b = brand(db, tenantId);
  const cur = (v) => fmtMoney(v, orderTenantCurrency(db, tenantId));
  const rows = items.map(i => `<tr><td>${esc(i.qty)} ${esc(i.unit)}</td><td>${esc(i.name_snap)}</td><td class="num">${cur(i.unit_price)}</td><td class="num">${cur(i.total)}</td></tr>`).join('');
  const inner = `
    <div class="meta" style="margin-bottom:10px">Bill to: <strong>${esc(customer?.name || 'Walk-in customer')}</strong>${customer?.phone ? ' · ' + esc(customer.phone) : ''}</div>
    <table><thead><tr><th>Qty</th><th>Item</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">
      ${moneyRow('Subtotal (excl. VAT)', cur(order.subtotal - order.discount))}
      ${order.discount ? moneyRow('Discount', '−' + cur(order.discount)) : ''}
      ${moneyRow('VAT', cur(order.tax))}
      ${order.delivery_fee ? moneyRow('Delivery', cur(order.delivery_fee)) : ''}
      ${moneyRow('TOTAL', cur(order.total), 'grand')}
      ${moneyRow('Paid', cur(order.amount_paid))}
      ${moneyRow('Balance', cur(Math.max(order.total - order.amount_paid, 0)))}
    </div>
    <div class="status">Payment: ${order.payment_status}</div>`;
  // register invoice number if absent
  return shell(b, `INVOICE ${order.number}`, inner, { docNo: order.number, date: new Date(order.created_at).toLocaleString('en-KE') });
}

function orderTenantCurrency(db, tenantId) {
  return q.one(db, `SELECT currency FROM tenants WHERE id = ?`, tenantId)?.currency || 'KES';
}

export function receiptDoc(db, tenantId, paymentId) {
  const p = q.one(db, `SELECT * FROM payments WHERE id = ? AND tenant_id = ?`, paymentId, tenantId);
  if (!p) throw err.notFound('Payment not found');
  const intent = q.one(db, `SELECT * FROM payment_intents WHERE id = ?`, p.intent_id);
  const order = intent?.order_id ? q.one(db, `SELECT * FROM orders WHERE id = ?`, intent.order_id) : null;
  const customer = intent?.customer_id ? q.one(db, `SELECT * FROM customers WHERE id = ?`, intent.customer_id) : null;
  const b = brand(db, tenantId);
  const cur = (v) => fmtMoney(v, p.currency);
  const inner = `
    <div class="meta" style="margin-bottom:14px">Received from: <strong>${esc(customer?.name || 'Walk-in customer')}</strong>${order ? ` · Order ${esc(order.number)}` : ''}</div>
    <table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>
    <tr><td>Payment received — ${esc(p.method)} (${esc(p.provider)})</td><td class="num">${cur(p.amount)}</td></tr>
    ${p.fee ? `<tr><td>Provider fee</td><td class="num">${cur(p.fee)}</td></tr>` : ''}
    </tbody></table>
    <div class="totals">${moneyRow('RECEIVED', cur(p.amount), 'grand')}${moneyRow('Reference', esc(p.reference))}</div>
    <div class="status">VERIFIED · ${esc(p.received_at)}</div>`;
  meter(db, tenantId, 'documents');
  return shell(b, `RECEIPT ${order?.number || p.reference}`, inner, { docNo: p.reference, date: new Date(p.received_at).toLocaleString('en-KE') });
}

export function quoteDoc(db, tenantId, quoteId) {
  const quote = q.one(db, `SELECT * FROM quotes WHERE id = ? AND tenant_id = ?`, quoteId, tenantId);
  if (!quote) throw err.notFound('Quote not found');
  const items = q.all(db, `SELECT * FROM quote_items WHERE quote_id = ?`, quoteId);
  const customer = q.one(db, `SELECT * FROM customers WHERE id = ?`, quote.customer_id);
  const b = brand(db, tenantId);
  const cur = (v) => fmtMoney(v, orderTenantCurrency(db, tenantId));
  const rows = items.map(i => `<tr><td>${esc(i.qty)} ${esc(i.unit)}</td><td>${esc(i.name_snap)}</td><td class="num">${cur(i.unit_price)}</td><td class="num">${cur(i.total)}</td></tr>`).join('');
  const inner = `
    <div class="meta" style="margin-bottom:10px">To: <strong>${esc(customer?.name)}</strong>${customer?.phone ? ' · ' + esc(customer.phone) : ''}${quote.project ? ` · Project: ${esc(quote.project)}` : ''}</div>
    <table><thead><tr><th>Qty</th><th>Item</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">
      ${moneyRow('Subtotal', cur(quote.subtotal))}
      ${quote.discount ? moneyRow('Discount', '−' + cur(quote.discount)) : ''}
      ${moneyRow('VAT', cur(quote.tax))}
      ${moneyRow('TOTAL', cur(quote.total), 'grand')}
    </div>
    <div class="meta">Valid until: ${esc(new Date(quote.valid_until).toLocaleDateString('en-KE'))} · Status: ${esc(quote.status)}${quote.terms ? `<br>Terms: ${esc(quote.terms)}` : ''}</div>`;
  return shell(b, `QUOTATION ${quote.number}`, inner, { docNo: quote.number, date: new Date(quote.created_at).toLocaleString('en-KE') });
}

export function deliveryNoteDoc(db, tenantId, deliveryId) {
  const d = q.one(db, `SELECT * FROM deliveries WHERE id = ? AND tenant_id = ?`, deliveryId, tenantId);
  if (!d) throw err.notFound('Delivery not found');
  const order = q.one(db, `SELECT * FROM orders WHERE id = ?`, d.order_id);
  const items = q.all(db, `SELECT * FROM order_items WHERE order_id = ?`, d.order_id);
  const customer = order?.customer_id ? q.one(db, `SELECT * FROM customers WHERE id = ?`, order.customer_id) : null;
  const b = brand(db, tenantId);
  const rows = items.map(i => `<tr><td>${esc(i.qty)} ${esc(i.unit)}</td><td>${esc(i.name_snap)}</td></tr>`).join('');
  const inner = `
    <div class="meta">Deliver to: <strong>${esc(customer?.name || 'Customer')}</strong>${customer?.phone ? ' · ' + esc(customer.phone) : ''}<br>
    Address: ${esc(d.address || order?.address || '—')}<br>Status: ${esc(d.status)}</div>
    <table><thead><tr><th>Qty</th><th>Item</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="meta">Proof of delivery: ${esc(d.proof_type || 'Customer confirmation')}${d.delivered_at ? ' · Delivered: ' + esc(d.delivered_at) : ''}</div>
    <div style="margin-top:36px" class="meta">Received by: ______________________ &nbsp;&nbsp;&nbsp; Signature: ______________________</div>`;
  return shell(b, `DELIVERY NOTE ${order?.number || ''}`, inner, { docNo: d.id.slice(-8).toUpperCase(), date: new Date(d.created_at).toLocaleString('en-KE') });
}

export function poDoc(db, tenantId, poId) {
  const po = q.one(db, `SELECT * FROM purchase_orders WHERE id = ? AND tenant_id = ?`, poId, tenantId);
  if (!po) throw err.notFound('Purchase order not found');
  const items = q.all(db, `SELECT * FROM po_items WHERE po_id = ?`, poId);
  const supplier = q.one(db, `SELECT * FROM suppliers WHERE id = ?`, po.supplier_id);
  const b = brand(db, tenantId);
  const cur = (v) => fmtMoney(v, orderTenantCurrency(db, tenantId));
  const rows = items.map(i => `<tr><td>${esc(i.qty)}</td><td>${esc(i.name_snap)}</td><td class="num">${cur(i.unit_cost)}</td><td class="num">${cur(i.total)}</td></tr>`).join('');
  const inner = `
    <div class="meta">Supplier: <strong>${esc(supplier?.name || '—')}</strong>${supplier?.phone ? ' · ' + esc(supplier.phone) : ''}<br>Expected: ${esc(po.expected_at ? new Date(po.expected_at).toLocaleDateString('en-KE') : '—')}</div>
    <table><thead><tr><th>Qty</th><th>Item</th><th class="num">Unit cost</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">${moneyRow('TOTAL', cur(po.total), 'grand')}</div>
    <div class="status">Status: ${esc(po.status)}</div>`;
  return shell(b, `PURCHASE ORDER ${po.number}`, inner, { docNo: po.number, date: new Date(po.created_at).toLocaleString('en-KE') });
}
void id; void nowIso;
