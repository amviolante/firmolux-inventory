// Run once: node src/setup-db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function setup() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        code VARCHAR(10) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        unit VARCHAR(5) NOT NULL DEFAULT 'kg',   -- 'kg' or 'L'
        bucket_size NUMERIC NOT NULL,             -- kg or L per bucket
        current_qty NUMERIC NOT NULL DEFAULT 0,  -- total kg or L on hand
        reorder_buckets NUMERIC NOT NULL DEFAULT 5, -- alert when buckets remaining < this
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

    // Insert default products (idempotent)
    await client.query(`
      INSERT INTO products (code, name, unit, bucket_size, reorder_buckets) VALUES
        ('GL',  'Grassello',         'kg', 20, 5),
        ('AP',  'Antico Paints',     'kg', 20, 5),
        ('MP',  'Marmorino Plus',    'kg', 20, 5),
        ('MSM', 'Marmorino SM',      'kg', 20, 5),
        ('MGM', 'Marmorino GM',      'kg', 20, 5),
        ('MMB', 'Marmorino MB',      'kg', 25, 5),
        ('IP',  'Intonaco Primo',    'kg', 25, 5),
        ('IM',  'Intonaco Medio',    'kg', 25, 5),
        ('BEE', 'Beeswax',           'L',   5, 2),
        ('SAV', 'Sav',               'kg',  2, 3)
      ON CONFLICT (code) DO NOTHING;
    `);

    // KRH kit components
    await client.query(`DELETE FROM kit_components WHERE kit_code = 'KRH';`);
    await client.query(`
      INSERT INTO kit_components (kit_code, product_code, qty_per_kit) VALUES
        ('KRH', 'IP',  5),
        ('KRH', 'AP',  1),
        ('KRH', 'BEE', 0.5);
    `);

    console.log('✅ Database setup complete');
  } finally {
    client.release();
    await pool.end();
  }
}

setup().catch(e => { console.error(e); process.exit(1); });
