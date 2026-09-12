// SKU parser, brand-scoped.
//
// Firmolux vocabulary handles two formats:
//   1. Code format:   GL04, MP04KG, MMB25KG-BM123, IP99
//   2. Amazon format: Grassello4kg, Microprimer4kg, Berlina25kg, Piatto1kg
//
// VIOLANTE vocabulary handles one format:
//   Code + tint suffix: VO01-SW7068, GL01-BMOC45, PS08-Natural, VO01 (bare).
//   Shopify and Amazon channels both send this same shape; the blanket
//   hyphen-strip covers both. Numeral is always kilograms.
//
// The webhook route establishes brand before calling parseSKU, so this file
// dispatches on the brand argument rather than merging vocabularies.

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
  'BEE': { name: 'Beeswax', quantities: [0.5, 1, 2, 5, 99] },
  'SAV': { name: 'Sav', quantities: [1, 2] },
  'DW': { name: 'Decor Wax', quantities: [1, 2, 5] },
  'KRH': { name: 'Kit', quantities: [1], fixed: true },
  'KIT-T': { name: 'Kit-T', quantities: [1], fixed: true },
  'KIT-U': { name: 'Kit-U', quantities: [1], fixed: true },
};

// Aliases collapse to canonical codes. MG → MGM is Milano Gold shortened.
const CODE_ALIASES = {
  'MG': 'MGM',
};

// Typo SKUs in Shopify that can't be edited. Keyed on the SKU after the tint
// suffix and any trailing KG are stripped. MMB20 is a typo — 20 is not
// otherwise a valid Berlina quantity, and it should route to Berlina 25kg.
const SKU_OVERRIDES = {
  'MMB20': { productCode: 'MMB', qty: 25 },
};

// Name → code (Firmolux Amazon format only — VIOLANTE ships code+suffix on
// both channels, so it never touches this table).
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
  'kit-t': 'KIT-T',
  'kit-u': 'KIT-U',
};

// VIOLANTE prefix → { canonical Firmolux product code, valid quantities in kg }.
// Only genuinely VIOLANTE-specific prefixes live here. Shared codes (GL, BEE,
// SAV) are deliberately absent — they resolve via fallthrough to PRODUCT_INFO
// so BEE2, SAV1, GL04, etc. cannot diverge between brands.
const VIOLANTE_PRODUCT_INFO = {
  'PS': { name: 'Microprimer', quantities: [1, 4, 8, 12, 20],  canonicalCode: 'MP'  },
  'LT': { name: 'Piatto',      quantities: [1, 5, 10, 15, 25], canonicalCode: 'IP'  },
  'VO': { name: 'Berlina',     quantities: [1, 5, 10, 15, 25], canonicalCode: 'MMB' },
};

function parseSKU(rawSku, brand = 'Firmolux') {
  if (!rawSku || typeof rawSku !== 'string') {
    console.log(`[SKU] Invalid input: ${rawSku}`);
    return null;
  }

  const sku = rawSku.trim();
  console.log(`[SKU:${brand}] Parsing: "${sku}"`);

  if (brand === 'VIOLANTE') return parseViolanteSKU(sku);
  // Unknown brands fall through to Firmolux — safer than parseError on a
  // misrouted request.
  return parseFirmoluxSKU(sku);
}

function parseFirmoluxSKU(sku) {
  // Blanket discard of everything after the first hyphen — deliberately not a
  // whitelist of known color/tint prefixes, since new paint systems appear.
  const upperSku = sku.split('-')[0].toUpperCase();

  // Overrides run before normal parsing. Key = pre-hyphen SKU with any
  // trailing KG stripped, so MMB20 / MMB20KG / MMB20-SW7008 all collapse.
  const overrideKey = upperSku.replace(/KG$/, '');
  if (SKU_OVERRIDES[overrideKey]) {
    const hit = SKU_OVERRIDES[overrideKey];
    console.log(`[SKU] ✓ (Override) ${overrideKey} → ${hit.productCode} qty=${hit.qty}`);
    return { productCode: hit.productCode, qty: hit.qty };
  }

  // Try code format first: "GL04", "MMB25KG", etc.
  // Longest first, or MG shadows MGM.
  const prefixes = [...Object.keys(PRODUCT_INFO), ...Object.keys(CODE_ALIASES)]
    .sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (!upperSku.startsWith(prefix)) continue;

    const productCode = CODE_ALIASES[prefix] || prefix;
    const info = PRODUCT_INFO[productCode];

    // Fixed-quantity products
    if (info.fixed) {
      console.log(`[SKU] ✓ (Code) ${info.name} (fixed qty: ${info.quantities[0]})`);
      return { productCode, qty: info.quantities[0] };
    }

    // Widened: accepts a leading decimal point (BEE.5 → 0.5) and unpadded
    // single digits (SAV1 → 1, MG8KG → 8). parseFloat handles ".5" natively.
    const rest = upperSku.slice(prefix.length);
    const match = rest.match(/^(\d*\.?\d+)/);

    if (!match) continue;

    let qty = parseFloat(match[1]);

    if (!info.quantities.includes(qty)) {
      console.log(`[SKU] ✗ (Code) ${productCode} qty=${qty} not in valid set: ${info.quantities.join(',')}`);
      continue;
    }

    if (qty === 99) {
      qty = 1;
      console.log(`[SKU] ✓ (Code) ${info.name} qty=99 → 1kg`);
    } else {
      console.log(`[SKU] ✓ (Code) ${info.name} qty=${qty}kg`);
    }

    return { productCode, qty };
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

function parseViolanteSKU(sku) {
  // Blanket discard of everything after the first hyphen — same rule as
  // Firmolux, deliberately not a whitelist of known tint prefixes.
  const upperSku = sku.split('-')[0].toUpperCase();

  // VIOLANTE-specific prefixes (PS/LT/VO) only. Shared codes (GL/BEE/SAV)
  // fall through to Firmolux below.
  const prefixes = Object.keys(VIOLANTE_PRODUCT_INFO).sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (!upperSku.startsWith(prefix)) continue;

    const info = VIOLANTE_PRODUCT_INFO[prefix];
    const rest = upperSku.slice(prefix.length);
    const match = rest.match(/^(\d*\.?\d+)/);
    if (!match) continue;

    const qty = parseFloat(match[1]);
    if (!info.quantities.includes(qty)) {
      console.log(`[SKU:VIOLANTE] ✗ ${prefix} qty=${qty} not in valid set: ${info.quantities.join(',')}`);
      continue;
    }

    // Deliberately no 99 → 1 shorthand. 99 is a Firmolux legacy placeholder
    // and doesn't apply to VIOLANTE-native codes. Shared codes falling through
    // to Firmolux inherit whatever Firmolux does with 99, which is correct.
    console.log(`[SKU:VIOLANTE] ✓ ${info.name} (${prefix}→${info.canonicalCode}) qty=${qty}kg`);
    return { productCode: info.canonicalCode, qty };
  }

  // Fall through to Firmolux vocabulary for shared codes (GL, BEE, SAV) so
  // BEE2, SAV1, GL04, etc. parse identically regardless of the route.
  console.log(`[SKU:VIOLANTE] No VIOLANTE-specific prefix matched; trying Firmolux vocabulary`);
  return parseFirmoluxSKU(sku);
}

module.exports = { parseSKU, PRODUCT_INFO };

// Inline tests — run with `node src/sku-parser.js`.
if (require.main === module) {
  const cases = [
    // Overrides: MMB20 typo → Berlina 25, across tint suffix and KG variants.
    { input: 'MMB20', expect: { productCode: 'MMB', qty: 25 } },
    { input: 'MMB20KG', expect: { productCode: 'MMB', qty: 25 } },
    { input: 'MMB20-SW7008', expect: { productCode: 'MMB', qty: 25 } },
    // MG alias + widened quantity regex. MGM must still win over MG.
    { input: 'MGM20', expect: { productCode: 'MGM', qty: 20 } },
    { input: 'MGM08', expect: { productCode: 'MGM', qty: 8 } },
    { input: 'MG8KG', expect: { productCode: 'MGM', qty: 8 } },
    // Beeswax: 0.5 added, leading-dot regex.
    { input: 'BEE1', expect: { productCode: 'BEE', qty: 1 } },
    { input: 'BEE5', expect: { productCode: 'BEE', qty: 5 } },
    { input: 'BEE.5', expect: { productCode: 'BEE', qty: 0.5 } },
    // Sav: 1 added, no longer fixed.
    { input: 'SAV1', expect: { productCode: 'SAV', qty: 1 } },
    { input: 'SAV2', expect: { productCode: 'SAV', qty: 2 } },
    // Decor Wax: 1/2/5 valid; 3 rejected; tint suffix stripped.
    { input: 'DW1', expect: { productCode: 'DW', qty: 1 } },
    { input: 'DW2', expect: { productCode: 'DW', qty: 2 } },
    { input: 'DW5', expect: { productCode: 'DW', qty: 5 } },
    { input: 'DW3', expect: null },
    { input: 'DW1-SW7004', expect: { productCode: 'DW', qty: 1 } },
    // Existing 99 → 1 preserved.
    { input: 'GL99', expect: { productCode: 'GL', qty: 1 } },
    { input: 'IP99', expect: { productCode: 'IP', qty: 1 } },
    // Regression guards: unchanged from today.
    { input: 'GL04', expect: { productCode: 'GL', qty: 4 } },
    { input: 'MP04KG', expect: { productCode: 'MP', qty: 4 } },
    { input: 'MMB25KG-BM123', expect: { productCode: 'MMB', qty: 25 } },

    // ── VIOLANTE-specific vocabulary (PS/LT/VO) ─────────────────────────────
    // LT → IP (Piatto)
    { input: 'LT01', brand: 'VIOLANTE', expect: { productCode: 'IP', qty: 1 } },
    { input: 'LT05', brand: 'VIOLANTE', expect: { productCode: 'IP', qty: 5 } },
    { input: 'LT25', brand: 'VIOLANTE', expect: { productCode: 'IP', qty: 25 } },
    // VO → MMB (Berlina)
    { input: 'VO01', brand: 'VIOLANTE', expect: { productCode: 'MMB', qty: 1 } },
    { input: 'VO15', brand: 'VIOLANTE', expect: { productCode: 'MMB', qty: 15 } },
    { input: 'VO25', brand: 'VIOLANTE', expect: { productCode: 'MMB', qty: 25 } },
    // PS → MP (Microprimer)
    { input: 'PS08', brand: 'VIOLANTE', expect: { productCode: 'MP', qty: 8 } },
    { input: 'PS20', brand: 'VIOLANTE', expect: { productCode: 'MP', qty: 20 } },
    // Tint-suffix strip on VIOLANTE-specific codes (Shopify + Amazon channels).
    { input: 'VO01-SW7068',  brand: 'VIOLANTE', expect: { productCode: 'MMB', qty: 1 } },
    { input: 'PS08-Natural', brand: 'VIOLANTE', expect: { productCode: 'MP',  qty: 8 } },

    // ── Cross-brand identity for shared codes (GL/BEE/SAV) ──────────────────
    // These SKUs live only in the Firmolux vocabulary; VIOLANTE reaches them
    // via fallthrough so they cannot diverge between brands. Each pair must
    // return the same productCode and qty regardless of the routing brand.
    { input: 'BEE2',       brand: 'Firmolux', expect: { productCode: 'BEE', qty: 2   } },
    { input: 'BEE2',       brand: 'VIOLANTE', expect: { productCode: 'BEE', qty: 2   } },
    { input: 'BEE.5',      brand: 'Firmolux', expect: { productCode: 'BEE', qty: 0.5 } },
    { input: 'BEE.5',      brand: 'VIOLANTE', expect: { productCode: 'BEE', qty: 0.5 } },
    { input: 'SAV1',       brand: 'Firmolux', expect: { productCode: 'SAV', qty: 1   } },
    { input: 'SAV1',       brand: 'VIOLANTE', expect: { productCode: 'SAV', qty: 1   } },
    { input: 'SAV2',       brand: 'Firmolux', expect: { productCode: 'SAV', qty: 2   } },
    { input: 'SAV2',       brand: 'VIOLANTE', expect: { productCode: 'SAV', qty: 2   } },
    { input: 'GL04',       brand: 'Firmolux', expect: { productCode: 'GL',  qty: 4   } },
    { input: 'GL04',       brand: 'VIOLANTE', expect: { productCode: 'GL',  qty: 4   } },
    { input: 'GL20',       brand: 'Firmolux', expect: { productCode: 'GL',  qty: 20  } },
    { input: 'GL20',       brand: 'VIOLANTE', expect: { productCode: 'GL',  qty: 20  } },
    // Tint-suffix strip on a shared code via VIOLANTE fallthrough.
    { input: 'GL01-BMOC45', brand: 'VIOLANTE', expect: { productCode: 'GL',  qty: 1  } },
    // DW: shared code, must parse identically under both brands via VIOLANTE fallthrough.
    { input: 'DW2',        brand: 'Firmolux', expect: { productCode: 'DW',  qty: 2  } },
    { input: 'DW2',        brand: 'VIOLANTE', expect: { productCode: 'DW',  qty: 2  } },
  ];

  const origLog = console.log;
  console.log = () => {};
  const results = cases.map(c => {
    const got = parseSKU(c.input, c.brand);
    const ok = c.expect === null
      ? got === null
      : (got && got.productCode === c.expect.productCode && got.qty === c.expect.qty);
    return { ...c, got, ok };
  });
  console.log = origLog;

  const failed = results.filter(r => !r.ok);
  for (const r of failed) {
    const label = r.brand ? `${r.input} [${r.brand}]` : r.input;
    console.error(`FAIL ${label}: expected ${JSON.stringify(r.expect)}, got ${JSON.stringify(r.got)}`);
  }
  if (failed.length) {
    console.error(`${failed.length} of ${cases.length} tests failed`);
    process.exit(1);
  } else {
    console.log(`All ${cases.length} tests passed`);
  }
}
