// Per-shipment deduction, shared by the ShipStation webhook and the daily
// reconcile job.
//
// Idempotency: every deduction row in inventory_audit carries the ShipStation
// shipmentId (or "order:<orderId>" for an order marked shipped with no label).
// processShipment takes a per-shipment advisory lock inside a transaction,
// checks whether that shipmentId was already processed, and only then deducts.
// A ShipStation retry, a relabel notification or a reconcile pass that races
// the webhook all see the first run's rows and skip. Everything for one
// shipment (product updates, audit rows, shipment_log row) commits or rolls
// back together, so a failure part-way leaves nothing behind for the
// reconcile job to trip over — it simply deducts the shipment next morning.
const { parseSKU } = require('./sku-parser');

const KIT_CODES = ['KRH', 'KIT-T', 'KIT-U'];

async function migrateShipmentIds(client) {
  await client.query(`
    ALTER TABLE inventory_audit ADD COLUMN IF NOT EXISTS shipment_id VARCHAR(64);
    CREATE INDEX IF NOT EXISTS inventory_audit_brand_shipment_idx
      ON inventory_audit (brand, shipment_id) WHERE shipment_id IS NOT NULL;
  `);
}

async function loadKits(db) {
  const { rows } = await db.query('SELECT kit_code, product_code, qty_per_kit FROM kit_components');
  const kits = {};
  for (const r of rows) (kits[r.kit_code] ||= []).push({ product: r.product_code, qty: parseFloat(r.qty_per_kit) });
  return kits;
}

function kitCodeFor(sku) {
  const head = sku.split('-')[0].toUpperCase();
  return KIT_CODES.includes(head) ? head : null;
}

// Pure: what a shipment's items should deduct.
function planShipment(items, brand, kits) {
  const deductions = [];
  const failed = [];
  for (const item of items || []) {
    const orderQty = item.quantity || 1;
    if (!item.sku) continue;
    const kit = kitCodeFor(item.sku);
    if (kit) {
      for (const c of kits[kit] || []) {
        deductions.push({ product: c.product, qty: c.qty * orderQty, reason: `${kit} x${orderQty}`, note: `${kit} x${orderQty}` });
      }
      continue;
    }
    const parsed = parseSKU(item.sku, brand);
    if (!parsed) { failed.push(item.sku); continue; }
    deductions.push({ product: parsed.productCode, qty: parsed.qty * orderQty, sku: item.sku, orderQty, note: `${item.sku} x${orderQty}` });
  }
  return { deductions, failed };
}

async function withShipmentLock(pool, brand, shipmentId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shipment:${brand}:${shipmentId}`]);
    const out = await fn(client);
    await client.query(out && out.rollback ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function isProcessed(client, brand, shipmentId) {
  const { rows } = await client.query(
    `SELECT 1 FROM inventory_audit WHERE brand = $1 AND shipment_id = $2
     UNION ALL
     SELECT 1 FROM shipment_log WHERE brand = $1 AND deductions->>'shipmentId' = $2
     LIMIT 1`,
    [brand, String(shipmentId)]
  );
  return rows.length > 0;
}

// shipment: { shipmentId, orderId, orderNumber, customerName, items }
// opts: { source, kits, dryRun }
// Returns { status: 'deducted' | 'duplicate' | 'covered-by-no-label', deductions, failed }
async function processShipment(pool, brand, shipment, opts = {}) {
  const shipmentId = String(shipment.shipmentId);
  const orderLabel = shipment.orderNumber || shipment.orderId || null;
  const orderTag = orderLabel ? `Order #${orderLabel}` : 'Order (unknown)';
  const source = opts.source || orderTag;
  const kits = opts.kits || await loadKits(pool);
  const plan = planShipment(shipment.items, brand, kits);

  return withShipmentLock(pool, brand, shipmentId, async client => {
    if (await isProcessed(client, brand, shipmentId)) {
      return { status: 'duplicate', deductions: [], failed: [] };
    }
    // A real label on an order the reconcile job already deducted as
    // "shipped with no label" — deducting it would count the order twice.
    if (shipment.orderId && !shipmentId.startsWith('order:')
        && await isProcessed(client, brand, `order:${shipment.orderId}`)) {
      // Logged so it counts as processed and is flagged once, not daily.
      await client.query(
        'INSERT INTO shipment_log (shipstation_order_id, sku, quantity, deductions, brand) VALUES ($1, $2, $3, $4, $5)',
        [`#${orderLabel}`.slice(0, 50), 'SKIPPED', 1,
         JSON.stringify({ deductions: [], failedSkus: null, shipmentId, skipped: `order:${shipment.orderId} already deducted as shipped with no label` }), brand]
      );
      return { status: 'covered-by-no-label', deductions: [], failed: plan.failed, rollback: !!opts.dryRun };
    }

    const applied = [];
    for (const d of plan.deductions) {
      const { rows } = await client.query(
        'UPDATE products SET current_qty = current_qty - $1, updated_at = NOW() WHERE code = $2 RETURNING current_qty',
        [d.qty, d.product]
      );
      if (rows.length === 0) continue;
      const after = parseFloat(rows[0].current_qty);
      await client.query(
        `INSERT INTO inventory_audit (product_code, change_type, delta_qty, qty_before, qty_after, source, note, brand, shipment_id)
         VALUES ($1, 'shipment', $2, $3, $4, $5, $6, $7, $8)`,
        [d.product, -d.qty, after + d.qty, after, source,
         opts.source ? `${orderTag}: ${d.note}` : d.note, brand, shipmentId]
      );
      applied.push({ product: d.product, qty: d.qty, ...(d.sku ? { sku: d.sku, orderQty: d.orderQty } : { reason: d.reason }) });
    }

    const displayId = orderLabel ? `#${orderLabel}` : 'Unknown';
    const displayName = shipment.customerName ? ` - ${shipment.customerName}` : '';
    await client.query(
      'INSERT INTO shipment_log (shipstation_order_id, sku, quantity, deductions, brand) VALUES ($1, $2, $3, $4, $5)',
      [(displayId + displayName).slice(0, 50), opts.source ? 'RECONCILE' : 'BATCH', 1,
       JSON.stringify({ deductions: applied, failedSkus: plan.failed.join(' | ') || null, shipmentId }), brand]
    );
    return { status: 'deducted', deductions: applied, failed: plan.failed, rollback: !!opts.dryRun };
  });
}

// Put back what a now-voided label deducted. Only rows created at or after
// `since` are reversed: anything older is already reflected in the physical
// count that seeded RECONCILE_START.
async function reverseShipment(pool, brand, shipmentId, opts = {}) {
  shipmentId = String(shipmentId);
  return withShipmentLock(pool, brand, shipmentId, async client => {
    const { rows: done } = await client.query(
      `SELECT 1 FROM inventory_audit WHERE brand = $1 AND shipment_id = $2 AND change_type = 'void_reversal' LIMIT 1`,
      [brand, shipmentId]
    );
    if (done.length) return { status: 'already-reversed', reversed: [] };
    const { rows } = await client.query(
      `SELECT product_code, SUM(-delta_qty) AS qty, MIN(source) AS source
         FROM inventory_audit
        WHERE brand = $1 AND shipment_id = $2 AND change_type = 'shipment'
          AND ($3::timestamp IS NULL OR created_at >= $3)
        GROUP BY product_code`,
      [brand, shipmentId, opts.since || null]
    );
    if (rows.length === 0) return { status: 'not-deducted', reversed: [] };
    const reversed = [];
    for (const r of rows) {
      const qty = parseFloat(r.qty);
      const { rows: p } = await client.query(
        'UPDATE products SET current_qty = current_qty + $1, updated_at = NOW() WHERE code = $2 RETURNING current_qty',
        [qty, r.product_code]
      );
      if (p.length === 0) continue;
      const after = parseFloat(p[0].current_qty);
      await client.query(
        `INSERT INTO inventory_audit (product_code, change_type, delta_qty, qty_before, qty_after, source, note, brand, shipment_id)
         VALUES ($1, 'void_reversal', $2, $3, $4, $5, $6, $7, $8)`,
        [r.product_code, qty, after - qty, after, opts.source || 'reconcile',
         `Label ${shipmentId} voided (${r.source})`, brand, shipmentId]
      );
      reversed.push({ product: r.product_code, qty });
    }
    return { status: 'reversed', reversed, rollback: !!opts.dryRun };
  });
}

// ShipStation resource_url → the shipments in that notification batch,
// voided ones dropped. One entry per shipment: never flattened, so each
// shipment is tagged with its own order number and id.
function shipmentsFromResponse(parsed) {
  return (parsed && parsed.shipments || [])
    .filter(s => !s.voided)
    .map(s => ({
      shipmentId: s.shipmentId,
      orderId: s.orderId,
      orderNumber: s.orderNumber,
      customerName: s.customerName || (s.shipTo && s.shipTo.name) || null,
      items: s.shipmentItems || [],
    }));
}

module.exports = {
  KIT_CODES,
  migrateShipmentIds,
  loadKits,
  planShipment,
  processShipment,
  reverseShipment,
  shipmentsFromResponse,
};
