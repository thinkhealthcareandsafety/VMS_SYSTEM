const crypto = require('node:crypto');
const config = require('../config');
const { Setting } = require('../models');
const { endOfSiteDay } = require('./passes');

// The site's licence: a key signed by GateSmartX (Ed25519), checked here with no internet. It names the site and
// the last day. 15 days before, admins and guards see a warning; after it, no new entries can be made, but check-outs,
// emergencies, approvals already sent and every record keep working: a gate must never be unsafe because of a bill.
// The private key that signs licences stays with GateSmartX (scripts/license.js issues them).
const PUBLIC_KEY = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA/DS8Z2JmCpxcnjEgde6rCb/wrFpJUX5vRH9OrcNwyqY=
-----END PUBLIC KEY-----`);
const WARN_DAYS = 15;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// "payload.signature", both base64url. Returns { site, until, gates, issued } or null.
function verify(key) {
  const [body, sig] = String(key || '').trim().split('.');
  if (!body || !sig) return null;
  try {
    if (!crypto.verify(null, Buffer.from(body), PUBLIC_KEY, Buffer.from(sig, 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p && DAY_RE.test(p.until) ? p : null;
  } catch { return null; }
}

let cache = null;
let cachedAt = 0;
const forget = () => { cache = null; };

// { required, state: off | ok | warn | expired | missing | clock, site, until, daysLeft }
async function status(now = new Date()) {
  if (!config.licenseRequired) return { required: false, state: 'off' };
  if (cache && Date.now() - cachedAt < 60e3) return cache;
  const doc = await Setting.findById('site', 'license licenseSeenAt').lean();
  const lic = verify(doc?.license);
  let out;
  if (!lic) out = { required: true, state: 'missing' };
  else {
    const ends = endOfSiteDay(lic.until);
    const daysLeft = Math.ceil((ends - now) / 86400e3);
    // The clock was turned back more than a day: treat it as ended, until the clock is right again.
    const seen = doc.licenseSeenAt ? new Date(doc.licenseSeenAt) : null;
    const state = seen && now < new Date(seen.getTime() - 86400e3) ? 'clock' : now > ends ? 'expired' : daysLeft <= WARN_DAYS ? 'warn' : 'ok';
    out = { required: true, state, site: lic.site, until: lic.until, gates: lic.gates || null, daysLeft: Math.max(0, daysLeft) };
  }
  await Setting.updateOne({ _id: 'site' }, { $max: { licenseSeenAt: now } }, { upsert: true });
  cache = out;
  cachedAt = Date.now();
  return out;
}

const usable = (s) => ['off', 'ok', 'warn'].includes(s.state);

// Middleware for anything that makes a new entry (check-in, material, couriers, events, expected visitors).
async function requireLicense(req, res, next) {
  const s = await status();
  if (usable(s)) return next();
  return res.status(402).json({
    code: 'license',
    error: s.state === 'clock'
      ? 'The date on the server is wrong, so new entries are paused. Set the right date and time on the server.'
      : 'The licence for this system has ended, so new entries are paused. Check-outs, emergency messages and all records still work. Ask your admin to enter the new licence key.',
  });
}

async function install(key) {
  const lic = verify(key);
  if (!lic) return { error: 'This licence key is not valid. Copy the whole key exactly as GateSmartX sent it.' };
  await Setting.updateOne({ _id: 'site' }, { $set: { license: String(key).trim() } }, { upsert: true });
  forget();
  return { lic };
}

module.exports = { verify, status, usable, requireLicense, install, forget, WARN_DAYS };
