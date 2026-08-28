const https = require('https');
const http = require('http');

async function sendSlackAlert(webhookUrl, product, currentQty, bucketsRemaining, reorderBuckets) {
  if (!webhookUrl) return;

  const unit = product.unit;
  const qty = parseFloat(currentQty) || 0;
  const buckets = parseFloat(bucketsRemaining) || 0;
  const bucketWord = buckets === 1 ? 'bucket' : 'buckets';
  const emoji = buckets <= 1 ? '🚨' : '⚠️';

  const message = {
    text: `${emoji} *Low Inventory Alert — Firmolux*`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} Low Inventory: ${product.name}` }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Product:*\n${product.name} (${product.code})` },
          { type: 'mrkdwn', text: `*Remaining:*\n${qty.toFixed(1)} ${unit} — ${buckets.toFixed(1)} ${bucketWord}` },
          { type: 'mrkdwn', text: `*Reorder Threshold:*\n${reorderBuckets} ${bucketWord}` },
          { type: 'mrkdwn', text: `*Action:*\nReorder ${product.name} now` }
        ]
      }
    ]
  };

  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const body = JSON.stringify(message);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postSlack(webhookUrl, message) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const body = JSON.stringify(message);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    // 5s hard cap. A hung socket would otherwise stall the ShipStation webhook
    // past ShipStation's own timeout → retry → double-deduct already-processed
    // items. destroy(err) fires 'error' so the caller's try/catch swallows it.
    req.setTimeout(5000, () => {
      req.destroy(new Error('Slack request timed out after 5000ms'));
    });
    req.write(body);
    req.end();
  });
}

async function sendSkuParseFailureAlert(webhookUrl, { orderNumber, unparseableSkus }) {
  if (!webhookUrl) return;
  const orderLabel = orderNumber || '(unknown)';
  const skuList = (unparseableSkus || []).map(s => `\`${s}\``).join(', ') || '(none)';
  const message = {
    text: `⚠️ Unparseable SKU on order ${orderLabel}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `⚠️ Unparseable SKU on order ${orderLabel}` }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Order:*\n${orderLabel}` },
          { type: 'mrkdwn', text: `*Unparseable SKU(s):*\n${skuList}` },
          { type: 'mrkdwn', text: `*Impact:*\nDeductions for these SKUs were skipped. Adjust inventory manually if needed.` }
        ]
      }
    ]
  };
  return postSlack(webhookUrl, message);
}

async function sendEmptyShipmentAlert(webhookUrl, { orderNumber }) {
  if (!webhookUrl) return;
  const orderLabel = orderNumber || '(unknown)';
  const message = {
    text: `🔎 Empty shipment on order ${orderLabel} — needs human review`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🔎 Empty shipment: Order ${orderLabel}` }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Order:*\n${orderLabel}` },
          { type: 'mrkdwn', text: `*Status:*\nShipment fetched with 0 items.` },
          { type: 'mrkdwn', text: `*Action:*\nHuman review needed — not an error. Check the order in ShipStation for expected contents.` }
        ]
      }
    ]
  };
  return postSlack(webhookUrl, message);
}

module.exports = { sendSlackAlert, sendSkuParseFailureAlert, sendEmptyShipmentAlert };
