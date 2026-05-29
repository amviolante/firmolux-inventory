// Parses ShipStation SKUs into { productCode, qty }
// Examples:
//   GL04KG-BM1093  → { productCode: 'GL',  qty: 4 }
//   MMB25KG-SW123  → { productCode: 'MMB', qty: 25 }
//   BEE5           → { productCode: 'BEE', qty: 5 }
//   BEE1           → { productCode: 'BEE', qty: 1 }
//   GL01KG-BM2034-30 → { productCode: 'GL', qty: 1 }
//   GL20KG-...     → { productCode: 'GL',  qty: 20 }
//   MMB01          → { productCode: 'MMB', qty: 1 }
//   SAV            → { productCode: 'SAV', qty: 2 }
//   KRH            → { productCode: 'KRH', qty: 1 }
//   GL08           → { productCode: 'GL',  qty: 8 }

const KNOWN_PREFIXES = ['MMB', 'MSM', 'MGM', 'BEE', 'SAV', 'KRH', 'GL', 'AP', 'MP', 'IP', 'IM'];

// Products that are always a fixed qty regardless of SKU suffix
const FIXED_QTY = {
  SAV: 2,
  KRH: 1, // handled as kit, qty multiplied by order quantity
};

function parseSKU(rawSku) {
  if (!rawSku || typeof rawSku !== 'string') return null;

  // Strip everything after the first '-' (tint code, batch ref, etc.)
  const sku = rawSku.split('-')[0].trim().toUpperCase();

  // Find matching prefix (try longest first)
  const prefix = KNOWN_PREFIXES.find(p => sku.startsWith(p));
  if (!prefix) return null;

  // Fixed-qty products
  if (FIXED_QTY[prefix] !== undefined) {
    return { productCode: prefix, qty: FIXED_QTY[prefix] };
  }

  // Extract numeric portion after prefix
  // e.g. GL04KG → '04', GL08 → '08', BEE5 → '5', MMB25KG → '25'
  const rest = sku.slice(prefix.length);
  const match = rest.match(/^0*(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const qty = parseFloat(match[1]);
  if (isNaN(qty) || qty <= 0) return null;

  return { productCode: prefix, qty };
}

module.exports = { parseSKU, KNOWN_PREFIXES };
