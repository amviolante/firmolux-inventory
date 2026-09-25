// Daily reconcile at 6:00 America/New_York, plus the Slack post. A plain
// timer re-armed after each run; no dependency. Two instances running at
// once are safe (per-shipment locks), just redundant.
const { runReconcile, parseStart } = require('./reconcile');
const { sendReconcileSummary } = require('./slack');
const { nextRunAt } = require('./time');

const RUN_AT = { hour: 6, tz: 'America/New_York' };

// One reconcile + Slack post. Never throws.
async function reconcileAndPost(pool, { days = 7, now = new Date(), run = runReconcile, send = sendReconcileSummary } = {}) {
  let start;
  try {
    start = parseStart(process.env.RECONCILE_START);
  } catch (err) {
    console.error('Reconcile skipped:', err.message);
    return null;
  }
  if (!start) {
    console.log('Reconcile skipped: RECONCILE_START is not set');
    return null;
  }
  let summary;
  try {
    summary = await run(pool, { days, start, now });
  } catch (err) {
    console.error('Reconcile failed:', err);
    summary = {
      ranAt: now.toISOString(), days, dryRun: false, units: {},
      reconciled: [], reversed: [], unparsed: [], zeroItems: [], review: [],
      errors: [{ brand: 'all brands', error: err.message }],
      totals: { deducted: {}, reversed: {} }, orderCount: 0,
    };
  }
  try {
    await send(process.env.SLACK_WEBHOOK_URL, summary);
  } catch (err) {
    console.error('Reconcile Slack post failed:', err.message);
  }
  return summary;
}

function startDailyReconcile(pool) {
  let running = false;
  const arm = () => {
    const at = nextRunAt(new Date(), RUN_AT);
    console.log(`Next reconcile: ${at.toISOString()}`);
    setTimeout(async () => {
      if (!running) {
        running = true;
        try { await reconcileAndPost(pool); } finally { running = false; }
      }
      arm();
    }, at.getTime() - Date.now());
  };
  arm();
}

module.exports = { reconcileAndPost, startDailyReconcile, RUN_AT };
