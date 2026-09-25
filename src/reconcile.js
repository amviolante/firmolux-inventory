// Daily reconcile: catch what the webhook missed.
//
// For each brand, over the last `days` days:
//   - every live shipment with items that has no deduction yet is deducted
//     now (source "reconcile"), through the same processShipment the webhook
//     uses, so a shipmentId is never deducted twice;
//   - every order marked shipped with no live label (freight, manual) is
//     deducted once as shipment "order:<orderId>";
//   - every voided label that was deducted is reversed.
//
// Nothing before `start` (RECONCILE_START, the physical count) is touched:
// shipments created, orders shipped, and deductions made before it are
// already reflected in the counted stock.
const { processShipment, reverseShipment, loadKits } = require('./shipments');
const { shipStationClient } = require('./shipstation');
const { zonedToUtc, dateIn, SHIPSTATION_TZ } = require('./time');

function brandsFromEnv() {
  return [
    { brand: 'Firmolux', apiKey: process.env.SHIPSTATION_API_KEY, apiSecret: process.env.SHIPSTATION_API_SECRET },
    { brand: 'VIOLANTE', apiKey: process.env.VIOLANTE_SHIPSTATION_API_KEY, apiSecret: process.env.VIOLANTE_SHIPSTATION_API_SECRET },
  ];
}

function parseStart(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d)) throw new Error(`RECONCILE_START is not a date: ${value}`);
  return d;
}

// opts: { brands, days = 7, now = new Date(), start (Date|null), dryRun, clientFor }
async function runReconcile(pool, opts = {}) {
  const now = opts.now || new Date();
  const days = opts.days || 7;
  const start = opts.start || null;
  const dryRun = !!opts.dryRun;
  const clientFor = opts.clientFor || shipStationClient;
  const since = new Date(now.getTime() - days * 86400000);
  const kits = await loadKits(pool);
  const { rows: productRows } = await pool.query('SELECT code, unit FROM products');

  const summary = {
    ranAt: now.toISOString(), days, start: start && start.toISOString(), dryRun,
    units: Object.fromEntries(productRows.map(p => [p.code, p.unit])),
    reconciled: [], reversed: [], unparsed: [], zeroItems: [], review: [], errors: [],
  };

  for (const b of opts.brands || brandsFromEnv()) {
    if (!b.apiKey || !b.apiSecret) {
      summary.errors.push({ brand: b.brand, error: 'ShipStation credentials missing' });
      continue;
    }
    try {
      await reconcileBrand(pool, clientFor(b), b.brand, { since, start, dryRun, kits, summary });
    } catch (err) {
      summary.errors.push({ brand: b.brand, error: describe(err) });
    }
  }

  summary.totals = { deducted: sumBy(summary.reconciled), reversed: sumBy(summary.reversed) };
  summary.orderCount = new Set(summary.reconciled.map(r => `${r.brand}|${r.orderNumber}`)).size;
  return summary;
}

async function reconcileBrand(pool, ss, brand, { since, start, dryRun, kits, summary }) {
  const shipments = await ss.getAll('/shipments', {
    shipDateStart: dateIn(since, SHIPSTATION_TZ),
    includeShipmentItems: true,
  }, 'shipments');
  shipments.sort((a, b) => String(a.createDate).localeCompare(String(b.createDate)));

  const liveOrderIds = new Set();
  for (const s of shipments) {
    if (!s.voided) liveOrderIds.add(s.orderId);
    const created = zonedToUtc(s.createDate, SHIPSTATION_TZ);
    if (start && created && created < start) continue;
    const ref = { brand, orderNumber: s.orderNumber || String(s.orderId), shipmentId: String(s.shipmentId) };
    try {
      if (s.voided) {
        const r = await reverseShipment(pool, brand, s.shipmentId, { since: start, dryRun, source: 'reconcile' });
        if (r.status === 'reversed') summary.reversed.push({ ...ref, items: r.reversed });
        continue;
      }
      const items = s.shipmentItems || [];
      const r = await processShipment(pool, brand, {
        shipmentId: s.shipmentId, orderId: s.orderId, orderNumber: s.orderNumber,
        customerName: s.shipTo && s.shipTo.name, items,
      }, { source: 'reconcile', kits, dryRun });
      record(summary, ref, r, { items, noLabel: false });
    } catch (err) {
      summary.errors.push({ ...ref, error: describe(err) });
    }
  }

  // Orders marked shipped with no live label: the webhook never fires for
  // these. Confirm each one really has no label (it may predate the window).
  const startDate = start ? dateIn(start, SHIPSTATION_TZ) : null;
  const orders = await ss.getAll('/orders', {
    orderStatus: 'shipped',
    modifyDateStart: dateIn(since, SHIPSTATION_TZ),
  }, 'orders');
  for (const o of orders) {
    if (liveOrderIds.has(o.orderId)) continue;
    const shipped = o.shipDate || String(o.modifyDate || '').slice(0, 10);
    if (shipped < dateIn(since, SHIPSTATION_TZ)) continue;
    if (start) {
      const modified = zonedToUtc(o.modifyDate, SHIPSTATION_TZ);
      if (shipped < startDate || (modified && modified < start)) continue;
    }
    const ref = { brand, orderNumber: o.orderNumber || String(o.orderId), shipmentId: `order:${o.orderId}` };
    try {
      const prior = await ss.get('/shipments', { orderId: o.orderId });
      if ((prior.shipments || []).some(s => !s.voided)) continue;
      const items = (o.items || []).filter(i => !i.adjustment);
      const r = await processShipment(pool, brand, {
        shipmentId: `order:${o.orderId}`, orderId: o.orderId, orderNumber: o.orderNumber,
        customerName: o.shipTo && o.shipTo.name, items,
      }, { source: 'reconcile', kits, dryRun });
      record(summary, { ...ref, service: [o.carrierCode, o.serviceCode, o.requestedShippingService].filter(Boolean).join(' / ') }, r, { items, noLabel: true });
    } catch (err) {
      summary.errors.push({ ...ref, error: describe(err) });
    }
  }
}

function record(summary, ref, r, { items, noLabel }) {
  if (r.status === 'duplicate') return;
  if (r.status === 'covered-by-no-label') {
    summary.review.push({ ...ref, reason: 'label created after the order was already reconciled as shipped-with-no-label; not deducted' });
    return;
  }
  if (items.length === 0) summary.zeroItems.push({ ...ref, noLabel });
  if (r.deductions.length) summary.reconciled.push({ ...ref, noLabel, items: r.deductions.map(d => ({ product: d.product, qty: d.qty })) });
  if (r.failed.length) summary.unparsed.push({ ...ref, noLabel, skus: r.failed });
}

function sumBy(list) {
  const out = {};
  for (const r of list) for (const i of r.items) out[i.product] = Math.round(((out[i.product] || 0) + i.qty) * 100) / 100;
  return out;
}

function describe(err) {
  if (err.response) return `ShipStation HTTP ${err.response.status}`;
  return err.message;
}

module.exports = { runReconcile, parseStart, brandsFromEnv };
