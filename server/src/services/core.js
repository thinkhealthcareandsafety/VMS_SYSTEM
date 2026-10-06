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

// Mobile normaliser: accepts 10-digit Indian numbers or +country numbers.
function normalizeMobile(raw) {
  let n = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^\d{10}$/.test(n)) n = config.defaultCountryCode + n;
  return /^\+\d{8,15}$/.test(n) ? n : null;
}

const cleanText = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// Only JPEG data URLs are accepted; checks the JPEG magic bytes.
function decodeJpeg(dataUrl, maxBytes) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > maxBytes) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}

module.exports = { siteDay, nextDailyNumber, nextVisitorRef, audit, sha256, normalizeMobile, cleanText, decodeJpeg };
