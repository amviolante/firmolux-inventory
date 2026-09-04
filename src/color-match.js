const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { postSlackBotMessage } = require('./slack');

const HTML_PATH = path.join(__dirname, '../public/color-match.html');
const MAX_BODY_BYTES = 20 * 1024;
const MAX_STRING_LEN = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAVY = '#323251';
const GOLD = '#DECDA6';

// Frontend sends the checkbox `value` attribute (see public/color-match.html).
// Only overrides listed here — anything else passes through unchanged.
const PRODUCT_LABELS = {
  'Berlina': 'Marmorino Berlina',
};

async function initColorMatchSchema(client) {
  await client.query(`
    CREATE SEQUENCE IF NOT EXISTS color_match_seq START 1000;
    CREATE TABLE IF NOT EXISTS color_match_requests (
      id            INTEGER PRIMARY KEY DEFAULT nextval('color_match_seq'),
      code          TEXT GENERATED ALWAYS AS ('FX-' || id) STORED,
      purpose       TEXT NOT NULL,
      first_name    TEXT NOT NULL,
      last_name     TEXT NOT NULL,
      email         TEXT NOT NULL,
      payload       JSONB NOT NULL,
      status        TEXT NOT NULL DEFAULT 'awaiting_sample',
      slack_ts      TEXT,
      email_sent    BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS color_match_email_idx ON color_match_requests (lower(email));
  `);
}

let cachedHtml = null;
function getPageHtml() {
  if (cachedHtml !== null) return cachedHtml;
  const raw = fs.readFileSync(HTML_PATH, 'utf8');
  const warehouse = process.env.WAREHOUSE_ADDRESS;
  if (warehouse && warehouse.trim()) {
    const escaped = escapeHtml(warehouse.replace(/\\n/g, '\n'));
    cachedHtml = raw.replace(
      /(<div class="addr" id="shipTo">)([\s\S]*?)(<\/div>)/,
      `$1${escaped}$3`
    );
  } else {
    cachedHtml = raw;
  }
  return cachedHtml;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Per-IP sliding window: 10 requests per 10 minutes.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 10;
const rateBuckets = new Map();
function rateLimitCheck(ip) {
  const now = Date.now();
  const arr = rateBuckets.get(ip) || [];
  const fresh = arr.filter(t => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT) {
    rateBuckets.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  // Opportunistic cleanup to prevent unbounded map growth.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      const kept = v.filter(t => now - t < RATE_WINDOW_MS);
      if (kept.length === 0) rateBuckets.delete(k);
      else rateBuckets.set(k, kept);
    }
  }
  return true;
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function s(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, MAX_STRING_LEN);
}
function sanitizeArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(s).filter(x => x.length > 0).slice(0, 50);
}
function sanitizePayload(raw) {
  const p = {};
  const stringFields = [
    'purpose', 'first_name', 'last_name', 'email',
    'previous_code', 'has_order', 'order_number', 'returning',
    'phone', 'address1', 'address2', 'city', 'state', 'zip',
    'qty_mode', 'quantity', 'primer', 'deadline',
    'sample_other', 'paint_reference', 'notes',
  ];
  for (const k of stringFields) {
    if (raw[k] != null) p[k] = s(raw[k]);
  }
  if (raw.products != null) p.products = sanitizeArray(raw.products);
  if (raw.sample_types != null) p.sample_types = sanitizeArray(raw.sample_types);
  if (raw.sqft != null && !Number.isNaN(Number(raw.sqft))) p.sqft = Number(raw.sqft);
  if (raw.coats != null && !Number.isNaN(Number(raw.coats))) p.coats = Number(raw.coats);
  return p;
}

function labelProducts(list) {
  if (!list || list.length === 0) return null;
  return list.map(x => PRODUCT_LABELS[x] || x).join(', ');
}
function amountLine(p) {
  if (p.qty_mode === 'quantity' && p.quantity) return p.quantity;
  if (p.qty_mode === 'sqft') {
    const parts = [];
    if (p.sqft) parts.push(`${p.sqft} sq ft`);
    if (p.coats) parts.push(`${p.coats} coats`);
    if (parts.length) return parts.join(', ');
  }
  if (p.qty_mode === 'help') return 'Needs help calculating';
  return null;
}
function primerLine(p) {
  if (p.primer === 'yes') return 'Yes, needs primer';
  if (p.primer === 'no') return 'Has primer already';
  if (p.primer === 'unsure') return 'Advise on primer';
  return null;
}
function orderLine(p) {
  if (p.purpose === 'new') {
    if (p.has_order === 'yes') {
      return p.order_number ? `Has order #${p.order_number}` : 'Has order (no number, look up by name/email)';
    }
    if (p.has_order === 'no') {
      return p.returning === 'yes'
        ? 'Needs invoice (existing customer)'
        : 'Needs invoice (first order, address below)';
    }
  }
  return null;
}
function sampleLine(p) {
  if (p.purpose !== 'new') return null;
  const types = (p.sample_types || []).slice();
  const hasOther = types.some(t => t.toLowerCase() === 'other');
  const nonOther = types.filter(t => t.toLowerCase() !== 'other');
  const parts = [];
  if (nonOther.length) parts.push(nonOther.join(', '));
  if (hasOther && p.sample_other) parts.push(`Other: ${p.sample_other}`);
  else if (hasOther) parts.push('Other');
  let line = parts.join(', ');
  if (p.paint_reference) line = line ? `${line} — ref: ${p.paint_reference}` : `Ref: ${p.paint_reference}`;
  return line || null;
}
function addressBlock(p) {
  if (p.purpose !== 'new' || p.has_order !== 'no' || p.returning !== 'no') return null;
  const line1 = [p.address1, p.address2].filter(Boolean).join(' ');
  const line2 = [p.city, p.state, p.zip].filter(Boolean).join(', ').replace(/,\s*$/, '');
  const name = `${p.first_name} ${p.last_name}`.trim();
  return [name, line1, line2].filter(Boolean).join('\n');
}

// ─── Slack ticket helpers ─────────────────────────────────────────────────────

function actionLineForSlack(p) {
  if (p.purpose === 'reorder') {
    return p.previous_code
      ? `*REORDER*  ·  pull recipe *${p.previous_code}*`
      : `*REORDER*  ·  no code given, look up by email`;
  }
  if (p.has_order === 'yes') {
    return p.order_number
      ? `*HAS ORDER #${p.order_number}*`
      : `*HAS ORDER*  ·  no number, look up by name/email`;
  }
  if (p.has_order === 'no') {
    return p.returning === 'yes'
      ? `*SEND INVOICE*  ·  existing customer`
      : `*SEND INVOICE*  ·  first order, ship-to below`;
  }
  return `*NEW MATCH*`;
}

function actionLinePlain(p) {
  if (p.purpose === 'reorder') {
    return p.previous_code
      ? `REORDER (pull recipe ${p.previous_code})`
      : `REORDER (look up by email)`;
  }
  if (p.has_order === 'yes') {
    return p.order_number
      ? `HAS ORDER #${p.order_number}`
      : `HAS ORDER (look up by name/email)`;
  }
  if (p.has_order === 'no') {
    return p.returning === 'yes'
      ? `SEND INVOICE (existing customer)`
      : `SEND INVOICE (first order, ship-to below)`;
  }
  return `NEW MATCH`;
}

// Amount broken into per-product lines when the customer typed a comma-separated
// list; single-line otherwise (sq-ft mode, help mode).
function amountLines(p) {
  if (p.qty_mode === 'quantity' && p.quantity) {
    return p.quantity.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (p.qty_mode === 'sqft') {
    const parts = [];
    if (p.sqft) parts.push(`${p.sqft} sq ft`);
    if (p.coats) parts.push(`${p.coats} coats`);
    return parts.length ? [parts.join(', ')] : [];
  }
  if (p.qty_mode === 'help') return ['Needs help calculating'];
  return [];
}

// Sample field text WITHOUT paint reference (Paint ref is a separate field).
function sampleFieldValue(p) {
  if (p.purpose !== 'new') return null;
  const types = (p.sample_types || []).slice();
  const hasOther = types.some(t => t.toLowerCase() === 'other');
  const nonOther = types.filter(t => t.toLowerCase() !== 'other');
  const parts = [];
  if (nonOther.length) parts.push(nonOther.join(', '));
  if (hasOther && p.sample_other) parts.push(`Other: ${p.sample_other}`);
  else if (hasOther) parts.push('Other');
  return parts.join(', ') || null;
}

function buildSlackBlocks(code, p) {
  const isNew = p.purpose === 'new';
  const name = `${p.first_name} ${p.last_name}`.trim();
  const blocks = [];

  // 1. Header: FX-1000  ·  Anthony Violante
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${code}  ·  ${name}` },
  });

  // 2. Action line
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: actionLineForSlack(p) },
  });

  // 3. Fields — Products | Amount, Primer | Deadline, Sample | Paint ref.
  //    Values for Products and Amount are bolded (they're what Matthew mixes from).
  const fields = [];
  const prods = labelProducts(p.products);
  if (prods) fields.push({ type: 'mrkdwn', text: `*Products*\n*${prods}*` });
  const amts = amountLines(p);
  if (amts.length) {
    const bolded = amts.map(l => `*${l}*`).join('\n');
    fields.push({ type: 'mrkdwn', text: `*Amount*\n${bolded}` });
  }
  const primer = primerLine(p);
  if (primer) fields.push({ type: 'mrkdwn', text: `*Primer*\n${primer}` });
  if (p.deadline) fields.push({ type: 'mrkdwn', text: `*Deadline*\n${p.deadline}` });
  const sample = sampleFieldValue(p);
  if (sample) fields.push({ type: 'mrkdwn', text: `*Sample*\n${sample}` });
  if (isNew && p.paint_reference) fields.push({ type: 'mrkdwn', text: `*Paint ref*\n${p.paint_reference}` });
  if (fields.length) {
    blocks.push({ type: 'section', fields: fields.slice(0, 10) });
  }

  // 4. Ship-to (first-time customers only)
  const addr = addressBlock(p);
  if (addr) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Ship to*\n${addr}` } });
  }

  // 5. Email/phone (plain) + notes on the next line if given
  const contactLine = p.phone ? `${p.email} · ${p.phone}` : p.email;
  const contactText = p.notes ? `${contactLine}\n${p.notes}` : contactLine;
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: contactText } });

  // 6. Divider
  blocks.push({ type: 'divider' });

  // 7. Context
  const contextText = isNew
    ? `Awaiting sample. Save the recipe as *${code}* when it's matched.`
    : (p.previous_code
        ? `No sample needed. Pull *${p.previous_code}*, mix, invoice.`
        : `No sample needed. Look up recipe by email, then mix, invoice.`);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] });

  // Fallback text: single-line notification-friendly summary
  const fallback = `${code} · ${name} · ${actionLinePlain(p)}`;
  return { text: fallback, blocks };
}

function buildSummaryLines(p) {
  const isNew = p.purpose === 'new';
  const lines = [];
  lines.push(`Type: ${isNew ? 'New color match' : 'Reorder'}`);
  const ol = orderLine(p); if (ol) lines.push(`Order: ${ol}`);
  const prods = labelProducts(p.products);
  if (prods) lines.push(`Products: ${prods}`);
  else if (isNew && p.qty_mode) lines.push('Products: Not sure — wants recommendation');
  const amt = amountLine(p); if (amt) lines.push(`Amount: ${amt}`);
  const pr = primerLine(p); if (pr) lines.push(`Primer: ${pr}`);
  if (p.deadline) lines.push(`Deadline: ${p.deadline}`);
  const sl = sampleLine(p); if (isNew && sl) lines.push(`Sample: ${sl}`);
  if (!isNew && p.previous_code) lines.push(`Previous formula: ${p.previous_code}`);
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  return lines;
}

function buildEmailHtml(code, p) {
  const isNew = p.purpose === 'new';
  const warehouse = (process.env.WAREHOUSE_ADDRESS || '').replace(/\\n/g, '\n');
  const summaryHtml = buildSummaryLines(p)
    .map(l => `<li style="margin:4px 0;">${escapeHtml(l)}</li>`)
    .join('');

  const bodyIntroNew = `
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#111;">
      <strong>Important:</strong> write this number on the back of your physical sample before you mail it.
      Without it we can't connect your sample to your request, and your match will be delayed.
    </p>
    ${warehouse ? `
      <p style="margin:16px 0 6px;font-size:15px;color:#111;">Ship your sample to:</p>
      <pre style="margin:0;padding:12px;background:#f6f4ee;border-left:4px solid ${GOLD};font-family:inherit;font-size:15px;line-height:1.4;color:#111;white-space:pre-wrap;">${escapeHtml(warehouse)}</pre>
    ` : ''}
    <p style="margin:16px 0 0;font-size:15px;line-height:1.5;color:#111;">
      Keep this number. Once your color is matched, it's the number you'll use to reorder anytime without sending another sample.
    </p>
  `;

  const bodyIntroReorder = `
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#111;">
      We've got your reorder request. We'll pull up your custom formula and email you an invoice shortly. Nothing to mail this time.
    </p>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#111;">
      Reference: <strong>${escapeHtml(code)}</strong>
    </p>
  `;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f2ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#111;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f2ec;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:6px;overflow:hidden;">
        <tr><td style="background:${NAVY};padding:20px 24px;text-align:center;color:#fff;">
          <div style="font-size:14px;letter-spacing:2px;text-transform:uppercase;color:${GOLD};">Firmolux</div>
          <div style="margin-top:4px;font-size:16px;color:#fff;">Your custom formula number</div>
        </td></tr>
        <tr><td align="center" style="padding:28px 24px 8px;">
          <div style="display:inline-block;padding:14px 24px;border:2px solid ${NAVY};border-radius:4px;font-size:42px;line-height:1;font-weight:700;letter-spacing:3px;color:${NAVY};">${escapeHtml(code)}</div>
        </td></tr>
        <tr><td style="padding:20px 24px 4px;">
          ${isNew ? bodyIntroNew : bodyIntroReorder}
        </td></tr>
        <tr><td style="padding:16px 24px 4px;">
          <p style="margin:0 0 6px;font-size:14px;color:#555;">Here's what you told us:</p>
          <ul style="margin:0;padding-left:20px;font-size:14px;color:#111;">${summaryHtml}</ul>
        </td></tr>
        <tr><td style="padding:16px 24px 24px;">
          <p style="margin:0;font-size:14px;color:#555;">Questions? Just reply to this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildEmailText(code, p) {
  const isNew = p.purpose === 'new';
  const warehouse = (process.env.WAREHOUSE_ADDRESS || '').replace(/\\n/g, '\n');
  const summary = buildSummaryLines(p).map(l => `- ${l}`).join('\n');
  if (isNew) {
    return [
      `Your custom formula number`,
      ``,
      code,
      ``,
      `Important: write this number on the back of your physical sample before you mail it. Without it we can't connect your sample to your request, and your match will be delayed.`,
      ``,
      warehouse ? `Ship your sample to:\n${warehouse}` : '',
      ``,
      `Keep this number. Once your color is matched, it's the number you'll use to reorder anytime without sending another sample.`,
      ``,
      `Here's what you told us:`,
      summary,
      ``,
      `Questions? Reply to this email.`,
    ].filter(Boolean).join('\n');
  }
  return [
    `We've got your reorder request. We'll pull up your custom formula and email you an invoice shortly. Nothing to mail this time.`,
    ``,
    `Reference: ${code}`,
    summary,
    ``,
    `Questions? Reply to this email.`,
  ].join('\n');
}

function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.COLOR_MATCH_FROM);
}

async function sendCustomerEmail(code, p) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.COLOR_MATCH_FROM;
  const resend = new Resend(apiKey);
  const isNew = p.purpose === 'new';
  const subject = isNew
    ? `Your Firmolux custom formula number: ${code}`
    : `Firmolux reorder received: ${code}`;
  const html = buildEmailHtml(code, p);
  const text = buildEmailText(code, p);
  const payload = {
    from,
    to: [p.email],
    subject,
    html,
    text,
  };
  const replyTo = process.env.COLOR_MATCH_REPLY_TO;
  if (replyTo) payload.reply_to = replyTo;
  try {
    const result = await resend.emails.send(payload);
    if (result?.error) return { ok: false, error: result.error.message || String(result.error) };
    return { ok: true, id: result?.data?.id || null };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function mountColorMatchRoutes(app, pool) {
  app.get('/color-match', (req, res) => {
    try {
      res.type('html').send(getPageHtml());
    } catch (err) {
      console.error('color-match: failed to serve page:', err.message);
      res.status(500).send('Internal error');
    }
  });

  app.post('/api/color-match', async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimitCheck(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
    }

    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Request too large.' });
    }

    const raw = req.body;
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ error: 'Invalid request body.' });
    }

    const p = sanitizePayload(raw);
    if (p.purpose !== 'new' && p.purpose !== 'reorder') {
      return res.status(400).json({ error: 'Invalid purpose.' });
    }
    if (!p.first_name || !p.last_name) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (!p.email || !EMAIL_RE.test(p.email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    let row;
    try {
      const { rows } = await pool.query(
        `INSERT INTO color_match_requests (purpose, first_name, last_name, email, payload)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code`,
        [p.purpose, p.first_name, p.last_name, p.email, JSON.stringify(p)]
      );
      row = rows[0];
    } catch (err) {
      console.error('color-match: DB insert failed:', err.message);
      return res.status(500).json({ error: 'Could not save request. Please try again.' });
    }

    const code = row.code;

    // Slack + email are best-effort. Spec: on failure, still return 200 with the
    // code — the customer must always get their number. Log and move on.
    const botToken = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.COLOR_MATCH_SLACK_CHANNEL || '#color-matches';
    let slackTs = null;
    try {
      const msg = buildSlackBlocks(code, p);
      const result = await postSlackBotMessage(botToken, channel, msg);
      if (result?.ok && result.ts) {
        slackTs = result.ts;
        try {
          await pool.query('UPDATE color_match_requests SET slack_ts = $1 WHERE id = $2', [slackTs, row.id]);
        } catch (err) {
          console.error(`color-match: failed to store slack_ts for ${code}:`, err.message);
        }
      } else {
        console.error(`color-match: Slack post failed for ${code}:`, result?.error || 'unknown');
      }
    } catch (err) {
      console.error(`color-match: Slack post threw for ${code}:`, err.message);
    }

    // Email is optional. When RESEND_API_KEY / COLOR_MATCH_FROM aren't set,
    // skip silently — the number is already stored and posted to Slack; the
    // customer can screenshot the confirmation page (per the new ticket copy).
    if (emailConfigured()) {
      try {
        const emailResult = await sendCustomerEmail(code, p);
        if (emailResult.ok) {
          try {
            await pool.query('UPDATE color_match_requests SET email_sent = true WHERE id = $1', [row.id]);
          } catch (err) {
            console.error(`color-match: failed to flip email_sent for ${code}:`, err.message);
          }
        } else {
          console.error(`color-match: email send failed for ${code}: ${emailResult.error}`);
        }
      } catch (err) {
        console.error(`color-match: email send threw for ${code}:`, err.message);
      }
    }

    res.json({ code });
  });
}

module.exports = {
  initColorMatchSchema,
  mountColorMatchRoutes,
};
