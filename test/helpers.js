// Test harness. DB tests need TEST_DATABASE_URL pointing at a disposable
// Postgres (SSL on — server.js always connects with SSL). Each test file gets
// its own fresh database, schema created by booting the real server.js, so
// the tests run against exactly what initDB builds in production.
//
// NEVER point TEST_DATABASE_URL at Railway: every file drops and recreates
// its database.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const skipDb = !ADMIN_URL && 'TEST_DATABASE_URL not set';

if (ADMIN_URL && /rlwy\.net|railway/i.test(ADMIN_URL)) {
  throw new Error('TEST_DATABASE_URL points at Railway; tests drop databases. Refusing.');
}

function dbUrl(name) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

async function freshDatabase(name) {
  const admin = new Pool({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return dbUrl(name);
}

// Boots src/server.js against `url`. Resolves once it is listening.
function startServer(url, env = {}) {
  return new Promise((resolve, reject) => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
      env: { ...process.env, DATABASE_URL: url, PORT: String(port), SLACK_WEBHOOK_URL: '', APP_MODE: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = d => {
      out += d;
      if (out.includes('running on port')) resolve({ port, child, output: () => out, stop: () => stop(child) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => reject(new Error(`server exited ${code}:\n${out}`)));
    setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15000);
  });
}
function stop(child) {
  return new Promise(r => { child.removeAllListeners('exit'); child.on('exit', r); child.kill(); });
}

// Fresh DB with the production schema, plus a pool on it.
async function setupDb(name) {
  const url = await freshDatabase(name);
  const srv = await startServer(url);
  await srv.stop();
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 10 });
  await pool.query("UPDATE products SET current_qty = 1000");
  return { url, pool };
}

async function qty(pool, code) {
  const { rows } = await pool.query('SELECT current_qty FROM products WHERE code = $1', [code]);
  return parseFloat(rows[0].current_qty);
}

// Minimal ShipStation stand-in. `routes` maps "METHOD path" → handler(req, url)
// returning a JSON body (or { status, body }). Records every request.
function fakeShipStation(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const handler = routes[`${req.method} ${url.pathname}`];
    let out = handler ? handler(req, url) : { status: 404, body: { message: 'not found' } };
    if (!out || out.status === undefined) out = { status: 200, body: out };
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, calls, close: () => new Promise(r => server.close(r)) });
  }));
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { skipDb, setupDb, startServer, qty, fakeShipStation, post };
