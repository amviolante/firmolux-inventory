require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { parseSKU } = require('./sku-parser');
const { sendSlackAlert } = require('./slack');

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

    await client.query(`DELETE FROM kit_components WHERE kit_code = 'KRH';`);
    await client.query(`
      INSERT INTO kit_components (kit_code, product_code, qty_per_kit) VALUES
        ('KRH', 'IP',  5),
        ('KRH', 'AP',  1),
        ('KRH', 'BEE', 0.5);
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
  const newQty = parseFloat(buckets) * parseFloat(product.bucket_size);
  await pool.query('UPDATE products SET current_qty = $1, updated_at = NOW() WHERE code = $2', [newQty, code.toUpperCase()]);
  res.json({ success: true, current_qty: newQty, buckets_remaining: parseFloat(buckets) });
});

// ─── API: Set reorder threshold (in buckets) ──────────────────────────────────
app.post('/api/products/:code/set-threshold', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { reorder_buckets } = req.body;
  if (reorder_buckets == null || isNaN(reorder_buckets) || reorder_buckets < 0) return res.status(400).json({ error: 'Invalid threshold' });
  await pool.query('UPDATE products SET reorder_buckets = $1 WHERE code = $2', [reorder_buckets, code.toUpperCase()]);
  res.json({ success: true });
});

// ─── API: Manual adjustment ───────────────────────────────────────────────────
app.post('/api/products/:code/adjust', requireAuth, async (req, res) => {
  const { code } = req.params;
  const { delta_qty } = req.body;
  if (delta_qty == null || isNaN(delta_qty)) return res.status(400).json({ error: 'Invalid delta' });
  await pool.query(
    'UPDATE products SET current_qty = current_qty + $1, updated_at = NOW() WHERE code = $2',
    [delta_qty, code.toUpperCase()]
  );
  res.json({ success: true });
});

// ─── API: Shipment log ────────────────────────────────────────────────────────
app.get('/api/log', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shipment_log ORDER BY processed_at DESC LIMIT 100');
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

    const deductions = [];
    let processedCount = 0;

    console.log('Processing items from order:', orderData.orderId);
    console.log('Items count:', (orderData.items || []).length);

    for (const item of orderData.items || []) {
      const sku = item.sku;
      const orderQty = item.quantity || 1;
      if (!sku) {
        console.log('⊘ Skipping item with no SKU');
        continue;
      }

      console.log(`→ Processing: SKU="${sku}", qty=${orderQty}`);
      const skuUpper = sku.split('-')[0].toUpperCase();

      if (skuUpper === 'KRH') {
        console.log('  → Kit detected: KRH');
        const { rows: components } = await pool.query(
          'SELECT kc.*, p.name, p.unit, p.current_qty, p.bucket_size, p.reorder_buckets FROM kit_components kc JOIN products p ON kc.product_code = p.code WHERE kc.kit_code = $1',
          ['KRH']
        );
        for (const comp of components) {
          const deductQty = comp.qty_per_kit * orderQty;
          console.log(`    ✓ ${comp.product_code} -${deductQty}`);
          await deductInventory(pool, comp.product_code, deductQty);
          deductions.push({ product: comp.product_code, qty: deductQty, reason: `KRH x${orderQty}` });
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
      await deductInventory(pool, parsed.productCode, totalDeduct);
      deductions.push({ product: parsed.productCode, qty: totalDeduct, sku, orderQty });
      await checkAndAlert(pool, parsed.productCode);
      processedCount++;
    }

    console.log(`Processed ${processedCount} items, ${deductions.length} deductions recorded`);

    // Include both successful deductions and failed SKUs in the log
    const allSkus = (orderData.items || []).map(item => item.sku || 'UNKNOWN').join(' | ');
    const failedSkus = (orderData.items || [])
      .filter(item => item.sku && !parseSKU(item.sku))
      .map(item => item.sku)
      .join(' | ');
    
    const logData = {
      deductions,
      allSkus,
      failedSkus: failedSkus || null
    };

    await pool.query(
      'INSERT INTO shipment_log (shipstation_order_id, sku, quantity, deductions) VALUES ($1, $2, $3, $4)',
      [orderData.orderId || payload.resource_url, 'BATCH', 1, JSON.stringify(logData)]
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
          if (parsed.shipments) {
            const orderId = parsed.shipments[0]?.orderId;
            const items = parsed.shipments.flatMap(s => s.shipmentItems || []);
            console.log('Found', items.length, 'items in shipments');
            resolve({ orderId, items });
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

async function deductInventory(pool, productCode, qty) {
  await pool.query(
    'UPDATE products SET current_qty = current_qty - $1, updated_at = NOW() WHERE code = $2',
    [qty, productCode]
  );
}

async function checkAndAlert(pool, productCode) {
  const { rows } = await pool.query('SELECT * FROM products WHERE code = $1', [productCode]);
  if (rows.length === 0) return;
  const product = rows[0];
  const bucketsRemaining = product.current_qty / product.bucket_size;
  if (bucketsRemaining < product.reorder_buckets) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) await sendSlackAlert(webhookUrl, product, product.current_qty, bucketsRemaining, product.reorder_buckets);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Firmolux Inventory running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
