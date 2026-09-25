require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { sendSlackAlert, sendSkuParseFailureAlert, sendEmptyShipmentAlert, sendShipmentFetchFailureAlert, sendDeductionFailureAlert } = require('./slack');
const { migrateShipmentIds, loadKits, processShipment, shipmentsFromResponse } = require('./shipments');
const { initColorMatchSchema, mountColorMatchRoutes } = require('./color-match');

const app = express();
const PORT = process.env.PORT || 3000;

// APP_MODE=color-match runs a stripped service that only exposes /color-match +
// /api/color-match (and /img/* for the logo). Anything else (default) mounts the
// full inventory app. Used to deploy the color-match form as its own Railway
// service without exposing the dashboard/webhook/auth surface.
const APP_MODE = process.env.APP_MODE || 'full';
const COLOR_MATCH_ONLY = APP_MODE === 'color-match';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (!COLOR_MATCH_ONLY) app.use(cookieParser());
if (COLOR_MATCH_ONLY) {
  // Only expose the logo dir, not dashboard.html / login.html.
  app.use('/img', express.static(path.join(__dirname, '../public/img')));
} else {
  app.use(express.static(path.join(__dirname, '../public')));
}

// Color Match (customer-facing, no auth). Mounted in both modes.
mountColorMatchRoutes(app, pool);

// ─── Auto-setup DB on boot ────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  // Sentinel: distinguishes the brand-column migration failure inside the
  // outer catch. Migration errors rethrow to prevent boot into a half-migrated
  // schema; other errors keep the pre-existing log-and-continue behavior.
  let brandMigrationFailure = null;
  try {
    if (COLOR_MATCH_ONLY) {
      await initColorMatchSchema(client);
      console.log('✅ Database ready (color-match mode)');
      return;
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        unit VARCHAR(5) NOT NULL DEFAULT 'kg',
        bucket_size NUMERIC NOT NULL,
        current_qty NUMERIC NOT NULL DEFAULT 0,
        reorder_buckets NUMERIC NOT NULL DEFAULT 5,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS kit_components (
        id SERIAL PRIMARY KEY,
        kit_code VARCHAR(10) NOT NULL,
        product_code VARCHAR(10) NOT NULL,
        qty_per_kit NUMERIC NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shipment_log (
        id SERIAL PRIMARY KEY,
        shipstation_order_id VARCHAR(50),
        sku VARCHAR(100),
        quantity INTEGER,
        deductions JSONB,
        processed_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admin_session (
        token VARCHAR(64) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS inventory_audit (
        id SERIAL PRIMARY KEY,
        product_code VARCHAR(10) NOT NULL,
        change_type VARCHAR(20) NOT NULL,
        delta_qty NUMERIC,
        qty_before NUMERIC NOT NULL,
        qty_after NUMERIC NOT NULL,
        source VARCHAR(100),
        note VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS receiving_receipt (
        id SERIAL PRIMARY KEY,
        pasted_text TEXT NOT NULL,
        applied JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Brand column: existing rows default to 'Firmolux' since that's all we had
    // before per-brand webhook endpoints. New rows set brand from the fired route.
    // MUST succeed. A half-migrated schema causes recordAudit and shipment_log
    // INSERTs to fail per-request, committing deductions with no record — the
    // exact failure this system exists to prevent. Rethrown to trigger the
    // process.exit path at the initDB caller.
    try {
      await client.query(`
        ALTER TABLE shipment_log    ADD COLUMN IF NOT EXISTS brand VARCHAR(20) DEFAULT 'Firmolux';
        ALTER TABLE inventory_audit ADD COLUMN IF NOT EXISTS brand VARCHAR(20) DEFAULT 'Firmolux';
      `);
    } catch (err) {
      brandMigrationFailure = err;
      throw err;
    }

    // shipment_id on inventory_audit: the idempotency key for deductions.
    // Same must-succeed rule as the brand column — without it every webhook
    // would fail its duplicate check.
    try {
      await migrateShipmentIds(client);
    } catch (err) {
      brandMigrationFailure = err;
      throw err;
    }

    await client.query(`
      INSERT INTO products (code, name, unit, bucket_size, reorder_buckets) VALUES
        ('GL',  'Grassello',      'kg', 20, 5),
        ('AP',  'Anchor Primer',  'kg', 20, 5),
        ('MP',  'Microprimer', 'kg', 20, 5),
        ('MSM', 'Milano Silver',   'kg', 20, 5),
        ('MGM', 'Milano Gold',   'kg', 20, 5),
        ('MMB', 'Berlina',   'kg', 25, 5),
        ('IP',  'Piatto', 'kg', 25, 5),
        ('IM',  'Mezzo', 'kg', 25, 5),
        ('BEE', 'Beeswax',        'L',   5, 2),
        ('SAV', 'Sav',            'kg',  2, 3),
        ('DW',  'Decor Wax',      'L',   5, 2)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
    `);

    await client.query(`DELETE FROM kit_components WHERE kit_code IN ('KRH', 'KIT-T', 'KIT-U');`);
    await client.query(`
      INSERT INTO kit_components (kit_code, product_code, qty_per_kit) VALUES
        ('KRH', 'IP',  5),
        ('KRH', 'AP',  1),
        ('KRH', 'BEE', 0.5),
        ('KIT-T', 'GL', 1),
        ('KIT-T', 'MMB', 1),
        ('KIT-U', 'GL', 1),
        ('KIT-U', 'MMB', 1);
    `);

    await initColorMatchSchema(client);

    console.log('✅ Database ready');
  } catch (err) {
    console.error('DB init error:', err.message);
    if (brandMigrationFailure) {
      console.error('❌ Brand column migration failed — refusing to boot.');
      throw brandMigrationFailure;
    }
  } finally {
    client.release();
  }
}

// ─── Full-mode routes (skipped when APP_MODE=color-match) ─────────────────────
if (!COLOR_MATCH_ONLY) {

// ─── Auth middleware ───────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'firmolux2024';

async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.redirect('/login');
  try {
    const { rows } = await pool.query('SELECT token FROM admin_session WHERE token = $1', [token]);
    if (rows.length === 0) return res.redirect('/login');
    next();
  } catch (err) {
    return res.redirect('/login');
  }
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));

app.post('/login', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.redirect('/login?error=1');
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO admin_session (token) VALUES ($1)', [token]);
  res.cookie('session', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.redirect('/');
});

app.post('/logout', async (req, res) => {
  const token = req.cookies?.session;
  if (token) await pool.query('DELETE FROM admin_session WHERE token = $1', [token]);
  res.clearCookie('session');
  res.redirect('/login');
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// ─── API: Get all products ────────────────────────────────────────────────────
app.get('/api/products', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY name');
  const products = rows.map(p => ({
    ...p,
    buckets_remaining: parseFloat((p.current_qty / p.bucket_size).toFixed(2)),
    is_low: (p.current_qty / p.bucket_size) < p.reorder_buckets
  }));
  res.json(products);
});

// ─── API: Set starting inventory (in buckets) ─────────────────────────────────
app.post('/api/products/:code/set-inventory', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { buckets } = req.body;
  if (buckets == null || isNaN(buckets) || buckets < 0) return res.status(400).json({ error: 'Invalid bucket count' });
  const { rows } = await pool.query('SELECT * FROM products WHERE code = $1', [code.toUpperCase()]);
  if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
  const product = rows[0];
  const before = parseFloat(product.current_qty) || 0;
  const newQty = parseFloat(buckets) * parseFloat(product.bucket_size);
  const upper = code.toUpperCase();
  await pool.query('UPDATE products SET current_qty = $1, updated_at = NOW() WHERE code = $2', [newQty, upper]);
  await recordAudit(pool, {
    productCode: upper,
    changeType: 'manual_set',
    deltaQty: newQty - before,
    qtyBefore: before,
    qtyAfter: newQty,
    source: 'Dashboard (Set Inventory)',
    note: `Set to ${buckets} buckets`
  });
  await checkAndAlert(pool, upper);
  res.json({ success: true, current_qty: newQty, buckets_remaining: parseFloat(buckets) });
});

// ─── API: Set reorder threshold (in buckets) ──────────────────────────────────
app.post('/api/products/:code/set-threshold', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { reorder_buckets } = req.body;
  if (reorder_buckets == null || isNaN(reorder_buckets) || reorder_buckets < 0) return res.status(400).json({ error: 'Invalid threshold' });
  const upper = code.toUpperCase();
  await pool.query('UPDATE products SET reorder_buckets = $1 WHERE code = $2', [reorder_buckets, upper]);
  await checkAndAlert(pool, upper);
  res.json({ success: true });
});

// ─── API: Manual adjustment ───────────────────────────────────────────────────
app.post('/api/products/:code/adjust', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { delta_qty } = req.body;
  if (delta_qty == null || isNaN(delta_qty)) return res.status(400).json({ error: 'Invalid delta' });
  const upper = code.toUpperCase();
  const delta = parseFloat(delta_qty);
  const { rows } = await pool.query('SELECT current_qty FROM products WHERE code = $1', [upper]);
  if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
  const before = parseFloat(rows[0].current_qty) || 0;
  const after = before + delta;
  await pool.query(
    'UPDATE products SET current_qty = $1, updated_at = NOW() WHERE code = $2',
    [after, upper]
  );
  await recordAudit(pool, {
    productCode: upper,
    changeType: 'manual_adjust',
    deltaQty: delta,
    qtyBefore: before,
    qtyAfter: after,
    source: 'Dashboard (Adjust)',
    note: `${delta > 0 ? '+' : ''}${delta} ${delta > 0 ? '(added)' : '(removed)'}`
  });
  await checkAndAlert(pool, upper);
  res.json({ success: true });
});

// ─── API: Receiving (supplier receipt) ────────────────────────────────────────
// Plaster names use exact match only — "Marmorino Antico" and "Marmorino Matt"
// share a first word, and a loose match between them would put buckets in the
// wrong product. Waxes + Ancorante use a keyword substring because supplier
// wording varies there and none of the plaster names contain those keywords.
const RECEIVING_RULES = [
  { code: 'GL',  kind: 'exact',   pattern: 'grassello lucido' },
  { code: 'MMB', kind: 'exact',   pattern: 'marmorino antico 300' },
  { code: 'IP',  kind: 'exact',   pattern: 'marmorino matt 600' },
  { code: 'IM',  kind: 'exact',   pattern: 'intonachino classico 700' },
  { code: 'MP',  kind: 'exact',   pattern: 'microprimer' },
  { code: 'MGM', kind: 'exact',   pattern: 'murano gold' },
  { code: 'MSM', kind: 'exact',   pattern: 'murano silver' },
  { code: 'AP',  kind: 'keyword', pattern: 'ancorante' },
  { code: 'BEE', kind: 'keyword', pattern: 'beeswax' },
  { code: 'SAV', kind: 'keyword', pattern: 'soapstone' },
  { code: 'DW',  kind: 'keyword', pattern: 'decorwax' },
];

function normalizeSupplierName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Exact rules always win over keyword rules — do NOT collapse the two loops.
function matchReceivingProduct(supplierName) {
  const norm = normalizeSupplierName(supplierName);
  if (!norm) return null;
  for (const rule of RECEIVING_RULES) {
    if (rule.kind === 'exact' && norm === rule.pattern) return rule.code;
  }
  for (const rule of RECEIVING_RULES) {
    if (rule.kind === 'keyword' && norm.includes(rule.pattern)) return rule.code;
  }
  return null;
}

function parseReceivingText(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const entries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\(\s*(\d+)\s*\)\s*(.+)$/);
    if (!m) {
      entries.push({ rawLine: line, status: 'unmatched', reason: 'Expected "(N) Product Name"' });
      continue;
    }
    const buckets = parseInt(m[1], 10);
    const supplierName = m[2].trim();
    if (!Number.isFinite(buckets) || buckets <= 0) {
      entries.push({ rawLine: line, supplierName, status: 'unmatched', reason: 'Bucket count must be a positive integer' });
      continue;
    }
    const code = matchReceivingProduct(supplierName);
    if (!code) {
      entries.push({ rawLine: line, supplierName, buckets, status: 'unmatched', reason: 'Supplier name did not match any product' });
      continue;
    }
    entries.push({ rawLine: line, supplierName, buckets, code, status: 'matched' });
  }
  return entries;
}

async function buildReceivingPreview(pool, rawText) {
  const entries = parseReceivingText(rawText);
  const codes = [...new Set(entries.filter(e => e.status === 'matched').map(e => e.code))];
  let products = {};
  if (codes.length > 0) {
    const { rows } = await pool.query(
      'SELECT code, name, unit, bucket_size, current_qty FROM products WHERE code = ANY($1)',
      [codes]
    );
    products = Object.fromEntries(rows.map(r => [r.code, r]));
  }
  return entries.map(e => {
    if (e.status !== 'matched') return e;
    const p = products[e.code];
    if (!p) return { rawLine: e.rawLine, supplierName: e.supplierName, buckets: e.buckets, status: 'unmatched', reason: `Product ${e.code} not found in DB` };
    const bucketSize = parseFloat(p.bucket_size);
    const currentQty = parseFloat(p.current_qty);
    const deltaQty = e.buckets * bucketSize;
    return {
      rawLine: e.rawLine,
      supplierName: e.supplierName,
      buckets: e.buckets,
      status: 'matched',
      productCode: p.code,
      productName: p.name,
      unit: p.unit,
      bucketSize,
      currentQty,
      deltaQty,
      resultingQty: currentQty + deltaQty,
    };
  });
}

app.post('/api/receiving/parse', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Empty text' });
  try {
    const preview = await buildReceivingPreview(pool, text);
    res.json({ preview });
  } catch (err) {
    console.error('Receiving parse error:', err.message);
    res.status(500).json({ error: 'Parse failed' });
  }
});

// Server re-parses the text on commit rather than trusting a client-supplied
// plan — this way the applied result is deterministic from the pasted text
// alone. checkAndAlert is intentionally skipped: receiving only adds stock,
// so it can move a product out of the low band but never into it.
app.post('/api/receiving/commit', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Empty text' });
  try {
    const preview = await buildReceivingPreview(pool, text);
    const matched = preview.filter(e => e.status === 'matched');
    if (matched.length === 0) return res.status(400).json({ error: 'Nothing to receive — no matched lines' });

    const appliedSummary = matched.map(e => ({ code: e.productCode, buckets: e.buckets, deltaQty: e.deltaQty }));
    const receiptInsert = await pool.query(
      'INSERT INTO receiving_receipt (pasted_text, applied) VALUES ($1, $2) RETURNING id',
      [text, JSON.stringify(appliedSummary)]
    );
    const receiptId = receiptInsert.rows[0].id;
    const source = `Receiving (receipt #${receiptId})`;

    const applied = [];
    for (const entry of matched) {
      const { rows } = await pool.query('SELECT current_qty FROM products WHERE code = $1', [entry.productCode]);
      if (rows.length === 0) continue;
      const before = parseFloat(rows[0].current_qty) || 0;
      const after = before + entry.deltaQty;
      await pool.query(
        'UPDATE products SET current_qty = $1, updated_at = NOW() WHERE code = $2',
        [after, entry.productCode]
      );
      await recordAudit(pool, {
        productCode: entry.productCode,
        changeType: 'receiving',
        deltaQty: entry.deltaQty,
        qtyBefore: before,
        qtyAfter: after,
        source,
        note: `${entry.buckets} bucket${entry.buckets === 1 ? '' : 's'} @ ${entry.bucketSize}${entry.unit}`
      });
      applied.push({ code: entry.productCode, buckets: entry.buckets, deltaQty: entry.deltaQty, qtyAfter: after });
    }

    res.json({ success: true, receiptId, applied });
  } catch (err) {
    console.error('Receiving commit error:', err.message);
    res.status(500).json({ error: 'Commit failed' });
  }
});

// ─── API: Shipment log ────────────────────────────────────────────────────────
app.get('/api/log', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shipment_log ORDER BY processed_at DESC LIMIT 100');
  res.json(rows);
});

// ─── API: Audit log (all inventory changes) ───────────────────────────────────
app.get('/api/audit', requireAuth, async (req, res) => {
  // Optional ?type=manual to see only manual edits
  const { type } = req.query;
  let query = 'SELECT a.*, p.name AS product_name FROM inventory_audit a LEFT JOIN products p ON a.product_code = p.code';
  const params = [];
  if (type === 'manual') {
    query += " WHERE a.change_type IN ('manual_adjust', 'manual_set')";
  }
  query += ' ORDER BY a.created_at DESC LIMIT 500';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// ─── WEBHOOK: ShipStation ─────────────────────────────────────────────────────
// Always answers 200 once the request is read: a non-200 makes ShipStation
// retry, and retries were the main source of double deductions. Failures go
// to Slack instead. Each shipment in the batch is deducted in its own
// transaction keyed on shipmentId (see src/shipments.js), so a retry or a
// relabel notification for an already-deducted shipment is skipped, and a
// shipment that fails part-way leaves nothing behind for reconcile to find.
async function handleShipmentWebhook(req, res, brand, credentials) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const payload = req.body;
  const slack = async (label, fn) => {
    if (!webhookUrl) return;
    try { await fn(); } catch (err) { console.error(`Slack ${label} alert failed:`, err.message); }
  };
  try {
    console.log(`[${brand}] ShipStation webhook received:`, JSON.stringify(payload).slice(0, 300));

    let shipments = null;
    let fetchError = null;
    try {
      shipments = await fetchShipStationShipments(payload, credentials);
    } catch (err) {
      fetchError = err.message;
    }
    if (!shipments || shipments.length === 0) {
      const reason = (!credentials || !credentials.apiKey || !credentials.apiSecret)
        ? 'ShipStation credentials missing for this route'
        : fetchError
          ? `ShipStation fetch failed: ${fetchError}`
          : 'Could not resolve shipment data (missing resource_url or empty ShipStation response)';
      console.log(`🚫 [${brand}] Shipment fetch failure: ${reason}`);
      await slack('fetch-failure', () => sendShipmentFetchFailureAlert(webhookUrl, {
        brand, reason, payloadSummary: JSON.stringify(payload).slice(0, 500),
      }));
      return res.status(200).json({ message: 'No shipment data to process' });
    }

    const kits = await loadKits(pool);
    const results = [];
    for (const shipment of shipments) {
      const orderLabel = shipment.orderNumber || shipment.orderId || null;
      console.log(`[${brand}] Shipment ${shipment.shipmentId} (order ${orderLabel}): ${shipment.items.length} items`);

      if (shipment.items.length === 0) {
        // Zero items → human review, not an error.
        await slack('empty-shipment', () => sendEmptyShipmentAlert(webhookUrl, { orderNumber: orderLabel }));
      }

      let result;
      try {
        result = await processShipment(pool, brand, shipment, { kits });
      } catch (err) {
        console.error(`[${brand}] Deduction failed for shipment ${shipment.shipmentId}:`, err);
        await slack('deduction-failure', () => sendDeductionFailureAlert(webhookUrl, {
          brand, orderNumber: orderLabel, shipmentId: shipment.shipmentId, error: err.message,
        }));
        results.push({ shipmentId: shipment.shipmentId, status: 'failed' });
        continue;
      }
      console.log(`[${brand}] Shipment ${shipment.shipmentId}: ${result.status}, ${result.deductions.length} deductions`);
      results.push({ shipmentId: shipment.shipmentId, status: result.status, deductions: result.deductions });
      if (result.status === 'duplicate') continue;

      if (result.failed.length > 0) {
        console.log(`⚠️ Unparseable SKU alert for order ${orderLabel}: ${result.failed.join(' | ')}`);
        await slack('parse-failure', () => sendSkuParseFailureAlert(webhookUrl, {
          orderNumber: orderLabel, brand, unparseableSkus: result.failed,
        }));
      }
      for (const code of new Set(result.deductions.map(d => d.product))) {
        await checkAndAlert(pool, code);
      }
    }
    res.json({ success: true, shipments: results });
  } catch (err) {
    console.error(`[${brand}] Webhook error:`, err);
    await slack('deduction-failure', () => sendDeductionFailureAlert(webhookUrl, {
      brand, orderNumber: null, shipmentId: null, error: err.message,
    }));
    res.status(200).json({ success: false, error: 'Internal error (reported to Slack)' });
  }
}

// ─── WEBHOOK routes ───────────────────────────────────────────────────────────
// Existing /webhook/shipstation is kept as a Firmolux alias so the currently
// configured ShipStation webhook keeps working through the deploy. Removing it
// is a separate step after ShipStation is repointed to /firmolux.
const firmoluxCredentials = () => ({
  apiKey: process.env.SHIPSTATION_API_KEY,
  apiSecret: process.env.SHIPSTATION_API_SECRET,
});
const violanteCredentials = () => ({
  apiKey: process.env.VIOLANTE_SHIPSTATION_API_KEY,
  apiSecret: process.env.VIOLANTE_SHIPSTATION_API_SECRET,
});

app.post('/webhook/shipstation',          (req, res) => handleShipmentWebhook(req, res, 'Firmolux', firmoluxCredentials()));
app.post('/webhook/shipstation/firmolux', (req, res) => handleShipmentWebhook(req, res, 'Firmolux', firmoluxCredentials()));
app.post('/webhook/shipstation/violante', (req, res) => handleShipmentWebhook(req, res, 'VIOLANTE', violanteCredentials()));

} // end if (!COLOR_MATCH_ONLY)

// ─── Helpers ──────────────────────────────────────────────────────────────────
const SHIPSTATION_API_BASE = process.env.SHIPSTATION_API_BASE || 'https://ssapi.shipstation.com';

// Returns the notification's shipments (one entry each), or null when there
// is nothing to fetch. Throws on a network / parse error.
async function fetchShipStationShipments(payload, { apiKey, apiSecret } = {}) {
  const resourceUrl = payload && payload.resource_url;
  if (!apiKey || !apiSecret || !resourceUrl) return null;

  // Only ever send the API credentials to ShipStation. The webhook is
  // unauthenticated, so resource_url is caller-controlled.
  const url = new URL(resourceUrl);
  const allowed = new URL(SHIPSTATION_API_BASE);
  if (url.origin !== allowed.origin) {
    throw new Error(`resource_url host ${url.host} is not ${allowed.host}`);
  }
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const lib = url.protocol === 'http:' ? require('http') : require('https');

  return new Promise((resolve, reject) => {
    console.log('Fetching from ShipStation:', url.hostname + url.pathname);
    const req = lib.get({
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers: { 'Authorization': `Basic ${auth}` }
    }, res => {
      console.log('ShipStation response status:', res.statusCode);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(shipmentsFromResponse(JSON.parse(data))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('ShipStation request timed out after 15000ms')));
  });
}

async function recordAudit(pool, { productCode, changeType, deltaQty, qtyBefore, qtyAfter, source, note, brand }) {
  // Dashboard-driven manual routes don't pass brand and default to Firmolux —
  // the dashboard is Firmolux-scoped today. Webhook routes pass brand explicitly.
  const brandVal = brand || 'Firmolux';
  try {
    await pool.query(
      `INSERT INTO inventory_audit (product_code, change_type, delta_qty, qty_before, qty_after, source, note, brand)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [productCode, changeType, deltaQty, qtyBefore, qtyAfter, source, note, brandVal]
    );
  } catch (err) {
    console.error('Failed to record audit entry:', err.message);
  }
}

async function checkAndAlert(pool, productCode) {
  const { rows } = await pool.query('SELECT * FROM products WHERE code = $1', [productCode]);
  if (rows.length === 0) return;
  const product = rows[0];
  const currentQty = parseFloat(product.current_qty) || 0;
  const bucketSize = parseFloat(product.bucket_size) || 1;
  const bucketsRemaining = currentQty / bucketSize;
  if (bucketsRemaining < product.reorder_buckets) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      console.log(`🔔 Checking alert for ${productCode}: ${bucketsRemaining.toFixed(1)} buckets < ${product.reorder_buckets} threshold`);
      // Slack failures MUST NOT propagate — checkAndAlert is awaited per-item
      // inside the ShipStation webhook handler; an error here would return
      // non-200 and cause ShipStation to retry an already-deducted order.
      try {
        await sendSlackAlert(webhookUrl, product, currentQty, bucketsRemaining, product.reorder_buckets);
      } catch (err) {
        console.error(`Slack low-inventory alert failed for ${productCode}:`, err.message);
      }
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  const label = COLOR_MATCH_ONLY ? 'Firmolux Color Match' : 'Firmolux Inventory';
  app.listen(PORT, () => console.log(`${label} running on port ${PORT} (APP_MODE=${APP_MODE})`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
