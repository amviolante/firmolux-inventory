// Line items that arrive with no SKU (or a SKU the parser can't read) are
// matched on their product NAME, so manual and freight orders still deduct.
// Owner-confirmed 2026-10-26.
//
// Edit here. Each rule: a pattern on the item name → product code (or kit).
// First match wins, so put longer / more specific names first.
//
// Size: the first "<n>kg", "<n>L" or "<n>oz" in the name. No size in the
// name → the product's full bucket (FULL_SIZE). A size that isn't a real
// bucket size for that product is NOT guessed: the item goes to Slack.
const NAME_RULES = [
  { pattern: /\bkitchen range hood\b/i, kit: 'KRH' },
  { pattern: /\bprimo strato\b/i, product: 'MP' },
  { pattern: /\bmicroprimer\b/i, product: 'MP' },
  { pattern: /\banchor primer\b/i, product: 'AP' },
  { pattern: /\bmilano silver\b/i, product: 'MSM' },
  { pattern: /\bmilano gold\b/i, product: 'MGM' },
  { pattern: /\bdecor ?wax\b/i, product: 'DW' },
  { pattern: /\bbeeswax\b/i, product: 'BEE' },
  { pattern: /\bsoapstone\b/i, product: 'SAV' },
  { pattern: /\bgrassello\b/i, product: 'GL' },
  { pattern: /\b(rivo|berlina)\b/i, product: 'MMB' },
  { pattern: /\b(rialto|piatto)\b/i, product: 'IP' },
  { pattern: /\bmezzo\b/i, product: 'IM' },
];

// Full bucket per product (matches products.bucket_size).
const FULL_SIZE = { GL: 20, AP: 20, MP: 20, MSM: 20, MGM: 20, MMB: 25, IP: 25, IM: 25, BEE: 5, SAV: 2, DW: 5 };

// Real sizes per product, in the product's unit (kg, or L for BEE/DW).
const VALID_SIZES = {
  GL: [1, 4, 8, 12, 20], AP: [1, 4, 8, 12, 20], MP: [1, 4, 8, 12, 20],
  MSM: [1, 4, 8, 12, 20], MGM: [1, 4, 8, 12, 20],
  MMB: [1, 5, 10, 15, 25], IP: [1, 5, 10, 15, 25], IM: [1, 5, 10, 15, 25],
  BEE: [0.5, 1, 2, 5], SAV: [1, 2], DW: [1, 2, 5],
};

const OZ_TO_L = 0.0295735;

function sizeFromName(name, product) {
  const kg = /(\d+(?:\.\d+)?)\s*kg\b/i.exec(name);
  if (kg) return parseFloat(kg[1]);
  const l = /(\d+(?:\.\d+)?)\s*l\b/i.exec(name);
  if (l) return parseFloat(l[1]);
  const oz = /(\d+(?:\.\d+)?)\s*oz\b/i.exec(name);
  if (oz) {
    // 16 oz ≈ 0.47 L → the 0.5 L tin. Snap only to a real size within 10%.
    const litres = parseFloat(oz[1]) * OZ_TO_L;
    const near = (VALID_SIZES[product] || []).find(s => Math.abs(s - litres) / s <= 0.1);
    return near !== undefined ? near : litres;
  }
  return null;
}

// → { productCode, qty } | { kit } | { error } | null (no rule matched)
function parseItemName(name) {
  if (!name || typeof name !== 'string') return null;
  const rule = NAME_RULES.find(r => r.pattern.test(name));
  if (!rule) return null;
  if (rule.kit) return { kit: rule.kit };
  const product = rule.product;
  const size = sizeFromName(name, product);
  const qty = size === null ? FULL_SIZE[product] : size;
  if (!VALID_SIZES[product].includes(qty)) {
    return { error: `${product} size ${Math.round(qty * 100) / 100} is not a real size` };
  }
  return { productCode: product, qty };
}

module.exports = { NAME_RULES, FULL_SIZE, parseItemName };
