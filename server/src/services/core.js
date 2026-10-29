const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { Counter, Audit } = require('../models');
const { publish } = require('./events');

// Site-local calendar day (YYYY-MM-DD). Drives the daily pass reset.
function siteDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// The next number from a counter. A counter can fall behind the records (data moved from another server, a partial
// restore); then every new entry would collide and fail. So a number already in use makes the counter jump past the
// highest one in use, and the next one is taken instead.
async function nextSeq(id, { taken, highest }) {
  for (let tries = 0; tries < 3; tries += 1) {
    const { seq } = await Counter.findByIdAndUpdate(id, { $inc: { seq: 1 } }, { upsert: true, new: true });
    if (!(await taken(seq))) return seq;
    await Counter.updateOne({ _id: id }, { $max: { seq: await highest() } });
  }
  throw new Error(`No free number for counter ${id}`);
}
// The number at the end of the highest code in use, e.g. "V-000123" -> 123.
async function lastNumber(model, field, filter = {}) {
  const doc = await model.findOne({ ...filter, [field]: { $exists: true } }, field).sort({ [field]: -1 }).lean();
  return Number(String(doc?.[field] ?? 0).replace(/\D/g, '')) || 0;
}

// Atomic daily pass number: 1, 2, 3... per site day. New day = new counter = starts at 1.
async function nextDailyNumber(date = new Date()) {
  const { Visit } = require('../models');
  const day = siteDay(date);
  const number = await nextSeq(`pass:${day}`, {
    taken: (n) => Visit.exists({ dailyDay: day, dailyNumber: n }),
    highest: () => lastNumber(Visit, 'dailyNumber', { dailyDay: day }),
  });
  return { day, number };
}

async function nextVisitorRef() {
  const { Visit } = require('../models');
  const ref = (n) => `V-${String(n).padStart(6, '0')}`;
  return ref(await nextSeq('visitor', { taken: (n) => Visit.exists({ ref: ref(n) }), highest: () => lastNumber(Visit, 'ref') }));
}

// Append-only audit entry. Never throws into the request path.
function audit(actor, action, { entity, entityId, details, ip } = {}) {
  Audit.create({
    actor: actor?.username || actor?.label || 'system',
    actorRole: actor?.role,
    action,
    entity,
    entityId: entityId ? String(entityId) : undefined,
    details,
    ip,
  }).catch((err) => console.error('audit write failed', action, err.message));
  publish(action, { visitId: entity === 'Visit' && entityId ? String(entityId) : undefined });
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Mobile normaliser: accepts 10-digit local numbers or +country numbers.
// Indian mobiles always start with 6-9; anything else is a typo or a landline that cannot get SMS.
function normalizeMobile(raw) {
  let n = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^0\d{10}$/.test(n)) n = n.slice(1); // trunk prefix: 09876543210
  if (/^\d{10}$/.test(n)) n = config.defaultCountryCode + n;
  if (!/^\+\d{8,15}$/.test(n)) return null;
  if (n.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(n)) return null;
  return n;
}

const cleanText = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// "ravi kumar" -> "Ravi Kumar". Only touches all-lowercase input, so "McDonald" or "de Souza" typed carefully stay as typed.
const tidyName = (s) => (s && s === s.toLowerCase() ? s.replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase()) : s);

// Only JPEG data URLs are accepted; checks the JPEG magic bytes.
function decodeJpeg(dataUrl, maxBytes) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > maxBytes) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}

// A photo or ID image written all the way to the disk before the visit that points to it is saved: without this the
// system can hold it in memory for a few seconds, and a power cut then leaves a record with an empty photo.
async function writeDurable(file, buf, mode = 0o644) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(file, 'wx', mode);
  try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
  // The file's name in its folder, too (Linux; Windows cannot open a folder this way and needs no such step).
  try { const dir = await fsp.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch { /* not supported here */ }
}

// One password rule for sign-up, reset and change. Long beats clever; no composition rules.
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters';
  if (pw.length > 200) return 'Use at most 200 characters';
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password\d*|qwertyuiop)$/i.test(pw)) return 'That password is too easy to guess';
  return null;
}

// Runs the work for one key (a mobile number, an AWB) one at a time, so a double tap or two gates at once cannot
// make the same entry twice. The system runs as one process on the site PC, so a lock in memory is enough.
const queues = new Map();
function oneAtATime(key, work) {
  const run = (queues.get(key) || Promise.resolve()).then(work, work);
  const settled = run.then(() => {}, () => {});
  queues.set(key, settled);
  settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return run;
}

module.exports = { writeDurable, nextSeq, lastNumber, oneAtATime, siteDay, nextDailyNumber, nextVisitorRef, audit, sha256, normalizeMobile, cleanText, tidyName, decodeJpeg, passwordProblem };
