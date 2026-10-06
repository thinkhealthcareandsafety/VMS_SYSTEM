const crypto = require('node:crypto');
const config = require('../config');
const { Counter, Audit } = require('../models');
const { publish } = require('./events');

// Site-local calendar day (YYYY-MM-DD). Drives the daily pass reset.
function siteDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Atomic daily pass number: 1, 2, 3... per site day. New day = new counter = starts at 1.
async function nextDailyNumber(date = new Date()) {
  const day = siteDay(date);
  const c = await Counter.findByIdAndUpdate(`pass:${day}`, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return { day, number: c.seq };
}

async function nextVisitorRef() {
  const c = await Counter.findByIdAndUpdate('visitor', { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `V-${String(c.seq).padStart(6, '0')}`;
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

// One password rule for sign-up, reset and change. Long beats clever; no composition rules.
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters';
  if (pw.length > 200) return 'Use at most 200 characters';
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password\d*|qwertyuiop)$/i.test(pw)) return 'That password is too easy to guess';
  return null;
}

module.exports = { siteDay, nextDailyNumber, nextVisitorRef, audit, sha256, normalizeMobile, cleanText, tidyName, decodeJpeg, passwordProblem };
