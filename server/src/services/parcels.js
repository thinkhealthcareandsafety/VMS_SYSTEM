const crypto = require('node:crypto');
const config = require('../config');
const { Parcel, Counter, Outbox, Host, ActionToken } = require('../models');
const { audit, cleanText, normalizeMobile, sha256 } = require('./core');
const telegram = require('./telegram');
const whatsapp = require('./whatsapp');
const email = require('./email');

// Couriers at the gate, after the mailroom practice of chain of custody: every parcel is logged on arrival with
// photos, the recipient sees them and accepts or declines it with one tap, reminders follow, and every handover
// names the person who took it, their number, a photo, the guard and the gate. The recipient is then told who took it.
const CARRIERS = ['Blue Dart', 'Delhivery', 'DTDC', 'India Post', 'Amazon', 'Ekart (Flipkart)', 'XpressBees', 'Shadowfax', 'Ecom Express',
  'Professional Couriers', 'Shree Maruti', 'Trackon', 'Gati', 'FedEx', 'DHL', 'UPS', 'Aramex', 'By hand', 'Other'];
const TYPES = ['document', 'parcel', 'large', 'perishable', 'confidential'];
const TYPE_LABEL = { document: 'Document', parcel: 'Parcel', large: 'Large item', perishable: 'Perishable', confidential: 'Confidential' };
const STATUS_LABEL = { received: 'Waiting for pickup', collected: 'Collected', forwarded: 'Handed to department', returned: 'Returned to courier', booked: 'To be dispatched', dispatched: 'Dispatched', void: 'Entered by mistake' };
const RESPONSE_LABEL = { accepted: 'Accepted', declined: 'Declined' };
const RESPONSE_DAYS = 7;                   // the Accept / Decline link works this long
const REMIND_AFTER_HOURS = [24, 72];       // reminders while it waits
const AGING_DAYS = 3;                      // flagged as waiting too long
const MAX_PHOTOS = 5;

async function nextNumber() {
  const c = await Counter.findByIdAndUpdate('parcel', { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `PCL-${String(c.seq).padStart(6, '0')}`;
}

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
    department: cleanText(b.department, 60), addressee: cleanText(b.addressee, 80), address: cleanText(b.address, 300), note: cleanText(b.note, 300),
  };
  if (direction === 'in' && !carrier) return { error: 'Which courier brought it?' };
  if (direction === 'out' && !out.addressee) return { error: 'Who is it going to? Enter the name on the courier' };
  if (direction === 'out' && !out.address) return { error: 'Where is it going? Enter the address' };
  return { parcel: out };
}

const forWhom = (p, host) => (host ? host.fullName : p.person?.name) || 'the recipient';
const fmtTime = (d) => new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const whatLine = (p) => `${p.pieces > 1 ? `${p.pieces} pieces` : TYPE_LABEL[p.type].toLowerCase()} from ${[p.sender?.company, p.sender?.name].filter(Boolean).join(', ') || p.carrier}`;

// Asks the recipient whether the parcel is theirs: the photos and Accept / Decline on WhatsApp (when set up) or
// Telegram (when they connected it), and the same link by email. Returns how, or null when they cannot be reached
// (the guard calls them instead). A new request replaces the last one's buttons.
async function requestResponse(p, host, { reminder = false } = {}) {
  if (!host) return null;
  await ActionToken.updateMany({ kind: 'parcel', ref: p._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  const raw = crypto.randomBytes(18).toString('base64url');
  await ActionToken.create({ kind: 'parcel', ref: p._id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + RESPONSE_DAYS * 86400e3) });
  const link = `${config.appBaseUrl}/parcel/${raw}`;
  const photos = p.photos?.length ? `\nPhotos: ${link}` : `\nDetails: ${link}`;
  const head = reminder ? `📦 Reminder: a ${whatLine(p)} is still at security for you (since ${fmtTime(p.createdAt)}).` : `📦 A ${whatLine(p)} has arrived for you at security.`;
  const text = `${head}\nCourier: ${p.carrier}${p.awb ? `, AWB ${p.awb}` : ''} · ${p.number}\n\nIs it yours? Accept it and collect it from security, or Decline if it is not yours.${photos}`;
  let via = null;
  if (whatsapp.enabled() && host.mobile && config.approvalChannel !== 'sms') {
    await Outbox.create({ kind: 'whatsapp', parcel: p._id, to: host.mobile, body: text, vars: { prefix: 'p' } });
    via = 'whatsapp';
  } else if (telegram.enabled() && host.telegramChatId) {
    await Outbox.create({ kind: 'telegram', parcel: p._id, to: String(host.telegramChatId), body: text, vars: { prefix: 'p' } });
    via = 'telegram';
  }
  if (email.enabled() && host.email) {
    const mail = email.approvalEmail({
      headline: reminder ? `Your parcel is still waiting at security (${p.number}).` : `A parcel has arrived for you at security (${p.number}).`,
      rows: [['What', whatLine(p)], ['Courier', p.carrier], ['AWB', p.awb], ['Arrived', fmtTime(p.createdAt)]],
      link, button: 'See it and accept or decline', valid: `${RESPONSE_DAYS} days`, note: 'You will see the photos security took and can accept or decline it.',
    });
    await Outbox.create({ kind: 'email', parcel: p._id, to: host.email, body: mail.text, vars: { subject: `Parcel ${p.number} at security`, html: mail.html } });
    via = via || 'email';
  }
  if (via) {
    await Parcel.updateOne({ _id: p._id }, reminder ? { $inc: { reminders: 1 }, lastReminderAt: new Date() } : { notifiedVia: via, notifiedAt: new Date() });
  }
  return via;
}

// A plain message to the recipient (reminder after accepting, the handover acknowledgment). WhatsApp or Telegram.
async function tell(p, host, text) {
  if (!host) return null;
  if (whatsapp.enabled() && host.mobile && config.approvalChannel !== 'sms') {
    await Outbox.create({ kind: 'whatsapp', parcel: p._id, to: host.mobile, body: text, vars: { plain: true } });
    return 'whatsapp';
  }
  if (telegram.enabled() && host.telegramChatId) {
    await Outbox.create({ kind: 'telegram', parcel: p._id, to: String(host.telegramChatId), body: text, vars: { plain: true } });
    return 'telegram';
  }
  return null;
}

// After the handover: the recipient learns who took it, so a wrong handover is caught the same day.
async function acknowledge(p, host) {
  const h = p.handover;
  const via = await tell(p, host, `📦 Your parcel ${p.number} (${p.carrier}${p.awb ? `, AWB ${p.awb}` : ''}) was handed over to ${h.to}${h.mobile ? ` (${h.mobile})` : ''} at ${fmtTime(h.at)}${h.gateName ? `, ${h.gateName}` : ''}.\n\nIf you did not send this person, call security now.`);
  if (via) await Parcel.updateOne({ _id: p._id }, { ackSentAt: new Date() });
  return via;
}

async function findByToken(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
  const token = await ActionToken.findOne({ kind: 'parcel', tokenHash: sha256(raw) }).lean();
  if (!token) return null;
  const p = await Parcel.findById(token.ref).populate('host').lean();
  return p ? { token, p } : null;
}

// Where a recipient's link stands: pending (can still answer), accepted / declined, superseded, expired, or the parcel's own status.
function tokenState(token, p) {
  if (p.response?.kind) return p.response.kind;
  if (p.status !== 'received') return p.status;
  if (token.usedAt) return 'superseded';
  if (token.expiresAt < new Date()) return 'expired';
  return 'pending';
}

// The recipient's one answer, from WhatsApp, Telegram or the link.
async function respondByToken(raw, decision, { via = 'link', ip } = {}) {
  const kind = { accept: 'accepted', decline: 'declined' }[decision];
  if (!kind) return { status: 400, body: { error: 'Answer must be accept or decline' } };
  const found = await findByToken(raw);
  if (!found) return { status: 404, body: { error: 'This link is invalid' } };
  const { token, p } = found;
  const state = tokenState(token, p);
  if (state !== 'pending') {
    const why = {
      accepted: 'You already accepted this parcel.', declined: 'You already declined this parcel.',
      superseded: 'A newer message was sent for this parcel. Use the latest one.', expired: 'This link has expired. Call security.',
    }[state] || `This parcel is already ${(STATUS_LABEL[state] || 'closed').toLowerCase()}.`;
    return { status: 409, body: { error: why, state }, p };
  }
  const by = p.host?.fullName || 'Recipient';
  const done = await Parcel.findOneAndUpdate(
    { _id: p._id, status: 'received', 'response.kind': { $exists: false } },
    { response: { kind, at: new Date(), by, via } },
    { new: true },
  );
  if (!done) return { status: 409, body: { error: 'This parcel has just changed. Call security.', state: 'closed' }, p };
  await ActionToken.updateMany({ kind: 'parcel', ref: p._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  audit({ label: `host:${p.host?._id}`, role: 'host' }, `parcel.${kind}`, { entity: 'Parcel', entityId: p._id, details: { number: p.number, via }, ip });
  return { status: 200, body: { ok: true, state: kind }, p: done };
}

// Worker: reminders for parcels still waiting (24 h, then 72 h), only to people we can reach. Not answered yet:
// the request again; accepted but not collected: a plain reminder; declined: none (security returns it).
async function remind() {
  const now = Date.now();
  const due = await Parcel.find({ direction: 'in', status: 'received', host: { $exists: true }, 'response.kind': { $ne: 'declined' }, reminders: { $lt: REMIND_AFTER_HOURS.length } }).limit(100).lean();
  for (const p of due) {
    const nextAt = new Date(p.createdAt).getTime() + REMIND_AFTER_HOURS[p.reminders || 0] * 3600e3;
    if (nextAt > now) continue;
    const host = await Host.findOne({ _id: p.host, active: true }).lean();
    const via = !host ? null : p.response?.kind === 'accepted'
      ? await tell(p, host, `📦 Reminder: your parcel ${p.number} (${p.carrier}${p.awb ? `, AWB ${p.awb}` : ''}) is still at security, since ${fmtTime(p.createdAt)}. Please collect it.`)
      : await requestResponse(p, host, { reminder: true });
    if (via) {
      if (p.response?.kind === 'accepted') await Parcel.updateOne({ _id: p._id }, { $inc: { reminders: 1 }, lastReminderAt: new Date() });
      audit({ label: 'system' }, 'parcel.reminded', { entity: 'Parcel', entityId: p._id, details: { number: p.number, via } });
    } else await Parcel.updateOne({ _id: p._id }, { $inc: { reminders: 1 } }); // unreachable: do not try every tick
  }
}

const aging = (p, now = Date.now()) => p.direction === 'in' && p.status === 'received' && now - new Date(p.createdAt).getTime() >= AGING_DAYS * 86400e3;

module.exports = {
  CARRIERS, TYPES, TYPE_LABEL, STATUS_LABEL, RESPONSE_LABEL, AGING_DAYS, MAX_PHOTOS, nextNumber, readParcel, requestResponse, tell, acknowledge,
  findByToken, tokenState, respondByToken, remind, aging, forWhom, fmtTime,
};
