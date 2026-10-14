const crypto = require('node:crypto');
const config = require('../config');
const { Parcel, Counter, Outbox, Host } = require('../models');
const { audit, cleanText, normalizeMobile } = require('./core');
const vault = require('./vault');
const telegram = require('./telegram');
const whatsapp = require('./whatsapp');

// Couriers at the gate, after the mailroom practice of chain of custody: every parcel is logged on arrival,
// the recipient is told with a pickup code only they have, reminders follow, and every handover names the
// person, the guard and the gate.
const CARRIERS = ['Blue Dart', 'Delhivery', 'DTDC', 'India Post', 'Amazon', 'Ekart (Flipkart)', 'XpressBees', 'Shadowfax', 'Ecom Express',
  'Professional Couriers', 'Shree Maruti', 'Trackon', 'Gati', 'FedEx', 'DHL', 'UPS', 'Aramex', 'By hand', 'Other'];
const TYPES = ['document', 'parcel', 'large', 'perishable', 'confidential'];
const TYPE_LABEL = { document: 'Document', parcel: 'Parcel', large: 'Large item', perishable: 'Perishable', confidential: 'Confidential' };
const STATUS_LABEL = { received: 'Waiting for pickup', collected: 'Collected', forwarded: 'Handed to department', returned: 'Returned to courier', booked: 'To be dispatched', dispatched: 'Dispatched', void: 'Entered by mistake' };
const MAX_TRIES = 5;                       // wrong pickup codes before only an override works
const REMIND_AFTER_HOURS = [24, 72];       // reminders while it waits
const AGING_DAYS = 3;                      // flagged as waiting too long

async function nextNumber() {
  const c = await Counter.findByIdAndUpdate('parcel', { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `PCL-${String(c.seq).padStart(6, '0')}`;
}

// 4 digits, never starting with 0 (read out over a counter, a leading zero gets lost).
const newCode = () => String(1000 + crypto.randomInt(0, 9000));
const sealCode = (code) => vault.seal(Buffer.from(code)).toString('base64');
const openCode = (sealed) => vault.open(Buffer.from(sealed, 'base64')).toString();

function readParcel(b, direction) {
  const carrier = cleanText(b.carrier, 40);
  const awb = cleanText(b.awb, 40).replace(/\s+/g, '').toUpperCase();
  const pieces = Number(b.pieces ?? 1);
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > 500) return { error: 'Pieces must be a whole number from 1' };
  const type = TYPES.includes(b.type) ? b.type : 'parcel';
  const person = { name: cleanText(b.person?.name, 80), room: cleanText(b.person?.room, 30), mobile: b.person?.mobile ? normalizeMobile(b.person.mobile) : undefined };
  if (b.person?.mobile && !person.mobile) return { error: 'The mobile number is not valid' };
  const out = {
    direction, carrier, awb, pieces, type, person,
    sender: { name: cleanText(b.sender?.name, 80), company: cleanText(b.sender?.company, 100) },
    department: cleanText(b.department, 60), address: cleanText(b.address, 300), note: cleanText(b.note, 300),
  };
  if (direction === 'in' && !carrier) return { error: 'Which courier brought it?' };
  if (direction === 'out' && !out.address && !out.person.name) return { error: 'Where is it going? Enter the name and address' };
  return { parcel: out };
}

const forWhom = (p, host) => (host ? host.fullName : p.person?.name) || 'the recipient';
const fmtTime = (d) => new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// The notice with the pickup code, by WhatsApp (when set up) or Telegram (when the host connected it).
// Returns how it went, or null when the recipient cannot be reached (the guard calls them instead).
async function notify(p, host, { reminder = false } = {}) {
  if (!host || !p.codeSealed) return null;
  const code = openCode(p.codeSealed);
  const what = `${p.pieces > 1 ? `${p.pieces} pieces` : TYPE_LABEL[p.type].toLowerCase()} from ${[p.sender?.company, p.sender?.name].filter(Boolean).join(', ') || p.carrier}`;
  const text = reminder
    ? `📦 Reminder: a ${what} is still waiting for you at security (since ${fmtTime(p.createdAt)}).\nCourier: ${p.carrier}${p.awb ? `, AWB ${p.awb}` : ''}\n\nPickup code: ${code}\nWhoever collects it must give this code.`
    : `📦 A ${what} has arrived for you at security.\nCourier: ${p.carrier}${p.awb ? `, AWB ${p.awb}` : ''} · ${p.number}\n\nPickup code: ${code}\nWhoever collects it must give this code. Send someone with it if you cannot come.`;
  let via = null;
  if (whatsapp.enabled() && host.mobile && config.approvalChannel !== 'sms') {
    await Outbox.create({ kind: 'whatsapp', parcel: p._id, to: host.mobile, body: text.replace(/Pickup code: (\d+)/, 'Pickup code: *$1*'), vars: { plain: true } });
    via = 'whatsapp';
  } else if (telegram.enabled() && host.telegramChatId) {
    await Outbox.create({ kind: 'telegram', parcel: p._id, to: String(host.telegramChatId), body: text, vars: { plain: true } });
    via = 'telegram';
  }
  if (via) {
    await Parcel.updateOne({ _id: p._id }, reminder
      ? { $inc: { reminders: 1 }, lastReminderAt: new Date() }
      : { notifiedVia: via, notifiedAt: new Date() });
  }
  return via;
}

// A pickup code check. Locks after MAX_TRIES wrong codes; the count is kept atomically, so two desks cannot
// try in parallel beyond the limit.
async function checkCode(p, given) {
  if (!p.codeSealed) return { ok: false, error: 'This parcel has no pickup code. Hand it over by checking the collector’s ID.' };
  if ((p.codeTries || 0) >= MAX_TRIES) return { ok: false, locked: true, error: 'Too many wrong codes. Hand it over only after confirming with the recipient (override with a reason).' };
  const a = Buffer.from(String(given || '').replace(/\D/g, '').padEnd(4, 'x'));
  const b = Buffer.from(openCode(p.codeSealed));
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  const after = await Parcel.findOneAndUpdate({ _id: p._id, codeTries: { $lt: MAX_TRIES } }, { $inc: { codeTries: 1 } }, { new: true });
  const left = Math.max(0, MAX_TRIES - (after?.codeTries ?? MAX_TRIES));
  return { ok: false, locked: left === 0, error: left ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. The parcel is now locked: confirm with the recipient and use an override with a reason.' };
}

// Worker: reminders for parcels still waiting (24 h, then 72 h), only to people we can reach.
async function remind() {
  const now = Date.now();
  const due = await Parcel.find({ direction: 'in', status: 'received', host: { $exists: true }, codeSealed: { $exists: true }, reminders: { $lt: REMIND_AFTER_HOURS.length } }).limit(100).lean();
  for (const p of due) {
    const nextAt = new Date(p.createdAt).getTime() + REMIND_AFTER_HOURS[p.reminders || 0] * 3600e3;
    if (nextAt > now) continue;
    const host = await Host.findOne({ _id: p.host, active: true }).lean();
    if (!host) continue;
    const via = await notify(p, host, { reminder: true });
    if (via) audit({ label: 'system' }, 'parcel.reminded', { entity: 'Parcel', entityId: p._id, details: { number: p.number, via } });
    else await Parcel.updateOne({ _id: p._id }, { $inc: { reminders: 1 } }); // unreachable: do not try every tick
  }
}

const aging = (p, now = Date.now()) => p.direction === 'in' && p.status === 'received' && now - new Date(p.createdAt).getTime() >= AGING_DAYS * 86400e3;

module.exports = { CARRIERS, TYPES, TYPE_LABEL, STATUS_LABEL, MAX_TRIES, AGING_DAYS, nextNumber, newCode, sealCode, openCode, readParcel, notify, checkCode, remind, aging, forWhom };
