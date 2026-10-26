const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseItemName } = require('../src/name-map');
const { planShipment } = require('../src/shipments');

// Every no-SKU name seen in ShipStation, 2026-07-28 → 2026-10-26.
const SEEN = [
  ['RIVO - 5 Gallons | 25kg / Tinted', 'MMB', 25],
  ['RIVO - 3 Gallons | 15kg / Tinted', 'MMB', 15],
  ['RIVO - 2 Gallons | 10kg / Tinted', 'MMB', 10],
  ['RIVO - 1 Quart | 1kg / Tinted', 'MMB', 1],
  ['RIALTO - 5 Gallons | 25kg / Tinted', 'IP', 25],
  ['RIALTO - 1 Gallon | 5kg / Tinted', 'IP', 5],
  ['RIALTO - 1 Quart | 1kg / Tinted', 'IP', 1],
  ['PRIMO STRATO - 3 Gallons | 12kg / Tinted', 'MP', 12],
  ['PRIMO STRATO - 1 Gallon | 4kg / Tinted', 'MP', 4],
  ['PRIMO STRATO - 1 Quart | 1kg / Natural', 'MP', 1],
  ['GRASSELLO - 5 Gallons | 20kg / Tinted', 'GL', 20],
  ['GRASSELLO - 1 Quart | 1kg / Tinted', 'GL', 1],
  ['BEESWAX - 16oz', 'BEE', 0.5],
  ['BEESWAX - 5L', 'BEE', 5],
  ['SOAPSTONE - 1kg', 'SAV', 1],
  ['Milano Silver - 3 Gallons (12kg) / Tinted', 'MSM', 12],
  ['Milano Silver - 1 Gallon (4kg) / Tinted', 'MSM', 4],
  // No size → full bucket.
  ['Anchor Primer (5-gallon) | Tinted | SW7551 Greek Villa', 'AP', 20],
  ['Marmorino Berlina', 'MMB', 25],
];

describe('parseItemName', () => {
  for (const [name, product, qty] of SEEN) {
    test(name, () => assert.deepStrictEqual(parseItemName(name), { productCode: product, qty }));
  }
  test('Kitchen Range Hood is the KRH kit', () => {
    assert.deepStrictEqual(parseItemName('Kitchen Range Hood - One Size / Tinted'), { kit: 'KRH' });
  });
  test('a size that is not a real bucket is not guessed', () => {
    assert.match(parseItemName('RIVO - 7kg').error, /MMB size 7 is not a real size/);
  });
  test('unknown names do not match', () => {
    assert.strictEqual(parseItemName('Mystery Tub'), null);
    assert.strictEqual(parseItemName(''), null);
  });
});

describe('planShipment with names', () => {
  const kits = { KRH: [{ product: 'IP', qty: 5 }, { product: 'AP', qty: 1 }, { product: 'BEE', qty: 0.5 }] };
  const noSku = (name, quantity = 1) => ({ sku: null, name, quantity });

  test('the VIOLANTE freight order (Marmorino Berlina x25) deducts 625 kg', () => {
    const p = planShipment([noSku('Marmorino Berlina', 25)], 'VIOLANTE', kits);
    assert.deepStrictEqual(p.deductions.map(d => [d.product, d.qty]), [['MMB', 625]]);
    assert.deepStrictEqual(p.failed, []);
  });

  test('not-inventoried and shipping-charge names are ignored, not failed', () => {
    const p = planShipment([noSku('15kg Rasatura - Untinted'), noSku('25kg Marmorino Classico 500 | Untinted'), noSku('UPS Next Day Air')], 'Firmolux', kits);
    assert.deepStrictEqual([p.deductions, p.failed], [[], []]);
    assert.strictEqual(p.ignored.length, 3);
  });

  test('ignore rules beat names: a Grassello T-shirt deducts nothing', () => {
    const p = planShipment([noSku('Grassello Crew T-Shirt')], 'Firmolux', kits);
    assert.deepStrictEqual([p.deductions, p.failed, p.ignored], [[], [], ['(no SKU) Grassello Crew T-Shirt x1 (merch)']]);
  });

  test('a bad SKU falls back to the name; a good SKU always wins', () => {
    const p = planShipment([{ sku: 'RV25-X', name: 'RIVO - 5 Gallons | 25kg', quantity: 2 }, { sku: 'GL04', name: 'RIVO - 25kg', quantity: 1 }], 'VIOLANTE', kits);
    assert.deepStrictEqual(p.deductions.map(d => [d.product, d.qty]), [['MMB', 50], ['GL', 4]]);
  });

  test('kit by name, and unknown names still go to Slack', () => {
    const p = planShipment([noSku('Kitchen Range Hood - One Size / Tinted'), noSku('Mystery Tub'), noSku('RIVO - 7kg')], 'Firmolux', kits);
    assert.deepStrictEqual(p.deductions.map(d => [d.product, d.qty]), [['IP', 5], ['AP', 1], ['BEE', 0.5]]);
    assert.deepStrictEqual(p.failed, ['(no SKU) Mystery Tub x1', '(no SKU) RIVO - 7kg x1 (MMB size 7 is not a real size)']);
  });
});
