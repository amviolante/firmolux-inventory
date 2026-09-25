// Non-inventory items: never deducted, never reported as "could not parse",
// never posted to Slack. Each shipment that contains one records it once in
// shipment_log (deductions.ignored).
//
// Edit here. Rules are only consulted for items the SKU parser could NOT
// parse, so a rule can never swallow a real inventory SKU — except rules
// marked `always`, which win even over a SKU that parses.
//
//   sku:  exact SKU, case-insensitive
//   skuPattern / namePattern:  regex against the SKU / the item name
//   text: regex against SKU or name
const IGNORE_RULES = [
  // Colorants: C + letters + digits, e.g. CB200, CV200, CNN500, CRV200, CG910-200, CG2X200.
  { label: 'colorant', skuPattern: /^C[A-Z]{1,3}\d/i },
  { label: 'non-inventory', sku: 'P825-S' },
  { label: 'non-inventory', sku: 'SPW1L' },
  { label: 'non-inventory', sku: 'NEB200' },
  // Merch. "Hat" is a whole word so names like "Chateau" don't match.
  { label: 'merch', text: /shirt|hoodie|\bhats?\b/i },
  // Sample kits deduct nothing.
  { label: 'sample kit', namePattern: /^\s*sample kit/i, always: true },
];

// → the matching rule's label, or null. `alwaysOnly` checks just the
// `always` rules (used before parsing).
function ignoredAs(item, { alwaysOnly = false } = {}) {
  const sku = (item.sku || '').trim();
  const name = (item.name || '').trim();
  for (const r of IGNORE_RULES) {
    if (alwaysOnly && !r.always) continue;
    if (r.sku && sku.toUpperCase() === r.sku.toUpperCase()) return r.label;
    if (r.skuPattern && sku && r.skuPattern.test(sku)) return r.label;
    if (r.namePattern && name && r.namePattern.test(name)) return r.label;
    if (r.text && (r.text.test(sku) || r.text.test(name))) return r.label;
  }
  return null;
}

module.exports = { IGNORE_RULES, ignoredAs };
