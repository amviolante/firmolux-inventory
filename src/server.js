require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { parseSKU } = require('./sku-parser');
const { sendSlackAlert, sendSkuParseFailureAlert, sendEmptyShipmentAlert } = require('./slack');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Auto-setup DB on boot ────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
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
    `);

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
        ('SAV', 'Sav',            'kg',  2, 3)
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

    console.log('✅ Database ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally {
    client.release();
  }
}

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
app.post('/webhook/shipstation', async (req, res) => {
  try {
    // Auth check removed — URL privacy is sufficient

    const payload = req.body;
    console.log('ShipStation webhook received:', JSON.stringify(payload).slice(0, 300));

    const orderData = await fetchShipStationOrder(payload);
    if (!orderData) return res.status(200).json({ message: 'No order data to process' });

    const orderTag = orderData.orderNumber
      ? `Order #${orderData.orderNumber}`
      : (orderData.orderId ? `Order #${orderData.orderId}` : 'Order (unknown)');
    const orderLabel = orderData.orderNumber || orderData.orderId || null;

    const deductions = [];
    let processedCount = 0;

    console.log('Processing items from order:', orderData.orderId);
    console.log('Items count:', (orderData.items || []).length);

    // Fetched shipment with zero items → human review, not an error.
    // Slack failures MUST NOT propagate — the outer catch returns non-200 and
    // ShipStation would retry, double-deducting anything already processed.
    if ((orderData.items || []).length === 0) {
      const webhookUrl = process.env.SLACK_WEBHOOK_URL;
      if (webhookUrl) {
        console.log(`🔎 Empty shipment alert for ${orderTag}`);
        try {
          await sendEmptyShipmentAlert(webhookUrl, { orderNumber: orderLabel });
        } catch (err) {
          console.error(`Slack empty-shipment alert failed for ${orderTag}:`, err.message);
        }
      }
    }

    for (const item of orderData.items || []) {
      const sku = item.sku;
      const orderQty = item.quantity || 1;
      if (!sku) {
        console.log('⊘ Skipping item with no SKU');
        continue;
      }

      console.log(`→ Processing: SKU="${sku}", qty=${orderQty}`);
      const skuUpper = sku.split('-')[0].toUpperCase();

      if (skuUpper === 'KRH' || skuUpper === 'KIT-T' || skuUpper === 'KIT-U') {
        const kitName = skuUpper;
        console.log(`  → Kit detected: ${kitName}`);
        const { rows: components } = await pool.query(
          'SELECT kc.*, p.name, p.unit, p.current_qty, p.bucket_size, p.reorder_buckets FROM kit_components kc JOIN products p ON kc.product_code = p.code WHERE kc.kit_code = $1',
          [kitName]
        );
        for (const comp of components) {
          const deductQty = comp.qty_per_kit * orderQty;
          console.log(`    ✓ ${comp.product_code} -${deductQty}`);
          await deductInventory(pool, comp.product_code, deductQty, {
            changeType: 'shipment',
            source: orderTag,
            note: `${kitName} x${orderQty}`
          });
          deductions.push({ product: comp.product_code, qty: deductQty, reason: `${kitName} x${orderQty}` });
          await checkAndAlert(pool, comp.product_code);
        }
        processedCount++;
        continue;
      }

      const parsed = parseSKU(sku);
      if (!parsed) { 
        console.log(`  ❌ Could not parse SKU`);
        continue; 
      }

      const totalDeduct = parsed.qty * orderQty;
      console.log(`  ✓ ${parsed.productCode} -${totalDeduct}kg`);
      await deductInventory(pool, parsed.productCode, totalDeduct, {
        changeType: 'shipment',
        source: orderTag,
        note: `${sku} x${orderQty}`
      });
      deductions.push({ product: parsed.productCode, qty: totalDeduct, sku, orderQty });
      await checkAndAlert(pool, parsed.productCode);
      processedCount++;
    }

    console.log(`Processed ${processedCount} items, ${deductions.length} deductions recorded`);

    // Capture any SKUs that failed to parse (for visibility in the log)
    const failedSkuList = (orderData.items || [])
      .filter(item => item.sku && item.sku.split('-')[0].toUpperCase() !== 'KRH'
                      && item.sku.split('-')[0].toUpperCase() !== 'KIT-T'
                      && item.sku.split('-')[0].toUpperCase() !== 'KIT-U'
                      && !parseSKU(item.sku))
      .map(item => item.sku);
    const failedSkus = failedSkuList.join(' | ');

    // Any parse failure → Slack alert with order + raw SKU strings.
    // Slack failures MUST NOT propagate — see empty-shipment alert above.
    if (failedSkuList.length > 0) {
      const webhookUrl = process.env.SLACK_WEBHOOK_URL;
      if (webhookUrl) {
        console.log(`⚠️ Unparseable SKU alert for ${orderTag}: ${failedSkus}`);
        try {
          await sendSkuParseFailureAlert(webhookUrl, {
            orderNumber: orderLabel,
            unparseableSkus: failedSkuList
          });
        } catch (err) {
          console.error(`Slack parse-failure alert failed for ${orderTag}:`, err.message);
        }
      }
    }

    const logData = {
      deductions,
      failedSkus: failedSkus || null
    };

    const displayId = orderData.orderNumber ? `#${orderData.orderNumber}` : (orderData.orderId ? `#${orderData.orderId}` : 'Unknown');
    const displayName = orderData.customerName ? ` - ${orderData.customerName}` : '';
    const fullIdentifier = displayId + displayName;
    
    await pool.query(
      'INSERT INTO shipment_log (shipstation_order_id, sku, quantity, deductions) VALUES ($1, $2, $3, $4)',
      [fullIdentifier, 'BATCH', 1, JSON.stringify(logData)]
    );
    console.log('✅ Saved to log');

    res.json({ success: true, deductions });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function fetchShipStationOrder(payload) {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;

  console.log('fetchShipStationOrder called, have credentials:', !!(apiKey && apiSecret));

  if (!apiKey || !apiSecret) {
    console.log('No API credentials, checking payload for items directly');
    if (payload.items) return payload;
    return null;
  }

  const resourceUrl = payload.resource_url;
  if (!resourceUrl) {
    if (payload.items) return payload;
    return null;
  }

  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const https = require('https');

  return new Promise((resolve, reject) => {
    const url = new URL(resourceUrl);
    console.log('Fetching from ShipStation:', url.hostname + url.pathname);
    https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Authorization': `Basic ${auth}` }
    }, res => {
      console.log('ShipStation response status:', res.statusCode);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log('Parsed response:', JSON.stringify(parsed).slice(0, 200));
          if (parsed.shipments && parsed.shipments.length > 0) {
            const shipment = parsed.shipments[0];
            const orderId = shipment.orderId;
            const orderNumber = shipment.orderNumber;
            const customerName = shipment.customerName;
            const items = parsed.shipments.flatMap(s => s.shipmentItems || []);
            console.log('=== ShipStation Shipment Object ===');
            console.log('Available fields:', Object.keys(shipment).join(', '));
            console.log('orderId:', orderId);
            console.log('orderNumber:', orderNumber);
            console.log('customerName:', customerName);
            console.log('customerEmail:', shipment.customerEmail);
            console.log('Found', items.length, 'items');
            resolve({ orderId, orderNumber, customerName, items });
          } else if (parsed.items) {
            console.log('Found', parsed.items.length, 'items directly');
            resolve(parsed);
          } else {
            console.log('No items found in response');
            resolve(null);
          }
        } catch (e) { console.error('Parse error:', e.message); reject(e); }
      });
    }).on('error', err => {
      console.error('ShipStation fetch error:', err.message);
      reject(err);
    });
  });
}

async function deductInventory(pool, productCode, qty, opts = {}) {
  const { rows } = await pool.query('SELECT current_qty FROM products WHERE code = $1', [productCode]);
  if (rows.length === 0) return;
  const before = parseFloat(rows[0].current_qty) || 0;
  const after = before - qty;
  await pool.query(
    'UPDATE products SET current_qty = $1, updated_at = NOW() WHERE code = $2',
    [after, productCode]
  );
  await recordAudit(pool, {
    productCode,
    changeType: opts.changeType || 'shipment',
    deltaQty: -qty,
    qtyBefore: before,
    qtyAfter: after,
    source: opts.source || null,
    note: opts.note || null
  });
}

async function recordAudit(pool, { productCode, changeType, deltaQty, qtyBefore, qtyAfter, source, note }) {
  try {
    await pool.query(
      `INSERT INTO inventory_audit (product_code, change_type, delta_qty, qty_before, qty_after, source, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [productCode, changeType, deltaQty, qtyBefore, qtyAfter, source, note]
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
      await sendSlackAlert(webhookUrl, product, currentQty, bucketsRemaining, product.reorder_buckets);
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Firmolux Inventory running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
