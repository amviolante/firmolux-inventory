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
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.DATABASE_URL?.includes('railway.app')
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Auth middleware ───────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'firmolux2024';

async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.redirect('/login');
  const { rows } = await pool.query('SELECT token FROM admin_session WHERE token = $1', [token]);
  if (rows.length === 0) return res.redirect('/login');
  next();
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
  const { delta_qty } = req.body; // positive = add, negative = remove
  if (delta_qty == null || isNaN(delta_qty)) return res.status(400).json({ error: 'Invalid delta' });
  await pool.query(
    'UPDATE products SET current_qty = GREATEST(0, current_qty + $1), updated_at = NOW() WHERE code = $2',
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
// ShipStation calls this when an order ships
// Webhook secret in SS should match SHIPSTATION_WEBHOOK_SECRET env var (optional but recommended)
app.post('/webhook/shipstation', async (req, res) => {
  try {
    const secret = process.env.SHIPSTATION_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers['x-shipstation-hmac-sha256'] || req.headers['authorization'];
      if (!provided || !provided.includes(secret)) {
        console.warn('Webhook auth failed');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body;
    console.log('ShipStation webhook received:', JSON.stringify(payload).slice(0, 500));

    // ShipStation sends resource_url for the order on shipment webhooks
    // We need to fetch the actual order from SS API
    const orderData = await fetchShipStationOrder(payload);
    if (!orderData) {
      return res.status(200).json({ message: 'No order data to process' });
    }

    const deductions = [];

    for (const item of orderData.items || []) {
      const sku = item.sku;
      const orderQty = item.quantity || 1;

      // Skip items with no SKU or known non-inventory SKUs
      if (!sku) continue;

      const skuUpper = sku.split('-')[0].toUpperCase();

      // Handle KRH kit
      if (skuUpper === 'KRH') {
        const { rows: components } = await pool.query(
          'SELECT kc.*, p.name, p.unit, p.current_qty, p.bucket_size, p.reorder_buckets FROM kit_components kc JOIN products p ON kc.product_code = p.code WHERE kc.kit_code = $1',
          ['KRH']
        );
        for (const comp of components) {
          const deductQty = comp.qty_per_kit * orderQty;
          await deductInventory(pool, comp.product_code, deductQty);
          deductions.push({ product: comp.product_code, qty: deductQty, reason: `KRH x${orderQty}` });
          await checkAndAlert(pool, comp.product_code);
        }
        continue;
      }

      const parsed = parseSKU(sku);
      if (!parsed) {
        console.log(`Unrecognized SKU: ${sku}`);
        continue;
      }

      const totalDeduct = parsed.qty * orderQty;
      await deductInventory(pool, parsed.productCode, totalDeduct);
      deductions.push({ product: parsed.productCode, qty: totalDeduct, sku, orderQty });
      await checkAndAlert(pool, parsed.productCode);
    }

    // Log it
    await pool.query(
      'INSERT INTO shipment_log (shipstation_order_id, sku, quantity, deductions) VALUES ($1, $2, $3, $4)',
      [orderData.orderId || payload.resource_url, 'BATCH', 1, JSON.stringify(deductions)]
    );

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

  if (!apiKey || !apiSecret) {
    // Dev mode: if payload has items directly, use them
    if (payload.items) return payload;
    console.warn('No ShipStation credentials set');
    return null;
  }

  // ShipStation webhook sends resource_url pointing to the shipment
  const resourceUrl = payload.resource_url;
  if (!resourceUrl) {
    // Sometimes the full order is embedded
    if (payload.items) return payload;
    return null;
  }

  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const https = require('https');

  return new Promise((resolve, reject) => {
    const url = new URL(resourceUrl);
    https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Authorization': `Basic ${auth}` }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // SS returns { shipments: [...] } for SHIP_NOTIFY webhooks
          // Each shipment has orderKey and we need the order items
          // For simplicity, extract items from first shipment's order
          if (parsed.shipments) {
            const allItems = [];
            const orderId = parsed.shipments[0]?.orderId;
            // We'd need another call to get order items; batch them
            resolve({ orderId, items: parsed.shipments.flatMap(s => s.shipmentItems || []) });
          } else if (parsed.items) {
            resolve(parsed);
          } else {
            resolve(null);
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function deductInventory(pool, productCode, qty) {
  await pool.query(
    'UPDATE products SET current_qty = GREATEST(0, current_qty - $1), updated_at = NOW() WHERE code = $2',
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
    if (webhookUrl) {
      await sendSlackAlert(webhookUrl, product, product.current_qty, bucketsRemaining, product.reorder_buckets);
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Firmolux Inventory running on port ${PORT}`));
