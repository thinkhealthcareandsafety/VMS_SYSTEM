const crypto = require('node:crypto');
const config = require('../config');
const { Material, ActionToken, Counter, Outbox, Host } = require('../models');
const { siteDay, audit, sha256, cleanText, normalizeMobile } = require('./core');
const telegram = require('./telegram');
const whatsapp = require('./whatsapp');

// Material in and out of the site, after the RGP/NRGP practice of Indian plants and hotels:
//   out: returnable (sent for repair or loan, due back by a date) or non-returnable (scrap, sale, transfer);
//        a head of department approves before the gate lets it out.
//   in:  supplier deliveries, and contractor tools brought in that must leave again.
const UNITS = ['nos', 'pcs', 'box', 'carton', 'set', 'pair', 'kg', 'g', 'litre', 'ml', 'metre', 'roll', 'bag', 'drum', 'bundle', 'packet'];
const KINDS = { out: ['returnable', 'non_returnable'], in: ['delivery', 'returnable_in'] };
const APPROVAL_HOURS = 24;   // an approval link works this long; the guard can resend
const MAX_ITEMS = 50;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const KIND_LABEL = { returnable: 'Returnable', non_returnable: 'Non-returnable', delivery: 'Delivery', returnable_in: 'Brought in (goes back out)' };
const STATUS_LABEL = {
  pending: 'Awaiting approval', approved: 'Approved, not yet out', rejected: 'Declined', cancelled: 'Cancelled', out: 'Out',
  partly_returned: 'Partly returned', returned: 'Returned', received: 'Received at gate', handed_over: 'Handed over', closed: 'Taken back out',
};

async function nextNumber(direction) {
  const c = await Counter.findByIdAndUpdate(`material-${direction}`, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `${direction === 'out' ? 'OUT' : 'IN'}-${String(c.seq).padStart(6, '0')}`;
}

// The request body -> clean fields, or { error }.
function readPass(b, direction) {
  const kind = String(b.kind || '');
  if (!KINDS[direction].includes(kind)) return { error: direction === 'out' ? 'Choose returnable or non-returnable' : 'Choose delivery or brought in' };
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length) return { error: 'Add at least one item' };
  if (raw.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} items on one pass` };
  const items = [];
  for (const [i, it] of raw.entries()) {
    const name = cleanText(it?.name, 120);
    const qty = Number(it?.qty);
    if (!name) return { error: `Item ${i + 1}: describe the item` };
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6) return { error: `Item ${i + 1}: enter a quantity above 0` };
    const unit = UNITS.includes(it?.unit) ? it.unit : 'nos';
    items.push({ name, qty: Math.round(qty * 1000) / 1000, unit, serial: cleanText(it?.serial, 60) });
  }
  const party = { name: cleanText(b.party?.name, 80), company: cleanText(b.party?.company, 100), mobile: b.party?.mobile ? normalizeMobile(b.party.mobile) : undefined };
  if (b.party?.mobile && !party.mobile) return { error: 'The mobile number is not valid' };
  if (!party.name && !party.company) return { error: direction === 'out' ? 'Who is taking it? Enter a name or company' : 'Who brought it? Enter the supplier or person' };
  const vehicle = {
    number: cleanText(b.vehicle?.number, 20).toUpperCase().replace(/\s+/g, ' '),
    driver: cleanText(b.vehicle?.driver, 80),
    driverMobile: b.vehicle?.driverMobile ? normalizeMobile(b.vehicle.driverMobile) : undefined,
    transporter: cleanText(b.vehicle?.transporter, 80),
  };
  if (b.vehicle?.driverMobile && !vehicle.driverMobile) return { error: 'The driver’s mobile number is not valid' };
  const docs = { dc: cleanText(b.docs?.dc, 40), invoice: cleanText(b.docs?.invoice, 40), po: cleanText(b.docs?.po, 40), eway: cleanText(b.docs?.eway, 40) };
  const out = { direction, kind, items, party, vehicle, docs, department: cleanText(b.department, 60), purpose: cleanText(b.purpose, 120), note: cleanText(b.note, 300) };
  if (kind === 'returnable') {
    const day = String(b.returnBy || '');
    if (!DAY_RE.test(day) || day < siteDay()) return { error: 'Pick the date it must come back by' };
    out.returnBy = day;
  }
  return { pass: out };
}

const itemsLine = (m) => m.items.map((i) => `${i.qty} ${i.unit} ${i.name}${i.serial ? ` (${i.serial})` : ''}`).join(', ');
const shortDay = (ymd) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));

// Asks the approver on WhatsApp (when set up) or Telegram (when they connected it). Returns how, or null when
// there is no way to reach them; the admin can then approve in the console.
async function requestApproval(m, host) {
  await ActionToken.updateMany({ kind: 'material', ref: m._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  const raw = crypto.randomBytes(18).toString('base64url');
  await ActionToken.create({ kind: 'material', ref: m._id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + APPROVAL_HOURS * 3600e3) });
  const link = `${config.appBaseUrl}/approve-material/${raw}`;
  const who = [m.party.name, m.party.company].filter(Boolean).join(', ');
  const text = `📦 *Gate pass ${m.number}* needs your approval\n${KIND_LABEL[m.kind]} · going out to ${who}${m.returnBy ? `\nMust come back by ${shortDay(m.returnBy)}` : ''}\n\n${itemsLine(m)}${m.purpose ? `\nPurpose: ${m.purpose}` : ''}\n\nTap a button below, or see it here: ${link}`;
  if (whatsapp.enabled() && host.mobile && config.approvalChannel !== 'sms') {
    await Outbox.create({ kind: 'whatsapp', material: m._id, to: host.mobile, body: text, vars: { prefix: 'm' } });
    return 'whatsapp';
  }
  if (telegram.enabled() && host.telegramChatId) {
    await Outbox.create({ kind: 'telegram', material: m._id, to: String(host.telegramChatId), body: text.replace(/\*/g, ''), vars: { prefix: 'm' } });
    return 'telegram';
  }
  return null;
}

async function findByToken(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
  const token = await ActionToken.findOne({ kind: 'material', tokenHash: sha256(raw) }).lean();
  if (!token) return null;
  const m = await Material.findById(token.ref).populate('approver').lean();
  return m ? { token, m } : null;
}

// One decision path for the link, WhatsApp, Telegram and an admin. `actor` names who decided.
async function decide(m, decision, { actor, via, note, ip }) {
  if (!['approve', 'reject'].includes(decision)) return { status: 400, body: { error: 'Decision must be approve or reject' } };
  const claimed = await Material.findOneAndUpdate(
    { _id: m._id, status: 'pending' },
    { status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: new Date(), decidedBy: actor.name, decisionNote: cleanText(note, 200) },
    { new: true },
  );
  if (!claimed) {
    const now = await Material.findById(m._id, 'status').lean();
    return { status: 409, body: { error: `This pass is already ${STATUS_LABEL[now?.status]?.toLowerCase() || 'closed'}.`, state: now?.status } };
  }
  await ActionToken.updateMany({ kind: 'material', ref: m._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  audit(actor.audit, decision === 'approve' ? 'material.approved' : 'material.rejected', { entity: 'Material', entityId: m._id, details: { number: m.number, via }, ip });
  return { status: 200, body: { ok: true, status: claimed.status }, m: claimed };
}

async function decideByToken(raw, decision, { via = 'link', ip, note } = {}) {
  const found = await findByToken(raw);
  if (!found) return { status: 404, body: { error: 'This link is invalid' } };
  const { token, m } = found;
  if (m.status !== 'pending') return { status: 409, body: { error: `This pass is already ${STATUS_LABEL[m.status]?.toLowerCase()}.`, state: m.status }, m };
  if (token.usedAt) return { status: 409, body: { error: 'A newer request was sent for this pass. Use the latest message.', state: 'superseded' }, m };
  if (token.expiresAt < new Date()) return { status: 410, body: { error: 'This request has expired. Ask security to send it again.', state: 'expired' }, m };
  const host = m.approver;
  return decide(m, decision, { actor: { name: host?.fullName || 'Approver', audit: { label: `host:${host?._id}`, role: 'host' } }, via, note, ip });
}

// Items coming back on a returnable pass. `back`: [{ item: id, qty }]. Returns the updated pass or { error }.
async function recordReturn(m, back, { gate, user, note }) {
  if (m.kind !== 'returnable') return { error: 'Only a returnable pass can have items returned' };
  if (!['out', 'partly_returned'].includes(m.status)) return { error: 'This pass is not out' };
  const byId = new Map(m.items.map((i) => [String(i._id), i]));
  const lines = [];
  for (const b of Array.isArray(back) ? back : []) {
    const it = byId.get(String(b?.item));
    const qty = Number(b?.qty);
    if (!it || !Number.isFinite(qty) || qty < 0) return { error: 'Check the quantities coming back' };
    if (qty === 0) continue;
    if (it.returnedQty + qty > it.qty + 1e-9) return { error: `${it.name}: only ${it.qty - it.returnedQty} ${it.unit} still out` };
    lines.push({ it, qty });
  }
  if (!lines.length) return { error: 'Enter what came back' };
  const now = new Date();
  for (const { it, qty } of lines) it.returnedQty = Math.round((it.returnedQty + qty) * 1000) / 1000;
  const all = m.items.every((i) => i.returnedQty >= i.qty - 1e-9);
  const doc = await Material.findOneAndUpdate(
    { _id: m._id, status: m.status, updatedAt: m.updatedAt },   // nobody else recorded a return meanwhile
    {
      status: all ? 'returned' : 'partly_returned',
      items: m.items,
      $push: {
        returns: { at: now, items: lines.map(({ it, qty }) => ({ item: it._id, qty })), gateName: gate.name, by: user.id, byName: user.fullName, note: cleanText(note, 200) },
        movements: { kind: 'in', at: now, gate: gate.id || undefined, gateName: gate.name, by: user.id, byName: user.fullName },
      },
    },
    { new: true },
  );
  if (!doc) return { error: 'Someone else just updated this pass. Open it again and retry.' };
  return { m: doc };
}

const overdue = (m, today = siteDay()) => m.kind === 'returnable' && ['out', 'partly_returned'].includes(m.status) && Boolean(m.returnBy) && m.returnBy < today;

async function approverFor(id) {
  return Host.findOne({ _id: id, active: true }).lean();
}

module.exports = {
  UNITS, KINDS, KIND_LABEL, STATUS_LABEL, nextNumber, readPass, requestApproval, findByToken, decide, decideByToken,
  recordReturn, overdue, itemsLine, approverFor, shortDay,
};
