const https = require('https');
const http = require('http');

async function sendSlackAlert(webhookUrl, product, currentQty, bucketsRemaining, reorderBuckets) {
  if (!webhookUrl) return;

  const unit = product.unit;
  const bucketWord = bucketsRemaining === 1 ? 'bucket' : 'buckets';
  const emoji = bucketsRemaining <= 1 ? '🚨' : '⚠️';

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
          { type: 'mrkdwn', text: `*Remaining:*\n${currentQty.toFixed(1)} ${unit} — ${bucketsRemaining.toFixed(1)} ${bucketWord}` },
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

module.exports = { sendSlackAlert };
