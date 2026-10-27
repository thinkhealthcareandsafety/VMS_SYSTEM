const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');
const config = require('../config');
const { requireRole } = require('../middleware/auth');
const { Parcel, Host } = require('../models');
const passes = require('../services/passes');
const parcels = require('../services/parcels');
const settings = require('../services/settings');
const { requireLicense } = require('../services/license');
const { siteDay, audit, cleanText, decodeJpeg, normalizeMobile } = require('../services/core');

// Couriers at the gate: parcels coming in for someone, and parcels going out with a courier.
const router = express.Router();
const isId = (v) => mongoose.isValidObjectId(v);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_PHOTO = 2 * 1024 * 1024;
const PHOTO_SETS = { photo: 'photos', handover: 'handoverPhotos' };

// Data URLs -> saved JPEG files, or { error } naming what to retake.
async function savePhotos(list, max) {
  const files = [];
  for (const ph of (Array.isArray(list) ? list : []).slice(0, max)) {
    const buf = decodeJpeg(ph, MAX_PHOTO);
    if (!buf) return { error: 'A photo could not be read. Take it again.' };
    const dir = path.resolve(config.uploadDir, 'parcels');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.jpg`);
    await fs.writeFile(file, buf);
    files.push(file);
  }
  return { files };
}

function row(p) {
  const host = p.host?.fullName ? p.host : null;
  return {
    id: String(p._id), number: p.number, direction: p.direction, status: p.status, statusLabel: parcels.STATUS_LABEL[p.status],
    aging: parcels.aging(p), carrier: p.carrier, awb: p.awb, pieces: p.pieces, type: p.type, typeLabel: parcels.TYPE_LABEL[p.type],
    sender: p.sender, department: p.department, addressee: p.addressee || '', address: p.address, note: p.note,
    recipient: host ? { kind: 'host', id: String(host._id), name: host.fullName, unit: host.unit } : { kind: 'person', name: p.person?.name || '', room: p.person?.room || '', mobile: p.person?.mobile || null },
    notifiedVia: p.notifiedVia || null, notifiedAt: p.notifiedAt || null, reminders: p.reminders || 0,
    response: p.response?.kind ? { kind: p.response.kind, label: parcels.RESPONSE_LABEL[p.response.kind], at: p.response.at, by: p.response.by, via: p.response.via } : null,
    handover: p.handover?.at ? { at: p.handover.at, to: p.handover.to, mobile: p.handover.mobile || null, how: p.handover.how, reason: p.handover.reason || '', gate: p.handover.gateName, by: p.handover.byName } : null,
    ackSentAt: p.ackSentAt || null,
    movements: (p.movements || []).map((x) => ({ kind: x.kind, at: x.at, gate: x.gateName, by: x.byName })),
    photos: (p.photos || []).map((_, i) => `/api/parcels/${p._id}/photo/${i}`),
    handoverPhotos: (p.handoverPhotos || []).map((_, i) => `/api/parcels/${p._id}/handover/${i}`),
    signature: p.signature ? `/api/parcels/${p._id}/signature/0` : null,
    voidReason: p.voidReason || '', createdAt: p.createdAt, createdBy: p.createdByName || '',
  };
}

async function load(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  const p = await Parcel.findById(req.params.id).populate('host');
  if (!p) { res.status(404).json({ error: 'Not found' }); return null; }
  return p;
}

const agingCut = () => new Date(Date.now() - parcels.AGING_DAYS * 86400e3);
const VIEWS = {
  waiting: { direction: 'in', status: 'received' },
  declined: { direction: 'in', status: 'received', 'response.kind': 'declined' },
  aging: { direction: 'in', status: 'received' },
  outgoing: { direction: 'out', status: 'booked' },
  done: { status: { $in: ['collected', 'forwarded', 'returned', 'dispatched'] } },
  inward: { direction: 'in' },
  outward: { direction: 'out' },
  all: {},
};
async function search(query) {
  const q = { ...(VIEWS[query.view] || VIEWS.all) };
  if (query.view === 'aging') q.createdAt = { $lte: agingCut() };
  if (query.view === 'done') q['handover.at'] = { $gte: passes.endOfSiteDay(passes.addDays(siteDay(), -1)) }; // handed over today
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? passes.endOfSiteDay(passes.addDays(query.from, -1)) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? passes.endOfSiteDay(query.to) : null;
  if (from || to) q.createdAt = { ...q.createdAt, ...(from ? { $gt: from } : {}), ...(to ? { $lte: to } : {}) };
  const term = cleanText(query.q, 60);
  if (term) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const hosts = await Host.find({ $or: [{ fullName: re }, { unit: re }] }, '_id').limit(50).lean();
    q.$or = [{ number: re }, { awb: re }, { carrier: re }, { 'person.name': re }, { 'person.room': re }, { 'sender.name': re }, { 'sender.company': re }, { department: re },
      { addressee: re }, { 'handover.to': re }, { host: { $in: hosts.map((h) => h._id) } }];
  }
  return q;
}

router.get('/', requireRole('guard', 'admin'), async (req, res) => {
  const list = await Parcel.find(await search(req.query)).sort({ createdAt: -1 }).limit(Math.min(500, Number(req.query.limit) || 200)).populate('host').lean();
  const [waiting, declined, aging, outgoing] = await Promise.all([
    Parcel.countDocuments(VIEWS.waiting), Parcel.countDocuments(VIEWS.declined),
    Parcel.countDocuments({ ...VIEWS.aging, createdAt: { $lte: agingCut() } }), Parcel.countDocuments(VIEWS.outgoing),
  ]);
  res.json({ rows: list.map(row), counts: { waiting, declined, aging, outgoing }, carriers: parcels.CARRIERS, types: parcels.TYPES });
});

// Both registers in Excel, in the columns of the hotel's paper registers: incoming and outgoing on their own sheets.
router.get('/export.xlsx', requireRole('admin'), async (req, res) => {
  const list = await Parcel.find(await search(req.query)).sort({ createdAt: 1 }).limit(20000).populate('host').lean();
  const wb = new ExcelJS.Workbook();
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const sheet = (name, columns) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  };
  const inWs = sheet('Incoming', [
    { header: 'Sr. No.', key: 'sr', width: 7 }, { header: 'No.', key: 'number', width: 12 }, { header: 'Receiving date & time', key: 'at', width: 19 },
    { header: 'Name on courier (to)', key: 'who', width: 24 }, { header: 'For department / room', key: 'unit', width: 18 }, { header: 'From (sender)', key: 'sender', width: 24 },
    { header: 'Courier', key: 'carrier', width: 16 }, { header: 'Tracking / docket / AWB', key: 'awb', width: 20 }, { header: 'Pieces', key: 'pieces', width: 7 },
    { header: 'Type', key: 'type', width: 12 }, { header: 'Recipient answer', key: 'response', width: 22 }, { header: 'Handover to', key: 'to', width: 22 },
    { header: 'Their mobile', key: 'mobile', width: 15 }, { header: 'Handed over at', key: 'handedAt', width: 19 }, { header: 'Recipient told', key: 'ack', width: 13 },
    { header: 'LP (guard)', key: 'guard', width: 18 }, { header: 'Status', key: 'status', width: 20 }, { header: 'Remarks', key: 'remarks', width: 30 },
  ]);
  const outWs = sheet('Outgoing', [
    { header: 'Sr. No.', key: 'sr', width: 7 }, { header: 'No.', key: 'number', width: 12 }, { header: 'Date & time', key: 'at', width: 19 },
    { header: 'Name on courier (to)', key: 'addressee', width: 24 }, { header: 'Address', key: 'address', width: 32 }, { header: 'Sender department', key: 'dept', width: 18 },
    { header: 'Name of sender', key: 'sender', width: 22 }, { header: 'Courier', key: 'carrier', width: 16 }, { header: 'Tracking / docket / AWB (from picker)', key: 'awb', width: 22 },
    { header: 'Courier picker', key: 'picker', width: 20 }, { header: 'Picker mobile', key: 'mobile', width: 15 }, { header: 'Picked up at', key: 'handedAt', width: 19 },
    { header: 'LP (guard)', key: 'guard', width: 18 }, { header: 'Status', key: 'status', width: 18 }, { header: 'Remarks', key: 'remarks', width: 30 },
  ]);
  let nIn = 0;
  let nOut = 0;
  for (const p of list) {
    const r = row(p);
    const remarks = [r.note, r.handover?.reason, r.voidReason && `Void: ${r.voidReason}`].filter(Boolean).join(' · ');
    if (r.direction === 'in') {
      nIn += 1;
      inWs.addRow({
        sr: nIn, number: r.number, at: fmt(r.createdAt), who: r.recipient.name, unit: r.recipient.kind === 'host' ? r.recipient.unit : [r.recipient.room && `Room ${r.recipient.room}`, r.department].filter(Boolean).join(', '),
        sender: [r.sender?.company, r.sender?.name].filter(Boolean).join(', '), carrier: r.carrier, awb: r.awb, pieces: r.pieces, type: r.typeLabel,
        response: r.response ? `${r.response.label} ${fmt(r.response.at)}` : r.notifiedVia ? 'No answer' : 'Not sent', to: r.handover?.to || '', mobile: r.handover?.mobile || '',
        handedAt: fmt(r.handover?.at), ack: r.ackSentAt ? 'Yes' : '', guard: r.handover?.by || r.createdBy, status: r.aging ? 'Waiting (overdue)' : r.statusLabel, remarks,
      });
    } else {
      nOut += 1;
      outWs.addRow({
        sr: nOut, number: r.number, at: fmt(r.createdAt), addressee: r.addressee, address: r.address, dept: r.department || (r.recipient.kind === 'host' ? r.recipient.unit : ''),
        sender: r.recipient.name, carrier: r.carrier, awb: r.awb, picker: r.handover?.to || '', mobile: r.handover?.mobile || '', handedAt: fmt(r.handover?.at),
        guard: r.handover?.by || r.createdBy, status: r.statusLabel, remarks,
      });
    }
  }
  audit(req.user, 'parcel.exported', { details: { rows: list.length, view: req.query.view || 'all' }, ip: req.ip });
  res.type(XLSX).attachment(`courier register ${siteDay()}.xlsx`).send(Buffer.from(await wb.xlsx.writeBuffer()));
});

router.get('/:id', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (p) res.json(row(p.toObject()));
});

router.get('/:id/:set(photo|handover|signature)/:n', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const field = PHOTO_SETS[req.params.set] || 'signature';
  const p = await Parcel.findById(req.params.id, field).lean();
  const file = field === 'signature' ? p?.signature : p?.[field]?.[Number(req.params.n)];
  if (!file) return res.status(404).end();
  res.type('jpeg').sendFile(path.resolve(file));
});

// A parcel arrives (in), or a department hands one over to be sent (out).
router.post('/', requireRole('guard', 'admin'), requireLicense, async (req, res) => {
  const b = req.body || {};
  const direction = b.direction === 'out' ? 'out' : b.direction === 'in' ? 'in' : null;
  if (!direction) return res.status(400).json({ error: 'Is the parcel coming in or going out?' });
  const { parcel, error } = parcels.readParcel(b, direction);
  if (error) return res.status(400).json({ error });
  let host = null;
  if (b.hostId) {
    host = isId(b.hostId) ? await Host.findOne({ _id: b.hostId, active: true }).lean() : null;
    if (!host) return res.status(400).json({ error: 'That person is not active. Enter their name instead.' });
  } else if (!parcel.person.name && !parcel.department) {
    return res.status(400).json({ error: direction === 'in' ? 'Who is it for? Pick a person or enter a name' : 'Who is sending it? Pick a person or enter a name' });
  }
  // The same AWB already waiting: most likely scanned twice.
  if (direction === 'in' && parcel.awb && (await Parcel.exists({ awb: parcel.awb, status: 'received' }))) {
    return res.status(409).json({ error: `AWB ${parcel.awb} is already logged and waiting for pickup.`, code: 'duplicate_awb' });
  }
  const shots = await savePhotos(b.photos, parcels.MAX_PHOTOS);
  if (shots.error) return res.status(400).json({ error: shots.error });
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const p = await Parcel.create({
    ...parcel,
    number: await parcels.nextNumber(),
    status: direction === 'in' ? 'received' : 'booked',
    host: host?._id,
    ...(direction === 'in' ? { movements: [passes.movement('in', gate, req.user, now)] } : {}),
    photos: shots.files.length ? shots.files : undefined,
    createdBy: req.user.id, createdByName: req.user.fullName,
  });
  audit(req.user, direction === 'in' ? 'parcel.received' : 'parcel.booked', { entity: 'Parcel', entityId: p._id, details: { number: p.number, carrier: p.carrier, awb: p.awb, for: parcels.forWhom(p, host), gate: gate.name }, ip: req.ip });
  const via = direction === 'in' ? await parcels.requestResponse(p, host) : null;
  res.status(201).json({ ...row((await Parcel.findById(p._id).populate('host').lean())), notifiedVia: via });
});

// Handing a parcel over at the desk: the name and mobile number of whoever takes it, and a photo of them taking it
// (it stands in for the signature in the paper register). The recipient is then told who took it.
router.post('/:id/collect', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  if (p.direction !== 'in' || p.status !== 'received') return res.status(409).json({ error: `This parcel is already ${parcels.STATUS_LABEL[p.status].toLowerCase()}.` });
  const b = req.body || {};
  const to = cleanText(b.collector, 80);
  if (to.length < 2) return res.status(400).json({ error: 'Who is collecting it? Enter their name' });
  const mobile = normalizeMobile(b.mobile);
  if (!mobile) return res.status(400).json({ error: 'Enter the collector’s mobile number (10 digits)' });
  if (!b.signature) return res.status(400).json({ error: 'Ask the person collecting it to sign on the tablet' });
  const sign = await savePhotos([b.signature], 1);
  const shots = await savePhotos(b.photos, 3);
  if (sign.error || shots.error) return res.status(400).json({ error: sign.error ? 'The signature could not be read. Ask them to sign again.' : shots.error });
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const doc = await Parcel.findOneAndUpdate(
    { _id: p._id, status: 'received' },
    {
      status: 'collected', signature: sign.files[0], ...(shots.files.length ? { handoverPhotos: shots.files } : {}),
      handover: { at: now, to, mobile, how: 'handover', reason: cleanText(b.note, 200), gateName: gate.name, by: req.user.id, byName: req.user.fullName },
    },
    { new: true },
  ).populate('host').lean();
  if (!doc) return res.status(409).json({ error: 'Someone else just handed this parcel over.' });
  audit(req.user, 'parcel.collected', { entity: 'Parcel', entityId: p._id, details: { number: p.number, to, ...(doc.response?.kind === 'declined' ? { declinedByRecipient: true } : {}) }, ip: req.ip });
  const host = doc.host?.active ? doc.host : null;
  const told = await parcels.acknowledge(doc, host);
  res.json({ ...row(host && told ? { ...doc, ackSentAt: new Date() } : doc), acknowledgedVia: told });
});

// Handed to a department or a room by staff (hotel guests' parcels go to the front desk or the room).
router.post('/:id/forward', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  const to = cleanText(req.body?.to, 80);
  if (to.length < 2) return res.status(400).json({ error: 'Who took it? Enter the person and department' });
  const gate = await passes.gateOf(req.user.id);
  const doc = await Parcel.findOneAndUpdate(
    { _id: p._id, direction: 'in', status: 'received' },
    { status: 'forwarded', handover: { at: new Date(), to, how: 'forward', reason: cleanText(req.body?.note, 200), gateName: gate.name, by: req.user.id, byName: req.user.fullName } },
    { new: true },
  ).populate('host').lean();
  if (!doc) return res.status(409).json({ error: 'Only a parcel waiting at the gate can be handed on' });
  audit(req.user, 'parcel.forwarded', { entity: 'Parcel', entityId: p._id, details: { number: p.number, to }, ip: req.ip });
  res.json(row(doc));
});

// Refused or undeliverable: back with the courier.
router.post('/:id/return', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  const reason = cleanText(req.body?.reason, 200) || (p.response?.kind === 'declined' ? `Declined by ${p.response.by}` : '');
  if (reason.length < 3) return res.status(400).json({ error: 'Say why it is going back' });
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const doc = await Parcel.findOneAndUpdate(
    { _id: p._id, direction: 'in', status: 'received' },
    { status: 'returned', handover: { at: now, to: cleanText(req.body?.agent, 80) || p.carrier, how: 'return', reason, gateName: gate.name, by: req.user.id, byName: req.user.fullName }, $push: { movements: passes.movement('out', gate, req.user, now) } },
    { new: true },
  ).populate('host').lean();
  if (!doc) return res.status(409).json({ error: 'Only a parcel waiting at the gate can be returned' });
  audit(req.user, 'parcel.returned', { entity: 'Parcel', entityId: p._id, details: { number: p.number, reason }, ip: req.ip });
  res.json(row(doc));
});

// Outgoing: the courier's picker takes it and gives the docket (AWB) number; their name, mobile and a photo are kept.
router.post('/:id/dispatch', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  const b = req.body || {};
  const agent = cleanText(b.agent, 80);
  if (agent.length < 2) return res.status(400).json({ error: 'Enter the courier picker’s name' });
  const mobile = b.mobile ? normalizeMobile(b.mobile) : undefined;
  if (b.mobile && !mobile) return res.status(400).json({ error: 'The picker’s mobile number is not valid' });
  const carrier = cleanText(b.carrier, 40) || p.carrier;
  if (!carrier) return res.status(400).json({ error: 'Which courier is taking it?' });
  const awb = cleanText(b.awb, 40).replace(/\s+/g, '').toUpperCase() || p.awb;
  if (!awb) return res.status(400).json({ error: 'Enter the tracking (AWB / docket) number the picker gave' });
  const shots = await savePhotos(b.photos, 3);
  const sign = await savePhotos(b.signature ? [b.signature] : [], 1);
  if (shots.error || sign.error) return res.status(400).json({ error: shots.error || 'The signature could not be read. Ask them to sign again.' });
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const doc = await Parcel.findOneAndUpdate(
    { _id: p._id, direction: 'out', status: 'booked' },
    {
      status: 'dispatched', carrier, awb, ...(shots.files.length ? { handoverPhotos: shots.files } : {}), ...(sign.files.length ? { signature: sign.files[0] } : {}),
      handover: { at: now, to: agent, mobile, how: 'dispatch', reason: cleanText(b.note, 200), gateName: gate.name, by: req.user.id, byName: req.user.fullName },
      $push: { movements: passes.movement('out', gate, req.user, now) },
    },
    { new: true },
  ).populate('host').lean();
  if (!doc) return res.status(409).json({ error: 'Only a parcel waiting to be dispatched can be handed to a courier' });
  audit(req.user, 'parcel.dispatched', { entity: 'Parcel', entityId: p._id, details: { number: p.number, carrier, awb, agent }, ip: req.ip });
  res.json(row(doc));
});

// Asks the recipient again (they missed the message): the photos with Accept / Decline, or a plain reminder once accepted.
router.post('/:id/notify', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  if (p.status !== 'received') return res.status(409).json({ error: 'This parcel is no longer waiting' });
  const host = p.host ? await Host.findOne({ _id: p.host._id, active: true }).lean() : null;
  const via = p.response?.kind === 'accepted'
    ? await parcels.tell(p, host, `📦 Reminder: your parcel ${p.number} (${p.carrier}${p.awb ? `, AWB ${p.awb}` : ''}) is still at security. Please collect it.`)
    : await parcels.requestResponse(p.toObject(), host, { reminder: true });
  if (!via) return res.status(409).json({ error: 'This person cannot be reached on WhatsApp, Telegram or email. Call them.' });
  audit(req.user, 'parcel.reminded', { entity: 'Parcel', entityId: p._id, details: { number: p.number, via }, ip: req.ip });
  res.json({ ok: true, via });
});

// Logged by mistake (wrong person, scanned twice): an admin voids it with a reason. Never deleted.
router.post('/:id/void', requireRole('admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  const reason = cleanText(req.body?.reason, 200);
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters)' });
  const doc = await Parcel.findOneAndUpdate({ _id: p._id, status: { $in: ['received', 'booked'] } }, { status: 'void', voidReason: reason }, { new: true }).populate('host').lean();
  if (!doc) return res.status(409).json({ error: 'Only a parcel not yet handed over can be voided' });
  audit(req.user, 'parcel.voided', { entity: 'Parcel', entityId: p._id, details: { number: p.number, reason }, ip: req.ip });
  res.json(row(doc));
});

// ---------- The recipient's link (no login: the token is the credential) ----------
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 10 * 60e3, limit: 120, standardHeaders: true, legacyHeaders: false }));
publicRouter.get('/:token', async (req, res) => {
  const found = await parcels.findByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This link is invalid' });
  const { token, p } = found;
  const base = `/api/parcel-responses/${encodeURIComponent(req.params.token)}`;
  res.json({
    number: p.number, carrier: p.carrier, awb: p.awb, pieces: p.pieces, typeLabel: parcels.TYPE_LABEL[p.type], sender: p.sender, note: p.note,
    arrivedAt: p.createdAt, recipientName: p.host?.fullName || p.person?.name || '', state: parcels.tokenState(token, p), statusLabel: parcels.STATUS_LABEL[p.status],
    photos: (p.photos || []).map((_, i) => `${base}/photo/${i}`), siteName: (await settings.get()).siteName,
  });
});
publicRouter.get('/:token/photo/:n', async (req, res) => {
  const found = await parcels.findByToken(req.params.token);
  const file = found && found.token.expiresAt > new Date() ? found.p.photos?.[Number(req.params.n)] : null;
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=600').type('jpeg').sendFile(path.resolve(file));
});
publicRouter.post('/:token/decision', async (req, res) => {
  const r = await parcels.respondByToken(req.params.token, req.body?.decision, { ip: req.ip });
  res.status(r.status).json(r.body);
});

module.exports = { router, publicRouter, row };
