# Firmolux Inventory System — Setup Guide

## What this does
- Automatically deducts inventory when ShipStation marks an order as shipped
- Sends Slack alerts when any product drops below your reorder threshold (in buckets)
- Password-protected dashboard to view stock, set starting inventory, and set per-product thresholds

---

## Step 1: Push to GitHub

1. Create a new private repo at github.com (e.g. `firmolux-inventory`)
2. In Terminal, run:
   ```
   cd firmolux-inventory
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOURUSERNAME/firmolux-inventory.git
   git push -u origin main
   ```

---

## Step 2: Deploy on Railway

1. Go to **railway.app** and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select your `firmolux-inventory` repo
4. Railway will detect Node.js automatically

### Add PostgreSQL database:
1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway will automatically set `DATABASE_URL` in your environment

### Set Environment Variables:
In Railway → your service → **Variables** tab, add:

| Variable | Value |
|----------|-------|
| `SHIPSTATION_API_KEY` | (from ShipStation, see Step 4) |
| `SHIPSTATION_API_SECRET` | (from ShipStation, see Step 4) |
| `SLACK_WEBHOOK_URL` | (from Slack, see Step 3) |
| `ADMIN_PASSWORD` | Choose a strong password |
| `SHIPSTATION_WEBHOOK_SECRET` | Any random string, e.g. `firmolux-secret-123` |

Railway sets `DATABASE_URL` and `PORT` automatically — don't add those manually.

### Initialize the database:
Once deployed, go to Railway → your service → **Shell** tab and run:
```
node src/setup-db.js
```

Your app URL will be something like: `https://firmolux-inventory-production.up.railway.app`

---

## Step 3: Set up Slack

1. Go to **api.slack.com/apps**
2. Click **Create New App → From scratch**
3. Name it `Firmolux Inventory`, select your workspace
4. Go to **Incoming Webhooks** → toggle ON
5. Click **Add New Webhook to Workspace**
6. Choose the Slack channel where you want alerts (e.g. `#inventory-alerts`)
7. Copy the Webhook URL (starts with `https://hooks.slack.com/services/...`)
8. Paste it into Railway as `SLACK_WEBHOOK_URL`

---

## Step 4: Get ShipStation API Credentials

1. In ShipStation, go to **Account Settings** (gear icon top right)
2. Click **API Settings**
3. You'll see your **API Key** and **API Secret** — copy both
4. Add them to Railway as `SHIPSTATION_API_KEY` and `SHIPSTATION_API_SECRET`

---

## Step 5: Set up ShipStation Webhook

1. In ShipStation → **Account Settings** → **Webhooks**
2. Click **Add Webhook**
3. Set:
   - **Event**: `SHIP_NOTIFY` (fires when an order is marked shipped)
   - **URL**: `https://your-railway-url.up.railway.app/webhook/shipstation`
   - **Secret**: The same value you set as `SHIPSTATION_WEBHOOK_SECRET`
4. Save

From this point on, every time you ship an order in ShipStation, the webhook fires automatically, SKUs are parsed, and inventory is updated within seconds.

---

## Step 6: Enter Starting Inventory

1. Open your Railway app URL in a browser
2. Log in with your `ADMIN_PASSWORD`
3. For each product, enter the current number of buckets you have and click **Set**
4. Set reorder thresholds per product (also in buckets) and click **Save**

---

## SKU Reference

| Prefix | Product | Bucket Size |
|--------|---------|------------|
| GL | Grassello | 20kg |
| AP | Antico Paints | 20kg |
| MP | Marmorino Plus | 20kg |
| MSM | Marmorino SM | 20kg |
| MGM | Marmorino GM | 20kg |
| MMB | Marmorino MB | 25kg |
| IP | Intonaco Primo | 25kg |
| IM | Intonaco Medio | 25kg |
| BEE | Beeswax | 5L |
| SAV | Sav | 2kg |
| KRH | Kit (IP 5kg + AP 1kg + BEE 0.5L per unit) | — |

Tint codes after `-` (e.g. `-BM1093`, `-SW7042`) are ignored.

---

## Duplicating for VIOLANTE

When you're ready to set up VIOLANTE:
1. Create a new GitHub repo `violante-inventory`
2. Copy all files from this project
3. In `src/setup-db.js`, update the product list with VIOLANTE's products
4. Deploy as a separate Railway service with its own database
5. Set up a separate ShipStation webhook pointing to the VIOLANTE URL

---

## Troubleshooting

**Webhook not firing?** Check ShipStation webhook logs under Account Settings → Webhooks.

**SKU not recognized?** Check Railway logs for "Unrecognized SKU: XXX" messages. Add the prefix to `KNOWN_PREFIXES` in `src/sku-parser.js`.

**Slack not sending?** Test the webhook URL with:
```
curl -X POST YOUR_SLACK_WEBHOOK_URL -H 'Content-type: application/json' --data '{"text":"Test from Firmolux"}'
```
