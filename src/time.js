// Time-zone helpers without a dependency. ShipStation's v1 API returns
// Pacific wall-clock times with no offset; the reconcile job runs on
// Eastern time.

// Offset (ms) of `tz` from UTC at instant `date`.
function tzOffset(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-09-11T00:43:50.7000000" (wall clock in `tz`) → Date.
function zonedToUtc(naive, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(naive || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let t = guess - tzOffset(new Date(guess), tz);
  t = guess - tzOffset(new Date(t), tz); // settle across a DST edge
  return new Date(t);
}

// "YYYY-MM-DD" of `date` as seen in `tz`.
function dateIn(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Next instant strictly after `now` when the wall clock in `tz` reads hour:00.
function nextRunAt(now, { hour, tz }) {
  const hh = String(hour).padStart(2, '0');
  for (let k = 0; k < 3; k++) {
    const day = dateIn(new Date(now.getTime() + k * 86400000), tz);
    const run = zonedToUtc(`${day}T${hh}:00:00`, tz);
    if (run > now) return run;
  }
  throw new Error('unreachable');
}

const SHIPSTATION_TZ = 'America/Los_Angeles';

module.exports = { tzOffset, zonedToUtc, dateIn, nextRunAt, SHIPSTATION_TZ };
