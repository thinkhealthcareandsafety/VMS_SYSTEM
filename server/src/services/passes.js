const config = require('../config');
const { Gate, User } = require('../models');
const settings = require('./settings');
const { siteDay } = require('./core');

// ---------- Pass validity ----------
// The guard picks how long a pass lasts; the clock starts when the visitor is let in. Hours run from that
// moment; days run to the end of the last day at the site (10 days on the 13th = until the 22nd, 11:59 pm).
const VALIDITY = {
  '2h': { label: '2 hours', hours: 2 },
  '4h': { label: '4 hours', hours: 4 },
  '8h': { label: '8 hours', hours: 8 },
  today: { label: 'Today', days: 1 },
  '3d': { label: '3 days', days: 3 },
  '7d': { label: '7 days', days: 7 },
  '10d': { label: '10 days', days: 10 },
  '20d': { label: '20 days', days: 20 },
  '30d': { label: '30 days', days: 30 },
};
const DEFAULT_VALIDITY = '8h';
const MAX_DAYS = 90; // the furthest date a pass can be issued until
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Milliseconds the site's clock is ahead of UTC at `date`.
function tzOffset(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
const addDays = (ymd, n) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
// 11:59:59 pm on that day at the site, as an instant.
function endOfSiteDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  return new Date(wall - tzOffset(new Date(wall)));
}

// What the guard sent -> a stored validity ('8h', '10d', 'date:2026-10-30'), or an error message.
// Nothing sent (older screens) means the default.
function parseValidity(b, now = new Date()) {
  const v = b?.validity;
  if (v === undefined || v === null || v === '') return { validity: DEFAULT_VALIDITY };
  if (VALIDITY[v]) return { validity: v };
  if (v === 'date') {
    const day = String(b.validUntilDay || '');
    const today = siteDay(now);
    if (!DAY_RE.test(day) || day < today || day > addDays(today, MAX_DAYS)) {
      return { error: `Pick a date from today up to ${MAX_DAYS} days ahead` };
    }
    return { validity: `date:${day}` };
  }
  return { error: 'Choose how long the pass is valid' };
}

function validUntil(validity, from = new Date()) {
  const v = validity || DEFAULT_VALIDITY;
  if (v.startsWith('date:')) return endOfSiteDay(v.slice(5));
  const rule = VALIDITY[v] || VALIDITY[DEFAULT_VALIDITY];
  if (rule.hours) return new Date(from.getTime() + rule.hours * 3600e3);
  return endOfSiteDay(addDays(siteDay(from), rule.days - 1));
}

const shortDay = (ymd) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));
function validityLabel(validity) {
  const v = validity || DEFAULT_VALIDITY;
  if (v.startsWith('date:')) return `Until ${shortDay(v.slice(5))}`;
  return VALIDITY[v]?.label || VALIDITY[DEFAULT_VALIDITY].label;
}

// A multi-day pass (2 days or more, or until a later date) stays open when the holder leaves, so they can come
// back on it. Hour and same-day passes close at exit, even when the hours run past midnight.
function staysOpen(validity, until, now = new Date()) {
  if (!until || new Date(until) <= now) return false;
  const v = validity || DEFAULT_VALIDITY;
  if (v.startsWith('date:')) return v.slice(5) > siteDay(now);
  return (VALIDITY[v]?.days || 0) >= 2;
}

// ---------- Gates ----------
// A site always has at least one gate. The first one is made from the old single "gate name" setting.
async function ensureDefaultGate() {
  if (await Gate.exists({})) return;
  await Gate.create({ name: (await settings.get()).gateName || 'Main gate' });
}

// The gate this person works at: the one assigned to them, else the site's first active gate.
async function gateOf(userId) {
  const user = userId ? await User.findById(userId, 'gate').populate('gate', 'name active').lean() : null;
  if (user?.gate?.active) return { id: user.gate._id, name: user.gate.name };
  const first = await Gate.findOne({ active: true }).sort({ createdAt: 1 }).lean();
  if (first) return { id: first._id, name: first.name };
  return { id: null, name: (await settings.get()).gateName || 'Main gate' };
}

// One entry or exit, with the gate and the person as they were named at that moment.
const movement = (kind, gate, by, at = new Date()) => ({
  kind, at, gate: gate?.id || undefined, gateName: gate?.name || '', by: by?.id || undefined, byName: by?.fullName || by?.name || '',
});

// First entry and last exit, for lists and reports.
function entryExit(v) {
  const moves = v.movements || [];
  const firstIn = moves.find((m) => m.kind === 'in');
  const lastOut = [...moves].reverse().find((m) => m.kind === 'out');
  const lastIn = [...moves].reverse().find((m) => m.kind === 'in');
  const pick = (m) => (m ? { gate: m.gateName || '', by: m.byName || '', at: m.at } : null);
  return { entry: pick(firstIn), exit: pick(lastOut), lastIn: pick(lastIn), entries: moves.filter((m) => m.kind === 'in').length };
}

module.exports = {
  VALIDITY, DEFAULT_VALIDITY, MAX_DAYS, parseValidity, validUntil, validityLabel, staysOpen, endOfSiteDay, addDays,
  ensureDefaultGate, gateOf, movement, entryExit,
};
