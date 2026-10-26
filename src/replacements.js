// Labels printed with no line items (owner decision 2026-10-26, option b).
//
//   - created < 24h after the order's first label with items → an extra box
//     of the same shipment: deducts nothing, no alert, logged once;
//   - created ≥ 24h after it → a replacement: deducts a copy of the order's
//     items, once (keyed on this label's shipmentId like every deduction);
//   - no earlier label with items → flagged for a human (Slack), as before.
//
// Only GETs to ShipStation; throws on an API error so the caller can leave
// the shipment unprocessed and the morning reconcile retries it.
const { zonedToUtc, SHIPSTATION_TZ } = require('./time');

const REPLACEMENT_AFTER_HOURS = 24;

async function classifyZeroItemShipment(ss, shipment) {
  if ((shipment.items || []).length > 0) return { kind: 'items' };
  if (!shipment.orderId) return { kind: 'first-label' };
  const created = zonedToUtc(shipment.createDate, SHIPSTATION_TZ);
  const { shipments = [] } = await ss.get('/shipments', { orderId: shipment.orderId, includeShipmentItems: true });
  const earlier = shipments
    .filter(s => !s.voided && String(s.shipmentId) !== String(shipment.shipmentId) && (s.shipmentItems || []).length > 0)
    .map(s => ({ s, at: zonedToUtc(s.createDate, SHIPSTATION_TZ) }))
    .filter(x => x.at && (!created || x.at < created))
    .sort((a, b) => a.at - b.at);
  if (earlier.length === 0 || !created) return { kind: 'first-label' };
  const first = earlier[0];
  const hours = (created - first.at) / 3600000;
  if (hours < REPLACEMENT_AFTER_HOURS) {
    return { kind: 'extra-box', firstShipmentId: String(first.s.shipmentId), hours };
  }
  const order = await ss.get(`/orders/${shipment.orderId}`);
  const items = (order.items || []).filter(i => !i.adjustment);
  return { kind: 'replacement', firstShipmentId: String(first.s.shipmentId), hours, items };
}

module.exports = { classifyZeroItemShipment, REPLACEMENT_AFTER_HOURS };
