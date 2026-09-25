// Inventory drift audit. Read-only diagnostic: no writes to the DB, no calls
// to anything in server.js.
//
//   node scripts/drift-audit.js [--days 90] [--json out.json]
//
// Env:
//   DRIFT_DB_URL or DATABASE_PUBLIC_URL or DATABASE_URL   public Railway URL (proxy.rlwy.net)
//   SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET                    Firmolux
//   VIOLANTE_SHIPSTATION_API_KEY / VIOLANTE_SHIPSTATION_API_SECRET  VIOLANTE
//
// What it does:
//   1. Pulls every shipment (items included) for the window from both
//      ShipStation accounts via REST, plus the orders behind them, plus orders
//      marked shipped with no label (where freight usually hides).
//   2. Matches them to inventory_audit (change_type='shipment') and
//      shipment_log rows by brand + order number. We do not store shipment ids,
//      so matching is per order; multi-shipment orders are split by comparing
//      what each shipment should have deducted against the order's total.
//   3. Buckets each shipment and prints a summary, then every non-OK row, then
//      audit rows with no matching live shipment.
require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');
const { parseSKU } = require('../src/sku-parser');

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DAYS = parseInt(argVal('--days', '90'), 10);
const JSON_OUT = argVal('--json', null);

const WINDOW_END = new Date();
const WINDOW_START = new Date(WINDOW_END.getTime() - DAYS * 86400000);
// Audit rows are pulled with slack on both ends so a label printed just
// before the window, or a webhook that landed a day late, still matches.
const AUDIT_SLACK_DAYS = 7;

const FREIGHT_RE = /freight|ltl|truck|pallet/i;

const BRANDS = [
  { brand: 'Firmolux', key: process.env.SHIPSTATION_API_KEY, secret: process.env.SHIPSTATION_API_SECRET },
  { brand: 'VIOLANTE', key: process.env.VIOLANTE_SHIPSTATION_API_KEY, secret: process.env.VIOLANTE_SHIPSTATION_API_SECRET },
];

// parseSKU logs every attempt; keep the report readable.
function quietParse(sku, brand) {
  const orig = console.log;
  console.log = () => {};
  try { return parseSKU(sku, brand); } finally { console.log = orig; }
}

const ymd = d => d.toISOString().slice(0, 10);
const round = n => Math.round(n * 100) / 100;

// ─── ShipStation ──────────────────────────────────────────────────────────────
function ssClient({ key, secret }) {
  const http = axios.create({
    baseURL: 'https://ssapi.shipstation.com',
    auth: { username: key, password: secret },
    timeout: 60000,
  });
  // 40 req/min per key. Honour the rate-limit headers; sleep until reset
  // when we're nearly out. Retries 429 a bounded number of times.
  async function get(path, params) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await http.get(path, { params });
        const remaining = parseInt(res.headers['x-rate-limit-remaining'] || '40', 10);
        const reset = parseInt(res.headers['x-rate-limit-reset'] || '0', 10);
        if (remaining <= 2) await sleep((reset + 1) * 1000);
        return res.data;
      } catch (err) {
        if (err.response && err.response.status === 429) {
          const reset = parseInt(err.response.headers['x-rate-limit-reset'] || '30', 10);
          await sleep((reset + 1) * 1000);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`ShipStation ${path}: rate limited 5 times, giving up`);
  }
  async function getAll(path, params, listKey) {
    const out = [];
    let page = 1;
    for (;;) {
      const data = await get(path, { ...params, page, pageSize: 500 });
      out.push(...(data[listKey] || []));
      if (!data.pages || page >= data.pages) break;
      page++;
    }
    return out;
  }
  return { get, getAll };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pullBrand(b) {
  const ss = ssClient(b);
  process.stderr.write(`[${b.brand}] fetching shipments…\n`);
  const shipments = await ss.getAll('/shipments', {
    shipDateStart: ymd(WINDOW_START),
    shipDateEnd: ymd(new Date(WINDOW_END.getTime() + 86400000)),
    includeShipmentItems: true,
  }, 'shipments');

  // Orders: bulk by modifyDate (shipping touches the order), then fill gaps
  // one at a time for orders created long before the window.
  process.stderr.write(`[${b.brand}] ${shipments.length} shipments; fetching orders…\n`);
  const orders = new Map();
  const bulk = await ss.getAll('/orders', {
    modifyDateStart: ymd(new Date(WINDOW_START.getTime() - 86400000)),
  }, 'orders');
  for (const o of bulk) orders.set(o.orderId, o);
  const missing = [...new Set(shipments.map(s => s.orderId))].filter(id => id && !orders.has(id));
  for (const id of missing) {
    try { orders.set(id, await ss.get(`/orders/${id}`)); }
    catch (err) { process.stderr.write(`[${b.brand}] order ${id}: ${err.message}\n`); }
  }

  // Orders marked shipped with no label in ShipStation. Freight usually
  // lands here: no label → no ITEM_SHIP_NOTIFY → no deduction. Confirm each
  // one really has no shipment on record (it may have shipped before the
  // window).
  const shippedIds = new Set(shipments.map(s => s.orderId));
  const noLabel = [];
  for (const o of bulk) {
    if (o.orderStatus !== 'shipped' || shippedIds.has(o.orderId)) continue;
    const when = new Date(o.shipDate || o.modifyDate);
    if (when < WINDOW_START) continue;
    const prior = await ss.get('/shipments', { orderId: o.orderId, includeShipmentItems: true });
    const live = (prior.shipments || []).filter(s => !s.voided);
    if (live.length === 0) noLabel.push(o);
  }
  process.stderr.write(`[${b.brand}] ${orders.size} orders, ${noLabel.length} shipped with no label\n`);
  return { shipments, orders, noLabel };
}

// ─── Deduction model (mirrors handleShipmentWebhook) ─────────────────────────
const KIT_CODES = ['KRH', 'KIT-T', 'KIT-U'];

// What the webhook *should* deduct for a list of items, per product. Kits use
// kit_components from the DB. Kit detection intentionally mirrors server.js,
// which checks sku.split('-')[0]: that never equals 'KIT-T' / 'KIT-U', so those
// kits fall through to parseSKU and fail. We record what *should* have been
// deducted (the kit components) and flag the SKU as failing in production.
function expectedFor(items, brand, kits) {
  const byProduct = {};
  const failed = [];
  const noSku = [];
  for (const it of items || []) {
    const qty = it.quantity || 1;
    if (!it.sku) { noSku.push(`${it.name || '(no name)'} x${qty}`); continue; }
    const head = it.sku.split('-')[0].toUpperCase();
    const fullUpper = it.sku.toUpperCase();
    const kit = KIT_CODES.includes(head) ? head
      : KIT_CODES.find(k => fullUpper === k || fullUpper.startsWith(k + '-')) || null;
    if (kit && kits[kit]) {
      for (const c of kits[kit]) add(byProduct, c.product_code, c.qty_per_kit * qty);
      if (!KIT_CODES.includes(head)) failed.push(`${it.sku} (kit not detected by webhook)`);
      continue;
    }
    const p = quietParse(it.sku, brand);
    if (!p) { failed.push(it.sku); continue; }
    add(byProduct, p.productCode, p.qty * qty);
  }
  return { byProduct, failed, noSku };
}
function add(obj, k, v) { obj[k] = round((obj[k] || 0) + Number(v)); }
function sumVals(o) { return round(Object.values(o).reduce((a, b) => a + b, 0)); }
function fmtProducts(o) {
  const keys = Object.keys(o).filter(k => Math.abs(o[k]) > 1e-9).sort();
  return keys.length ? keys.map(k => `${k} ${round(o[k])}`).join(', ') : '—';
}
function fmtItems(items) {
  return (items || []).length
    ? items.map(i => `${i.sku || '(no sku)'} x${i.quantity || 1}`).join(', ')
    : '(none)';
}
function diff(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = round((a[k] || 0) - (b[k] || 0));
    if (Math.abs(d) > 1e-6) out[k] = d;
  }
  return out;
}

// Order tags written by the webhook: "Order #<orderNumber>" (or orderId).
function orderKeyFromSource(source) {
  const m = /^Order #(.+)$/.exec(source || '');
  return m ? m[1].trim() : null;
}
// shipment_log.shipstation_order_id: "#<orderNumber> - <customer>".
function orderKeyFromLogId(id) {
  const m = /^#(.+?)(?: - .*)?$/.exec(id || '');
  return m ? m[1].trim() : null;
}

// ─── DB ───────────────────────────────────────────────────────────────────────
function dbUrl() {
  const url = process.env.DRIFT_DB_URL || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DRIFT_DB_URL (public proxy.rlwy.net URL)');
  if (/railway\.internal/.test(url)) {
    throw new Error('DB URL is the private railway.internal host; use the public proxy.rlwy.net URL (DRIFT_DB_URL)');
  }
  return url;
}

async function loadDb() {
  const pool = new Pool({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  try {
    // Belt and braces: this session cannot write.
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const since = new Date(WINDOW_START.getTime() - AUDIT_SLACK_DAYS * 86400000);
    const products = (await client.query('SELECT code, name, unit FROM products')).rows;
    const kitRows = (await client.query('SELECT kit_code, product_code, qty_per_kit FROM kit_components')).rows;
    const audit = (await client.query(
      `SELECT id, product_code, delta_qty, source, note, brand, created_at
         FROM inventory_audit
        WHERE change_type = 'shipment' AND created_at >= $1
        ORDER BY created_at`, [since])).rows;
    const log = (await client.query(
      `SELECT id, shipstation_order_id, deductions, brand, processed_at
         FROM shipment_log
        WHERE processed_at >= $1
        ORDER BY processed_at`, [since])).rows;
    const kits = {};
    for (const k of kitRows) (kits[k.kit_code] ||= []).push(k);
    return { products, kits, audit, log };
  } finally {
    client.release();
    await pool.end();
  }
}

// ─── Classification ───────────────────────────────────────────────────────────
async function main() {
  for (const b of BRANDS) {
    if (!b.key || !b.secret) throw new Error(`Missing ShipStation credentials for ${b.brand}`);
  }
  const db = await loadDb();
  const units = Object.fromEntries(db.products.map(p => [p.code, p.unit]));

  // Index DB rows by brand|orderKey.
  const auditBy = new Map();
  for (const r of db.audit) {
    const k = `${r.brand || 'Firmolux'}|${orderKeyFromSource(r.source)}`;
    if (!auditBy.has(k)) auditBy.set(k, []);
    auditBy.get(k).push(r);
  }
  const logBy = new Map();
  for (const r of db.log) {
    const k = `${r.brand || 'Firmolux'}|${orderKeyFromLogId(r.shipstation_order_id)}`;
    if (!logBy.has(k)) logBy.set(k, []);
    logBy.get(k).push(r);
  }
  const matchedAuditIds = new Set();

  const rows = [];      // one per shipment (or no-label order)
  const orderNotes = []; // per-order observations (misattribution etc.)
  const voidedWithDeduction = [];

  for (const b of BRANDS) {
    const { shipments, orders, noLabel } = await pullBrand(b);

    // Group live shipments by orderNumber (split orders share a number).
    const live = shipments.filter(s => !s.voided);
    const voided = shipments.filter(s => s.voided);
    const byOrder = new Map();
    for (const s of live) {
      const k = s.orderNumber || String(s.orderId);
      if (!byOrder.has(k)) byOrder.set(k, []);
      byOrder.get(k).push(s);
    }
    const ordersByNumber = new Map();
    for (const o of orders.values()) {
      if (o.orderStatus === 'cancelled') continue;
      const k = o.orderNumber || String(o.orderId);
      if (!ordersByNumber.has(k)) ordersByNumber.set(k, []);
      ordersByNumber.get(k).push(o);
    }

    const auditFor = (orderNumber, orderIds) => {
      const keys = [orderNumber, ...orderIds.map(String)];
      const out = [];
      for (const k of new Set(keys)) out.push(...(auditBy.get(`${b.brand}|${k}`) || []));
      return out;
    };
    const logFor = (orderNumber, orderIds) => {
      const out = [];
      for (const k of new Set([orderNumber, ...orderIds.map(String)])) out.push(...(logBy.get(`${b.brand}|${k}`) || []));
      return out;
    };

    for (const [orderNumber, ships] of byOrder) {
      ships.sort((a, c) => new Date(a.createDate) - new Date(c.createDate));
      const orderIds = [...new Set(ships.map(s => s.orderId))];
      const orderObjs = ordersByNumber.get(orderNumber) || orderIds.map(id => orders.get(id)).filter(Boolean);
      const orderItems = orderObjs.flatMap(o => (o.items || []).filter(i => !i.adjustment));
      const orderExpected = expectedFor(orderItems, b.brand, db.kits).byProduct;
      const orderUnits = orderItems.reduce((a, i) => a + (i.quantity || 1), 0);

      const aRows = auditFor(orderNumber, orderIds);
      aRows.forEach(r => matchedAuditIds.add(r.id));
      const deducted = {};
      for (const r of aRows) add(deducted, r.product_code, -Number(r.delta_qty));
      const lRows = logFor(orderNumber, orderIds);
      const loggedFailed = lRows.map(r => r.deductions && r.deductions.failedSkus).filter(Boolean);

      // Deductions whose SKU note isn't on any of this order's shipments:
      // the webhook flattens every shipment in a batch and tags them all
      // with the first shipment's order number.
      const shippedSkus = new Set(ships.flatMap(s => (s.shipmentItems || []).map(i => (i.sku || '').toUpperCase())));
      const foreign = aRows.filter(r => {
        const sku = (r.note || '').replace(/ x[\d.]+$/, '').toUpperCase();
        return sku && !KIT_CODES.includes(sku) && !shippedSkus.has(sku);
      });
      if (foreign.length) {
        orderNotes.push({ brand: b.brand, orderNumber, note: `audit rows for SKUs not on this order's shipments (batch misattribution?): ${foreign.map(r => r.note).join('; ')}` });
      }

      // Walk shipments in order. Each shipment's "should deduct" is what the
      // webhook would compute from its items; cumulative shipped vs order
      // decides MULTI-PACKAGE (splitting the order) vs RESHIP (going past it).
      let remainingDeducted = { ...deducted };
      const shipExp = ships.map(s => expectedFor(s.shipmentItems, b.brand, db.kits));
      // Pre-pass: which shipments push cumulative shipped past the order?
      const cumShipped = {};
      const beyond = shipExp.map(e => {
        const out = {};
        for (const [k, v] of Object.entries(e.byProduct)) {
          const before = cumShipped[k] || 0;
          add(cumShipped, k, v);
          const over = round(Math.min(v, Math.max(0, cumShipped[k] - Math.max(before, orderExpected[k] || 0))));
          if (over > 0) out[k] = over;
        }
        return out;
      });
      // Packages = shipments with items that stay within the order.
      const isPackage = ships.map((s, i) => (s.shipmentItems || []).length > 0 && !(i > 0 && Object.keys(beyond[i]).length));
      const packageCount = isPackage.filter(Boolean).length;
      const packagesExpected = {};
      shipExp.forEach((e, i) => { if (isPackage[i]) for (const [k, v] of Object.entries(e.byProduct)) add(packagesExpected, k, v); });

      ships.forEach((s, idx) => {
        const exp = shipExp[idx];
        const carrier = [s.carrierCode, s.serviceCode].filter(Boolean).join(' / ');
        const base = {
          date: (s.shipDate || s.createDate || '').slice(0, 10),
          brand: b.brand,
          orderNumber,
          shipmentId: s.shipmentId,
          carrier,
          skus: fmtItems(s.shipmentItems),
          expected: exp.byProduct,
          orderUnits,
          orderKg: sumVals(orderExpected),
          webhookEvents: lRows.length,
        };

        // Allocate this order's deductions to this shipment greedily.
        const got = {};
        for (const [k, v] of Object.entries(exp.byProduct)) {
          const take = Math.min(v, Math.max(0, remainingDeducted[k] || 0));
          if (take > 0) { got[k] = round(take); remainingDeducted[k] = round(remainingDeducted[k] - take); }
        }
        const beyondOrder = beyond[idx];

        let bucket, reason;
        const missing = diff(exp.byProduct, got);
        const reasons = [];
        if (exp.failed.length) reasons.push(`unparseable: ${exp.failed.join(' | ')}`);
        if (exp.noSku.length) reasons.push(`no SKU (skipped silently): ${exp.noSku.join(', ')}`);
        if (loggedFailed.length && idx === 0) reasons.push(`failedSkus logged: ${loggedFailed.join(' || ')}`);

        const isFreight = FREIGHT_RE.test(carrier) || FREIGHT_RE.test(orderObjs.map(o => o.requestedShippingService || '').join(' '));
        if (isFreight) {
          bucket = 'FREIGHT';
          reasons.unshift(sumVals(got) > 0 ? 'freight shipment, deducted' : 'freight shipment, nothing deducted');
        } else if ((s.shipmentItems || []).length === 0) {
          bucket = 'ZERO ITEMS';
          reasons.unshift(idx > 0 ? 'later shipment with no line items (manual reship?)' : 'shipment has no line items');
          if (orderUnits) reasons.push(`order has ${orderUnits} units / ${sumVals(orderExpected)} kg`);
        } else if (idx > 0 && Object.keys(beyondOrder).length) {
          bucket = 'RESHIP';
          // How many times over was the order deducted, across all its shipments?
          const orderKg = sumVals(orderExpected);
          const times = orderKg ? round(sumVals(deducted) / orderKg) : null;
          const verdict = times === null ? `order deducted ${fmtProducts(deducted)}`
            : times < 0.05 ? 'order never deducted at all'
            : times < 1.5 ? `order deducted once (${times}x) — reship NOT deducted`
            : `order deducted again (${times}x)`;
          reasons.unshift(`reship beyond order qty (${fmtProducts(beyondOrder)}); ${verdict}; ${lRows.length} webhook event(s)`);
        } else if (packageCount > 1) {
          bucket = 'MULTI-PACKAGE';
          const match = Object.keys(diff(packagesExpected, orderExpected)).length === 0;
          const n = isPackage.slice(0, idx + 1).filter(Boolean).length;
          reasons.unshift(`package ${n}/${packageCount}; packages total ${match ? 'matches' : 'DIFFERS from'} order (shipped ${fmtProducts(packagesExpected)} vs order ${fmtProducts(orderExpected)}); order deducted ${fmtProducts(deducted)} over ${lRows.length} webhook event(s)`);
          if (sumVals(missing) > 0) reasons.push(`this package short: ${fmtProducts(missing)}`);
        } else if (sumVals(exp.byProduct) === 0 && (exp.failed.length || exp.noSku.length)) {
          bucket = sumVals(deducted) ? 'PARTIAL' : 'NO DEDUCTION';
        } else if (sumVals(got) === 0) {
          bucket = 'NO DEDUCTION';
          reasons.unshift(lRows.length ? 'webhook logged but no audit rows' : 'no webhook log and no audit rows');
        } else if (sumVals(missing) > 0 || exp.failed.length || exp.noSku.length) {
          bucket = 'PARTIAL';
          if (sumVals(missing) > 0) reasons.unshift(`short: ${fmtProducts(missing)}`);
        } else {
          bucket = 'DEDUCTED OK';
        }
        rows.push({ ...base, bucket, got, reason: reasons.join('; ') });
      });

      // Anything deducted but not claimed by a shipment = over-deduction
      // (duplicate webhook, misattribution). Attach it to the order's first row.
      const leftover = Object.fromEntries(Object.entries(remainingDeducted).filter(([, v]) => v > 1e-6));
      if (Object.keys(leftover).length) {
        const first = rows.find(r => r.brand === b.brand && r.orderNumber === orderNumber);
        first.overDeducted = leftover;
        first.reason = [first.reason, `OVER-deducted ${fmtProducts(leftover)} across ${lRows.length} webhook event(s)`].filter(Boolean).join('; ');
        if (first.bucket === 'DEDUCTED OK') first.bucket = 'DUPLICATE';
      }
    }

    // Orders marked shipped with no label.
    for (const o of noLabel) {
      const items = (o.items || []).filter(i => !i.adjustment);
      const exp = expectedFor(items, b.brand, db.kits);
      const k = o.orderNumber || String(o.orderId);
      const aRows = auditFor(k, [o.orderId]);
      aRows.forEach(r => matchedAuditIds.add(r.id));
      const got = {};
      for (const r of aRows) add(got, r.product_code, -Number(r.delta_qty));
      const svc = [o.carrierCode, o.serviceCode, o.requestedShippingService].filter(Boolean).join(' / ');
      rows.push({
        date: (o.shipDate || o.modifyDate || '').slice(0, 10),
        brand: b.brand,
        orderNumber: k,
        shipmentId: '(no label)',
        carrier: svc || '(none)',
        skus: fmtItems(items),
        expected: exp.byProduct,
        got,
        bucket: FREIGHT_RE.test(svc) ? 'FREIGHT' : 'NO LABEL',
        reason: `order marked shipped with no ShipStation label (webhook never fires)${exp.failed.length ? `; unparseable: ${exp.failed.join(' | ')}` : ''}`,
      });
    }

    // Voided labels that still carry a deduction the order doesn't justify
    // are handled by the orphan pass below; record them for the orphan reason.
    for (const s of voided) voidedWithDeduction.push({ brand: b.brand, orderNumber: s.orderNumber || String(s.orderId), shipmentId: s.shipmentId, voidDate: s.voidDate });
  }

  // Audit rows with no matching live shipment in the window.
  const voidedIdx = new Map();
  for (const v of voidedWithDeduction) {
    const k = `${v.brand}|${v.orderNumber}`;
    if (!voidedIdx.has(k)) voidedIdx.set(k, []);
    voidedIdx.get(k).push(v);
  }
  const orphans = db.audit
    .filter(r => !matchedAuditIds.has(r.id) && new Date(r.created_at) >= WINDOW_START)
    .map(r => {
      const key = orderKeyFromSource(r.source);
      const v = voidedIdx.get(`${r.brand || 'Firmolux'}|${key}`);
      return {
        date: new Date(r.created_at).toISOString().slice(0, 10),
        brand: r.brand || 'Firmolux',
        source: r.source,
        product: r.product_code,
        qty: -Number(r.delta_qty),
        note: r.note,
        why: v ? `only voided label(s): ${v.map(x => x.shipmentId).join(', ')}` : 'no shipment for this order in the window',
      };
    });

  report(rows, orphans, orderNotes, units);
  if (JSON_OUT) {
    require('fs').writeFileSync(JSON_OUT, JSON.stringify({ window: { start: WINDOW_START, end: WINDOW_END }, rows, orphans, orderNotes }, null, 2));
    process.stderr.write(`wrote ${JSON_OUT}\n`);
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────
const BUCKET_ORDER = ['DEDUCTED OK', 'NO DEDUCTION', 'PARTIAL', 'ZERO ITEMS', 'RESHIP', 'MULTI-PACKAGE', 'FREIGHT', 'NO LABEL', 'DUPLICATE'];

function report(rows, orphans, orderNotes, units) {
  const line = s => process.stdout.write(s + '\n');
  line(`\nINVENTORY DRIFT AUDIT  ${ymd(WINDOW_START)} → ${ymd(WINDOW_END)} (${DAYS} days)`);
  line('='.repeat(78));

  // Shipment counts per bucket.
  line('\nShipments per bucket');
  line(pad('bucket', 16) + pad('Firmolux', 10) + pad('VIOLANTE', 10) + 'total');
  for (const bk of BUCKET_ORDER) {
    const f = rows.filter(r => r.bucket === bk && r.brand === 'Firmolux').length;
    const v = rows.filter(r => r.bucket === bk && r.brand === 'VIOLANTE').length;
    if (f + v) line(pad(bk, 16) + pad(f, 10) + pad(v, 10) + (f + v));
  }
  line(pad('TOTAL', 16) + pad(rows.filter(r => r.brand === 'Firmolux').length, 10) + pad(rows.filter(r => r.brand === 'VIOLANTE').length, 10) + rows.length);

  // Per product per bucket: shipped vs deducted vs gap. Gap > 0 = leaked.
  line('\nQuantity per bucket per product (kg, or L for BEE/DW)  —  gap = shipped − deducted');
  line(pad('bucket', 16) + pad('product', 9) + pad('shipped', 10) + pad('deducted', 10) + 'gap');
  const totals = {};
  for (const bk of BUCKET_ORDER) {
    const agg = {};
    for (const r of rows.filter(x => x.bucket === bk)) {
      for (const [p, q] of Object.entries(r.expected || {})) { (agg[p] ||= { s: 0, d: 0 }).s += q; }
      for (const [p, q] of Object.entries(r.got || {})) { (agg[p] ||= { s: 0, d: 0 }).d += q; }
      for (const [p, q] of Object.entries(r.overDeducted || {})) { (agg[p] ||= { s: 0, d: 0 }).d += q; }
    }
    for (const p of Object.keys(agg).sort()) {
      const { s, d } = agg[p];
      (totals[p] ||= { s: 0, d: 0 }); totals[p].s += s; totals[p].d += d;
      line(pad(bk, 16) + pad(p, 9) + pad(round(s), 10) + pad(round(d), 10) + round(s - d));
    }
  }
  line('-'.repeat(50));
  for (const p of Object.keys(totals).sort()) {
    const { s, d } = totals[p];
    line(pad('ALL', 16) + pad(p, 9) + pad(round(s), 10) + pad(round(d), 10) + round(s - d) + ` ${units[p] || ''}`);
  }
  const orphanAgg = {};
  for (const o of orphans) orphanAgg[o.product] = round((orphanAgg[o.product] || 0) + o.qty);
  line(`\nDeducted with no matching live shipment: ${orphans.length} audit rows (${fmtProducts(orphanAgg)})`);
  line('Note: shipped quantities for unparseable / no-SKU items are unknown and not in "shipped".');

  // Detail.
  const bad = rows.filter(r => r.bucket !== 'DEDUCTED OK')
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  line(`\n\nNON-OK SHIPMENTS (${bad.length})`);
  line('='.repeat(78));
  for (const r of bad) {
    line(`${r.date}  ${r.brand}  #${r.orderNumber}  ship ${r.shipmentId}  [${r.bucket}]`);
    line(`    carrier:  ${r.carrier || '—'}`);
    line(`    shipped:  ${r.skus}   → should deduct ${fmtProducts(r.expected)}`);
    line(`    deducted: ${fmtProducts(r.got)}${r.overDeducted ? `  (+ over ${fmtProducts(r.overDeducted)})` : ''}`);
    if (r.reason) line(`    reason:   ${r.reason}`);
  }

  if (orderNotes.length) {
    line(`\n\nORDER-LEVEL NOTES (${orderNotes.length})`);
    line('='.repeat(78));
    for (const n of orderNotes) line(`${n.brand}  #${n.orderNumber}  ${n.note}`);
  }

  line(`\n\nAUDIT ROWS WITH NO MATCHING SHIPMENT (${orphans.length})`);
  line('='.repeat(78));
  for (const o of orphans) {
    line(`${o.date}  ${o.brand}  ${o.source}  ${o.product} -${o.qty}  (${o.note || ''})  — ${o.why}`);
  }
}
function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }

main().catch(err => {
  console.error('drift-audit failed:', err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0, 300)}` : err.message);
  process.exit(1);
});
