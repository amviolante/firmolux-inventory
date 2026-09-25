const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { skipDb, setupDb, qty, fakeShipStation } = require('./helpers');
const { runReconcile } = require('../src/reconcile');
const { processShipment } = require('../src/shipments');
const { zonedToUtc, nextRunAt } = require('../src/time');
const { buildReconcileMessage } = require('../src/slack');

describe('time helpers', () => {
  test('zonedToUtc reads ShipStation Pacific wall clock, DST aware', () => {
    assert.strictEqual(zonedToUtc('2026-09-11T00:43:50.7000000', 'America/Los_Angeles').toISOString(), '2026-09-11T07:43:50.000Z');
    assert.strictEqual(zonedToUtc('2026-12-01T00:00:00', 'America/Los_Angeles').toISOString(), '2026-12-01T08:00:00.000Z');
  });

  test('nextRunAt is the next 6:00 Eastern, across DST changes', () => {
    const tz = 'America/New_York';
    const at = iso => nextRunAt(new Date(iso), { hour: 6, tz }).toISOString();
    assert.strictEqual(at('2026-09-25T09:59:00Z'), '2026-09-25T10:00:00.000Z'); // 5:59 EDT → today
    assert.strictEqual(at('2026-09-25T10:00:00Z'), '2026-09-26T10:00:00.000Z'); // exactly 6:00 → tomorrow
    assert.strictEqual(at('2026-09-26T03:30:00Z'), '2026-09-26T10:00:00.000Z'); // 23:30 EDT → next morning
    assert.strictEqual(at('2026-11-01T02:00:00Z'), '2026-11-01T11:00:00.000Z'); // fall back: 6:00 EST
    assert.strictEqual(at('2027-03-14T05:00:00Z'), '2027-03-14T10:00:00.000Z'); // spring forward: 6:00 EDT
  });
});

describe('buildReconcileMessage', () => {
  const base = { ranAt: '2026-09-25T10:00:00Z', days: 7, dryRun: false, units: { MMB: 'kg', BEE: 'L', IP: 'kg' },
    reconciled: [], reversed: [], unparsed: [], zeroItems: [], review: [], errors: [],
    totals: { deducted: {}, reversed: {} }, orderCount: 0 };

  test('all clear', () => {
    assert.match(buildReconcileMessage(base).text, /nothing missed in the last 7 days/);
  });

  test('lists every section with units', () => {
    const msg = buildReconcileMessage({ ...base, orderCount: 1,
      reconciled: [{ brand: 'Firmolux', orderNumber: '14013', shipmentId: 'order:1', items: [{ product: 'MMB', qty: 250 }] }],
      reversed: [{ brand: 'Firmolux', orderNumber: '14332', shipmentId: '653041495', items: [{ product: 'IP', qty: 5 }] }],
      unparsed: [{ brand: 'VIOLANTE', orderNumber: '1101', shipmentId: '77', skus: ['CB200'] }],
      totals: { deducted: { MMB: 250, BEE: 0.5 }, reversed: { IP: 5 } } });
    const body = msg.blocks.map(b => b.text.text).join('\n');
    assert.match(msg.text, /1 order reconciled, 1 voided label reversed/);
    assert.match(body, /Deducted: MMB 250 kg, BEE 0.5 L/);
    assert.match(body, /Firmolux #14013, no label, marked shipped: MMB 250 kg/);
    assert.match(body, /Firmolux #14332, label 653041495: IP \+5 kg/);
    assert.match(body, /VIOLANTE #1101, label 77: `CB200`/);
  });
});

// ShipStation wall-clock string for `daysAgo` days before now.
function ssTime(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.0000000`;
}
const item = (sku, quantity = 1) => ({ sku, quantity, name: sku });
const shipment = (id, orderId, orderNumber, items, extra = {}) => ({
  shipmentId: id, orderId, orderNumber, createDate: ssTime(extra.daysAgo || 1), shipDate: ssTime(extra.daysAgo || 1).slice(0, 10),
  voided: false, shipmentItems: items, ...extra,
});

describe('reconcileAndPost', () => {
  const { reconcileAndPost } = require('../src/scheduler');
  const env = process.env.RECONCILE_START;
  after(() => { if (env === undefined) delete process.env.RECONCILE_START; else process.env.RECONCILE_START = env; });

  test('does nothing without RECONCILE_START', async () => {
    delete process.env.RECONCILE_START;
    let ran = 0, sent = 0;
    const out = await reconcileAndPost(null, { run: async () => { ran++; }, send: async () => { sent++; } });
    assert.deepStrictEqual([out, ran, sent], [null, 0, 0]);
  });

  test('runs from RECONCILE_START and posts the summary', async () => {
    process.env.RECONCILE_START = '2026-10-01T08:00:00-04:00';
    let seen, posted;
    const summary = { ok: 1 };
    await reconcileAndPost('pool', { run: async (pool, o) => { seen = o; return summary; }, send: async (url, s) => { posted = s; } });
    assert.strictEqual(seen.start.toISOString(), '2026-10-01T12:00:00.000Z');
    assert.strictEqual(seen.days, 7);
    assert.strictEqual(posted, summary);
  });

  test('a crash still posts, as an error summary', async () => {
    process.env.RECONCILE_START = '2026-10-01T08:00:00-04:00';
    let posted;
    await reconcileAndPost('pool', { run: async () => { throw new Error('db gone'); }, send: async (url, s) => { posted = s; } });
    assert.match(buildReconcileMessage(posted).blocks.map(b => b.text.text).join('\n'), /Errors, reconcile incomplete\*\n• all brands: db gone/);
  });
});

describe('runReconcile (DB)', { skip: skipDb }, () => {
  let pool, ss;
  const F = { shipments: [], orders: [], byOrder: {} };
  const V = { shipments: [], orders: [], byOrder: {}, fail: false };
  const data = { k: F, vk: V };
  const who = req => data[Buffer.from(req.headers.authorization.split(' ')[1], 'base64').toString().split(':')[0]];

  before(async () => {
    ({ pool } = await setupDb('inv_test_reconcile'));
    ss = await fakeShipStation({
      'GET /shipments': (req, u) => {
        const d = who(req);
        if (d.fail) return { status: 500, body: {} };
        if (u.searchParams.get('orderId')) return { shipments: d.byOrder[u.searchParams.get('orderId')] || [] };
        return { shipments: d.shipments, pages: 1 };
      },
      'GET /orders': req => ({ orders: who(req).orders, pages: 1 }),
    });
    process.env.SHIPSTATION_API_BASE = ss.base;
  });
  after(async () => {
    delete process.env.SHIPSTATION_API_BASE;
    if (ss) await ss.close();
    if (pool) await pool.end();
  });
  const brands = [
    { brand: 'Firmolux', apiKey: 'k', apiSecret: 's' },
    { brand: 'VIOLANTE', apiKey: 'vk', apiSecret: 's' },
  ];
  const run = (opts = {}) => runReconcile(pool, { brands, start: new Date(Date.now() - 5 * 86400000), ...opts });

  test('deducts only what the webhook missed, after RECONCILE_START', async () => {
    F.shipments = [
      shipment(1, 11, 'R1', [item('GL20')]),                       // webhook already did it
      shipment(2, 12, 'R2', [item('MMB25', 2)]),                   // missed
      shipment(3, 13, 'R3', [item('IP25')], { daysAgo: 6 }),       // before the count
      shipment(4, 14, 'R4', [item('AP20'), item('XYZ9'), item('CB200')]), // missed, partly unparseable, colorant ignored
      shipment(5, 15, 'R5', []),                                   // zero items
    ];
    await processShipment(pool, 'Firmolux', { shipmentId: 1, orderId: 11, orderNumber: 'R1', items: [item('GL20')] });
    const s = await run();
    assert.deepStrictEqual(s.errors, []);
    assert.deepStrictEqual(s.reconciled.map(r => r.orderNumber), ['R2', 'R4']);
    assert.deepStrictEqual(s.totals.deducted, { MMB: 50, AP: 20 });
    assert.deepStrictEqual(s.unparsed.map(r => [r.orderNumber, r.skus]), [['R4', ['XYZ9']]]);
    assert.deepStrictEqual(s.zeroItems.map(r => r.orderNumber), ['R5']);
    assert.strictEqual(await qty(pool, 'GL'), 980);
    assert.strictEqual(await qty(pool, 'MMB'), 950);
    assert.strictEqual(await qty(pool, 'IP'), 1000);
    const { rows } = await pool.query("SELECT source, note FROM inventory_audit WHERE shipment_id = '2'");
    assert.deepStrictEqual(rows, [{ source: 'reconcile', note: 'Order #R2: MMB25 x2' }]);
  });

  test('a second run changes nothing and reports all clear', async () => {
    const s = await run();
    assert.deepStrictEqual([s.reconciled.length, s.unparsed.length, s.zeroItems.length], [0, 0, 0]);
    assert.strictEqual(await qty(pool, 'MMB'), 950);
    assert.match(buildReconcileMessage(s).text, /nothing missed/);
  });

  test('a voided label that was deducted is put back once; one deducted before the count is not', async () => {
    await pool.query("UPDATE inventory_audit SET created_at = NOW() - INTERVAL '10 days' WHERE shipment_id = '1'");
    F.shipments.find(x => x.shipmentId === 1).voided = true;
    F.shipments.find(x => x.shipmentId === 2).voided = true;
    const s = await run();
    assert.deepStrictEqual(s.reversed.map(r => [r.shipmentId, r.items]), [['2', [{ product: 'MMB', qty: 50 }]]]);
    assert.strictEqual(await qty(pool, 'MMB'), 1000);
    assert.strictEqual(await qty(pool, 'GL'), 980, 'pre-count deduction left alone');
    const again = await run();
    assert.strictEqual(again.reversed.length, 0);
    assert.strictEqual(await qty(pool, 'MMB'), 1000);
  });

  test('an order marked shipped with no label is deducted once as order:<id>', async () => {
    F.orders = [
      { orderId: 20, orderNumber: 'N1', orderStatus: 'shipped', shipDate: ssTime(1).slice(0, 10), modifyDate: ssTime(1),
        requestedShippingService: 'LTL Freight', items: [item('MMB25', 10), { sku: null, name: 'Shipping', adjustment: true }] },
      // Has a label from before the window: not a no-label order.
      { orderId: 21, orderNumber: 'N2', orderStatus: 'shipped', shipDate: ssTime(1).slice(0, 10), modifyDate: ssTime(1), items: [item('GL20')] },
      // Labelled inside the window.
      { orderId: 14, orderNumber: 'R4', orderStatus: 'shipped', shipDate: ssTime(1).slice(0, 10), modifyDate: ssTime(1), items: [item('AP20')] },
    ];
    F.byOrder = { 21: [shipment(99, 21, 'N2', [item('GL20')], { daysAgo: 20 })] };
    const s = await run();
    assert.deepStrictEqual(s.reconciled.map(r => [r.orderNumber, r.shipmentId, r.items]), [['N1', 'order:20', [{ product: 'MMB', qty: 250 }]]]);
    assert.strictEqual(await qty(pool, 'MMB'), 750);
    const again = await run();
    assert.strictEqual(again.reconciled.length, 0);
    assert.strictEqual(await qty(pool, 'MMB'), 750);
  });

  test('a label printed later for a no-label order is flagged, not deducted', async () => {
    F.shipments.push(shipment(30, 20, 'N1', [item('MMB25', 10)]));
    const s = await run();
    assert.deepStrictEqual(s.review.map(r => r.shipmentId), ['30']);
    assert.strictEqual(await qty(pool, 'MMB'), 750);
    const again = await run();
    assert.strictEqual(again.review.length, 0, 'flagged once, not every morning');
  });

  test('dry run reports and changes nothing', async () => {
    V.shipments = [shipment(40, 41, 'V1', [item('VO25-SW1')])];
    const s = await run({ dryRun: true });
    assert.deepStrictEqual(s.reconciled.map(r => r.orderNumber), ['V1']);
    assert.strictEqual(await qty(pool, 'MMB'), 750);
    const { rows } = await pool.query("SELECT 1 FROM shipment_log WHERE brand = 'VIOLANTE'");
    assert.strictEqual(rows.length, 0);
  });

  test('one brand failing does not stop the other', async () => {
    V.fail = true;
    F.shipments.push(shipment(50, 51, 'R9', [item('BEE5')]));
    const s = await run();
    assert.deepStrictEqual(s.errors.map(e => [e.brand, e.error]), [['VIOLANTE', 'ShipStation HTTP 500']]);
    assert.deepStrictEqual(s.reconciled.map(r => r.orderNumber), ['R9']);
    assert.match(buildReconcileMessage(s).blocks.map(b => b.text.text).join('\n'), /Errors, reconcile incomplete\*\n• VIOLANTE: ShipStation HTTP 500/);
    V.fail = false;
  });

  test('without a start date everything in the window is eligible (dry run only)', async () => {
    const s = await runReconcile(pool, { brands, start: null, dryRun: true });
    assert.ok(s.reconciled.some(r => r.orderNumber === 'R3'));
  });
});
