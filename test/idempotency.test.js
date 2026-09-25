const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { skipDb, setupDb, startServer, qty, fakeShipStation, post } = require('./helpers');
const { processShipment, shipmentsFromResponse, planShipment } = require('../src/shipments');

const ship = (shipmentId, orderNumber, items, extra = {}) => ({
  shipmentId, orderId: 9000 + shipmentId, orderNumber, customerName: 'Test', items, ...extra,
});
const item = (sku, quantity = 1, name) => ({ sku, quantity, name: name || sku });

describe('shipmentsFromResponse', () => {
  test('keeps shipments separate and drops voided ones', () => {
    const out = shipmentsFromResponse({ shipments: [
      { shipmentId: 1, orderId: 11, orderNumber: 'A', shipmentItems: [item('GL04')] },
      { shipmentId: 2, orderId: 12, orderNumber: 'B', shipmentItems: [item('IP25')] },
      { shipmentId: 3, orderId: 13, orderNumber: 'C', voided: true, shipmentItems: [item('AP20')] },
    ] });
    assert.deepStrictEqual(out.map(s => [s.shipmentId, s.orderNumber, s.items.length]), [[1, 'A', 1], [2, 'B', 1]]);
  });
});

describe('planShipment', () => {
  test('parses SKUs and expands kits', () => {
    const kits = { KRH: [{ product: 'IP', qty: 5 }, { product: 'AP', qty: 1 }] };
    const plan = planShipment([item('GL04', 2), item('KRH', 1), item('NOPE9')], 'Firmolux', kits);
    assert.deepStrictEqual(plan.deductions.map(d => [d.product, d.qty]), [['GL', 8], ['IP', 5], ['AP', 1]]);
    assert.deepStrictEqual(plan.failed, ['NOPE9']);
  });

  test('KIT-T / Kit-U are kits; items with no SKU are reported by name', () => {
    const kits = { 'KIT-T': [{ product: 'GL', qty: 1 }, { product: 'MMB', qty: 1 }], 'KIT-U': [{ product: 'GL', qty: 1 }] };
    const plan = planShipment([item('KIT-T', 2), item('Kit-U'), { sku: null, quantity: 1, name: 'Sample Kit - 3' }, { sku: '', quantity: 2 }], 'Firmolux', kits);
    assert.deepStrictEqual(plan.deductions.map(d => [d.product, d.qty]), [['GL', 2], ['MMB', 2], ['GL', 1]]);
    assert.deepStrictEqual(plan.failed, ['(no SKU) Sample Kit - 3 x1', '(no SKU) unnamed item x2']);
  });
});

describe('processShipment (DB)', { skip: skipDb }, () => {
  let pool;
  before(async () => { ({ pool } = await setupDb('inv_test_idem')); });
  after(async () => { if (pool) await pool.end(); });

  test('deducts once and records the shipment id on every audit row', async () => {
    const r = await processShipment(pool, 'Firmolux', ship(1, 'A1', [item('GL04', 2), item('IP25')]));
    assert.strictEqual(r.status, 'deducted');
    assert.strictEqual(await qty(pool, 'GL'), 992);
    assert.strictEqual(await qty(pool, 'IP'), 975);
    const { rows } = await pool.query("SELECT shipment_id, source, brand FROM inventory_audit WHERE shipment_id = '1'");
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every(x => x.source === 'Order #A1' && x.brand === 'Firmolux'));
  });

  test('same shipment again is a no-op', async () => {
    const r = await processShipment(pool, 'Firmolux', ship(1, 'A1', [item('GL04', 2), item('IP25')]));
    assert.strictEqual(r.status, 'duplicate');
    assert.strictEqual(await qty(pool, 'GL'), 992);
  });

  test('concurrent deliveries of one shipment deduct exactly once', async () => {
    const s = ship(2, 'A2', [item('MMB25')]);
    const results = await Promise.all([1, 2, 3, 4].map(() => processShipment(pool, 'Firmolux', s)));
    assert.deepStrictEqual(results.map(r => r.status).sort(), ['deducted', 'duplicate', 'duplicate', 'duplicate']);
    assert.strictEqual(await qty(pool, 'MMB'), 975);
  });

  test('same shipment id under the other brand is a different shipment', async () => {
    const r = await processShipment(pool, 'VIOLANTE', ship(2, 'V2', [item('VO25')]));
    assert.strictEqual(r.status, 'deducted');
    assert.strictEqual(await qty(pool, 'MMB'), 950);
  });

  test('a second shipment on the same order is deducted (reship / multi-package)', async () => {
    const r = await processShipment(pool, 'Firmolux', ship(3, 'A1', [item('GL04')]));
    assert.strictEqual(r.status, 'deducted');
    assert.strictEqual(await qty(pool, 'GL'), 988);
  });

  test('all-unparseable shipment is logged once and then counts as processed', async () => {
    const r1 = await processShipment(pool, 'Firmolux', ship(4, 'A4', [item('CB200')]));
    assert.deepStrictEqual([r1.status, r1.failed], ['deducted', ['CB200']]);
    const r2 = await processShipment(pool, 'Firmolux', ship(4, 'A4', [item('CB200')]));
    assert.strictEqual(r2.status, 'duplicate');
    const { rows } = await pool.query("SELECT deductions FROM shipment_log WHERE deductions->>'shipmentId' = '4'");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].deductions.failedSkus, 'CB200');
  });

  test('a failure part-way rolls the whole shipment back, and a retry then deducts it', async () => {
    await pool.query(`
      CREATE FUNCTION fail_ap() RETURNS trigger AS $$
      BEGIN IF NEW.product_code = 'AP' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_ap BEFORE INSERT ON inventory_audit FOR EACH ROW EXECUTE FUNCTION fail_ap();`);
    const s = ship(5, 'A5', [item('GL04'), item('AP20')]);
    await assert.rejects(processShipment(pool, 'Firmolux', s), /boom/);
    assert.strictEqual(await qty(pool, 'GL'), 988, 'GL deduction rolled back');
    assert.strictEqual(await qty(pool, 'AP'), 1000);
    await pool.query('DROP TRIGGER fail_ap ON inventory_audit; DROP FUNCTION fail_ap();');
    const r = await processShipment(pool, 'Firmolux', s);
    assert.strictEqual(r.status, 'deducted');
    assert.strictEqual(await qty(pool, 'GL'), 984);
    assert.strictEqual(await qty(pool, 'AP'), 980);
  });

  test('dryRun reports what it would deduct and writes nothing', async () => {
    const r = await processShipment(pool, 'Firmolux', ship(6, 'A6', [item('BEE5')]), { dryRun: true });
    assert.deepStrictEqual(r.deductions.map(d => [d.product, d.qty]), [['BEE', 5]]);
    assert.strictEqual(await qty(pool, 'BEE'), 1000);
    const again = await processShipment(pool, 'Firmolux', ship(6, 'A6', [item('BEE5')]));
    assert.strictEqual(again.status, 'deducted');
  });
});

describe('webhook (server.js end to end)', { skip: skipDb }, () => {
  let pool, srv, ss;
  const batches = {};
  before(async () => {
    let url;
    ({ pool, url } = await setupDb('inv_test_webhook'));
    ss = await fakeShipStation({
      'GET /shipments': (req, u) => {
        const b = batches[u.searchParams.get('batchId')];
        return b === undefined ? { status: 500, body: { message: 'upstream down' } } : { shipments: b };
      },
    });
    srv = await startServer(url, {
      SHIPSTATION_API_BASE: ss.base,
      SHIPSTATION_API_KEY: 'k', SHIPSTATION_API_SECRET: 's',
      VIOLANTE_SHIPSTATION_API_KEY: 'vk', VIOLANTE_SHIPSTATION_API_SECRET: 'vs',
    });
  });
  after(async () => {
    if (srv) await srv.stop();
    if (ss) await ss.close();
    if (pool) await pool.end();
  });
  const notify = (brandPath, batchId, base = ss.base) => post(srv.port, `/webhook/shipstation${brandPath}`, {
    resource_type: 'ITEM_SHIP_NOTIFY', resource_url: `${base}/shipments?batchId=${batchId}&includeShipmentItems=True`,
  });

  test('a retried notification deducts once', async () => {
    batches.b1 = [{ shipmentId: 101, orderId: 1, orderNumber: 'W1', shipmentItems: [item('GL20')] }];
    const r1 = await notify('', 'b1');
    const r2 = await notify('/firmolux', 'b1');
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual(r2.body.shipments.map(s => s.status), ['duplicate']);
    assert.strictEqual(await qty(pool, 'GL'), 980);
  });

  test('a batch of two orders tags each deduction with its own order', async () => {
    batches.b2 = [
      { shipmentId: 102, orderId: 2, orderNumber: 'W2', shipmentItems: [item('IP25')] },
      { shipmentId: 103, orderId: 3, orderNumber: 'W3', shipmentItems: [item('AP20')] },
    ];
    await notify('', 'b2');
    const { rows } = await pool.query("SELECT shipment_id, source FROM inventory_audit WHERE shipment_id IN ('102','103') ORDER BY shipment_id");
    assert.deepStrictEqual(rows.map(r => r.source), ['Order #W2', 'Order #W3']);
  });

  test('ShipStation fetch failure still returns 200', async () => {
    const r = await notify('', 'missing');
    assert.strictEqual(r.status, 200);
  });

  test('credentials are never sent to a resource_url off the ShipStation host', async () => {
    const before = ss.calls.length;
    const r = await notify('', 'b1', 'http://127.0.0.1:1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(ss.calls.length, before);
  });

  test('a DB failure returns 200, deducts nothing, and the retry then deducts', async () => {
    batches.b4 = [{ shipmentId: 104, orderId: 4, orderNumber: 'W4', shipmentItems: [item('MP20')] }];
    await pool.query(`
      CREATE FUNCTION fail_all() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'db down'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_all BEFORE INSERT ON inventory_audit FOR EACH ROW EXECUTE FUNCTION fail_all();`);
    const r = await notify('', 'b4');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.shipments.map(s => s.status), ['failed']);
    assert.strictEqual(await qty(pool, 'MP'), 1000);
    await pool.query('DROP TRIGGER fail_all ON inventory_audit; DROP FUNCTION fail_all();');
    await notify('', 'b4');
    assert.strictEqual(await qty(pool, 'MP'), 980);
  });

  test('a no-SKU item is logged to failedSkus by name', async () => {
    batches.b6 = [{ shipmentId: 106, orderId: 6, orderNumber: 'W6', shipmentItems: [item('GL04'), { sku: null, quantity: 1, name: 'Sample Kit - 3' }] }];
    await notify('', 'b6');
    const { rows } = await pool.query("SELECT deductions FROM shipment_log WHERE deductions->>'shipmentId' = '106'");
    assert.strictEqual(rows[0].deductions.failedSkus, '(no SKU) Sample Kit - 3 x1');
  });

  test('VIOLANTE route deducts under its own brand', async () => {
    batches.b5 = [{ shipmentId: 101, orderId: 5, orderNumber: 'V5', shipmentItems: [item('LT05-SW7004')] }];
    await notify('/violante', 'b5');
    const { rows } = await pool.query("SELECT brand, product_code FROM inventory_audit WHERE source = 'Order #V5'");
    assert.deepStrictEqual(rows, [{ brand: 'VIOLANTE', product_code: 'IP' }]);
  });
});
