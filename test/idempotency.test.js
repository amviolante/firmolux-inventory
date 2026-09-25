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
    const plan = planShipment([item('KIT-T', 2), item('Kit-U'), { sku: null, quantity: 1, name: 'Mystery Tub' }, { sku: '', quantity: 2 }], 'Firmolux', kits);
    assert.deepStrictEqual(plan.deductions.map(d => [d.product, d.qty]), [['GL', 2], ['MMB', 2], ['GL', 1]]);
    assert.deepStrictEqual(plan.failed, ['(no SKU) Mystery Tub x1', '(no SKU) unnamed item x2']);
  });
});

describe('ignore list', () => {
  const { ignoredAs } = require('../src/ignore-list');
  test('matches the non-inventory items and nothing real', () => {
    for (const sku of ['CB200', 'CV200', 'CNN500', 'CG910-200', 'CRV200', 'CG2X200', 'cw1000', 'P825-S', 'spw1l', 'NEB200']) {
      assert.ok(ignoredAs({ sku }), sku);
    }
    for (const name of ['Firmolux XL T-Shirt', 'Logo Hoodie', 'Dad Hat', 'Work shirt']) assert.ok(ignoredAs({ sku: null, name }), name);
    for (const sku of ['GL04', 'MMB25', 'SAV', 'Chateau1', 'C200', 'XYZ9', 'MSM04']) assert.strictEqual(ignoredAs({ sku, name: sku }), null, sku);
    assert.strictEqual(ignoredAs({ sku: null, name: 'Milano Silver - 1 Gallon (4kg) / Tinted' }), null);
    assert.strictEqual(ignoredAs({ sku: 'GL04', name: 'Chateau Grassello' }), null);
  });

  test('ignored items are neither deducted nor failed; sample kits deduct nothing even with a parseable SKU', () => {
    const plan = planShipment([
      item('GL04'), item('CB200'), { sku: null, quantity: 1, name: 'Firmolux XL T-Shirt' },
      { sku: 'GL04', quantity: 1, name: 'Sample Kit - 3' }, { sku: null, quantity: 1, name: 'Sample Kit - 5' }, item('NOPE9'),
    ], 'Firmolux', {});
    assert.deepStrictEqual(plan.deductions.map(d => [d.product, d.qty]), [['GL', 4]]);
    assert.deepStrictEqual(plan.failed, ['NOPE9']);
    assert.deepStrictEqual(plan.ignored, [
      'CB200 x1 (colorant)', '(no SKU) Firmolux XL T-Shirt x1 (merch)', 'GL04 x1 (sample kit)', '(no SKU) Sample Kit - 5 x1 (sample kit)',
    ]);
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
    const r1 = await processShipment(pool, 'Firmolux', ship(4, 'A4', [item('XYZ9')]));
    assert.deepStrictEqual([r1.status, r1.failed], ['deducted', ['XYZ9']]);
    const r2 = await processShipment(pool, 'Firmolux', ship(4, 'A4', [item('XYZ9')]));
    assert.strictEqual(r2.status, 'duplicate');
    const { rows } = await pool.query("SELECT deductions FROM shipment_log WHERE deductions->>'shipmentId' = '4'");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].deductions.failedSkus, 'XYZ9');
  });

  test('ignored items are logged once in shipment_log', async () => {
    const r = await processShipment(pool, 'Firmolux', ship(7, 'A7', [item('SPW1L'), { sku: null, quantity: 1, name: 'Sample Kit - 3' }]));
    assert.deepStrictEqual([r.status, r.failed], ['deducted', []]);
    await processShipment(pool, 'Firmolux', ship(7, 'A7', [item('SPW1L')]));
    const { rows } = await pool.query("SELECT deductions FROM shipment_log WHERE deductions->>'shipmentId' = '7'");
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].deductions.ignored, ['SPW1L x1 (non-inventory)', '(no SKU) Sample Kit - 3 x1 (sample kit)']);
    assert.strictEqual(rows[0].deductions.failedSkus, null);
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
      'POST /slack': () => ({ ok: true }),
      'GET /shipments': (req, u) => {
        const b = batches[u.searchParams.get('batchId')];
        return b === undefined ? { status: 500, body: { message: 'upstream down' } } : { shipments: b };
      },
    });
    srv = await startServer(url, {
      SHIPSTATION_API_BASE: ss.base,
      SHIPSTATION_API_KEY: 'k', SHIPSTATION_API_SECRET: 's',
      VIOLANTE_SHIPSTATION_API_KEY: 'vk', VIOLANTE_SHIPSTATION_API_SECRET: 'vs',
      SLACK_WEBHOOK_URL: `${ss.base}/slack`,
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
    const ssCalls = () => ss.calls.filter(c => c.path !== '/slack').length;
    const before = ssCalls();
    const r = await notify('', 'b1', 'http://127.0.0.1:1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(ssCalls(), before);
    assert.ok(ss.calls.some(c => c.path === '/slack' && /not ssapi|is not 127/.test(JSON.stringify(c.body))), 'reported to Slack');
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

  const slackPosts = () => ss.calls.filter(c => c.path === '/slack').map(c => c.body.text);

  test('a no-SKU item is logged to failedSkus by name and posted to Slack', async () => {
    const before = slackPosts().length;
    batches.b6 = [{ shipmentId: 106, orderId: 6, orderNumber: 'W6', shipmentItems: [item('GL04'), { sku: null, quantity: 1, name: 'Mystery Tub' }] }];
    await notify('', 'b6');
    const { rows } = await pool.query("SELECT deductions FROM shipment_log WHERE deductions->>'shipmentId' = '106'");
    assert.strictEqual(rows[0].deductions.failedSkus, '(no SKU) Mystery Tub x1');
    assert.deepStrictEqual(slackPosts().slice(before), ['⚠️ Unparseable SKU on order W6 (Firmolux)']);
  });

  test('ignored items never post to Slack', async () => {
    const before = slackPosts().length;
    batches.b7 = [{ shipmentId: 107, orderId: 7, orderNumber: 'W7', shipmentItems: [
      item('MMB25'), item('CNN500'), { sku: null, quantity: 1, name: 'Sample Kit - 3' }, { sku: null, quantity: 1, name: 'Firmolux XL T-Shirt' }] }];
    await notify('', 'b7');
    assert.deepStrictEqual(slackPosts().slice(before), []);
    const { rows } = await pool.query("SELECT deductions FROM shipment_log WHERE deductions->>'shipmentId' = '107'");
    assert.strictEqual(rows[0].deductions.ignored.length, 3);
  });

  test('a DB failure is posted to Slack', async () => {
    assert.ok(slackPosts().some(t => /Deduction failed .* order W4/.test(t)));
  });

  test('VIOLANTE route deducts under its own brand', async () => {
    batches.b5 = [{ shipmentId: 101, orderId: 5, orderNumber: 'V5', shipmentItems: [item('LT05-SW7004')] }];
    await notify('/violante', 'b5');
    const { rows } = await pool.query("SELECT brand, product_code FROM inventory_audit WHERE source = 'Order #V5'");
    assert.deepStrictEqual(rows, [{ brand: 'VIOLANTE', product_code: 'IP' }]);
  });
});
