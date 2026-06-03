// SKU parser handling both formats:
// 1. Code format: GL04, MP04KG, MMB25KG-BM123, IP99
// 2. Amazon format: Grassello4kg, Microprimer4kg, Berlina25kg, Piatto1kg

const PRODUCT_INFO = {
  // Code → { name, quantities }
  'GL': { name: 'Grassello', quantities: [1, 4, 8, 12, 20, 99] },
  'AP': { name: 'Anchor Primer', quantities: [1, 4, 8, 12, 20, 99] },
  'MP': { name: 'Microprimer', quantities: [1, 4, 8, 12, 20, 99] },
  'MSM': { name: 'Milano Silver', quantities: [1, 4, 8, 12, 20, 99] },
  'MGM': { name: 'Milano Gold', quantities: [1, 4, 8, 12, 20, 99] },
  'MMB': { name: 'Berlina', quantities: [1, 5, 10, 15, 25, 99] },
  'IP': { name: 'Piatto', quantities: [1, 5, 10, 15, 25, 99] },
  'IM': { name: 'Mezzo', quantities: [1, 5, 10, 15, 25, 99] },
  'BEE': { name: 'Beeswax', quantities: [1, 5, 99] },
  'SAV': { name: 'Sav', quantities: [2], fixed: true },
  'KRH': { name: 'Kit', quantities: [1], fixed: true },
};

// Name → code (for Amazon format)
const NAME_TO_CODE = {
  'grassello': 'GL',
  'anchor primer': 'AP',
  'microprimer': 'MP',
  'mprimer': 'MP',  // Amazon uses "Mprimer" instead of "Microprimer"
  'milano silver': 'MSM',
  'milano gold': 'MGM',
  'berlina': 'MMB',
  'piatto': 'IP',
  'mezzo': 'IM',
  'beeswax': 'BEE',
  'sav': 'SAV',
  'savon': 'SAV',
  'kit': 'KRH',
};

function parseSKU(rawSku) {
  if (!rawSku || typeof rawSku !== 'string') {
    console.log(`[SKU] Invalid input: ${rawSku}`);
    return null;
  }

  const sku = rawSku.trim();
  console.log(`[SKU] Parsing: "${sku}"`);

  // Try code format first: "GL04", "MMB25KG", etc.
  const upperSku = sku.split('-')[0].toUpperCase();
  const prefixes = Object.keys(PRODUCT_INFO).sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (!upperSku.startsWith(prefix)) continue;

    const info = PRODUCT_INFO[prefix];

    // Fixed-quantity products
    if (info.fixed) {
      console.log(`[SKU] ✓ (Code) ${info.name} (fixed qty: ${info.quantities[0]})`);
      return { productCode: prefix, qty: info.quantities[0] };
    }

    // Extract number
    const rest = upperSku.slice(prefix.length);
    const match = rest.match(/^(\d+)/);

    if (!match) continue;

    let qty = parseInt(match[1], 10);

    if (!info.quantities.includes(qty)) {
      console.log(`[SKU] ✗ (Code) ${prefix} qty=${qty} not in valid set: ${info.quantities.join(',')}`);
      continue;
    }

    if (qty === 99) {
      qty = 1;
      console.log(`[SKU] ✓ (Code) ${info.name} qty=99 → 1kg`);
    } else {
      console.log(`[SKU] ✓ (Code) ${info.name} qty=${qty}kg`);
    }

    return { productCode: prefix, qty };
  }

  // Try Amazon format: "Microprimer4kg", "Grassello20kg", etc.
  const amazonMatch = sku.match(/^([a-zA-Z\s]+?)(\d+)(kg|l)?$/i);
  if (amazonMatch) {
    const name = amazonMatch[1].trim().toLowerCase();
    let qty = parseInt(amazonMatch[2], 10);
    const unit = amazonMatch[3] ? amazonMatch[3].toLowerCase() : 'kg';

    const productCode = NAME_TO_CODE[name];
    if (!productCode) {
      console.log(`[SKU] ✗ Amazon format but unknown product: "${name}"`);
      return null;
    }

    const info = PRODUCT_INFO[productCode];
    if (!info.quantities.includes(qty)) {
      console.log(`[SKU] ✗ ${productCode} qty=${qty} not in valid set: ${info.quantities.join(',')}`);
      return null;
    }

    if (qty === 99) {
      qty = 1;
      console.log(`[SKU] ✓ (Amazon) ${info.name} qty=99 → 1${unit}`);
    } else {
      console.log(`[SKU] ✓ (Amazon) ${info.name} qty=${qty}${unit}`);
    }

    return { productCode, qty };
  }



  console.log(`[SKU] ✗ No format matched for: ${sku}`);
  return null;
}

module.exports = { parseSKU, PRODUCT_INFO };
