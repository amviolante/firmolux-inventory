# Firmolux Inventory — Local Development Setup

## What You Need

- Node.js 18+ (nodejs.org)
- PostgreSQL 12+ (postgresql.org) — OR use remote Railway database
- Git (for version control)

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Create .env File

Create `.env` in project root:

```
DATABASE_URL=postgresql://user:password@host:5432/db
ADMIN_PASSWORD=yourpassword
SHIPSTATION_API_KEY=key
SHIPSTATION_API_SECRET=secret
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

Get DATABASE_URL from Railway Variables page.

### 3. Run Locally
```bash
npm start
```

Visit: http://localhost:8080

## Making Changes

- **API logic**: Edit `src/server.js`
- **SKU parsing**: Edit `src/sku-parser.js`
- **Dashboard UI**: Edit `public/dashboard.html`

Restart `npm start` to see changes.

## Pushing to Railway

```bash
git add .
git commit -m "description"
git push
```

Railway auto-deploys.

## File Structure

```
├── src/
│   ├── server.js        (main app)
│   ├── sku-parser.js    (SKU logic)
│   └── slack.js         (alerts)
├── public/
│   ├── dashboard.html   (UI)
│   └── login.html       (login page)
├── package.json         (dependencies)
├── .env                 (config - create this)
└── LOCAL_SETUP.md       (this file)
```

## Environment Variables

| Variable | Purpose |
|---|---|
| DATABASE_URL | PostgreSQL connection |
| ADMIN_PASSWORD | Dashboard login |
| SHIPSTATION_API_KEY | ShipStation auth |
| SHIPSTATION_API_SECRET | ShipStation auth |
| SLACK_WEBHOOK_URL | Alert notifications |

Copy DATABASE_URL from Railway → firmolux-inventory → Variables.

## Quick Commands

```bash
# Start app
npm start

# Test SKU parser
node -e "const {parseSKU} = require('./src/sku-parser'); console.log(parseSKU('GL04'))"

# Check syntax
node -c src/server.js
```

## Recommendation

Use the **remote Railway database** (DATABASE_URL from Railway) so you see real inventory data while testing locally.

