const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const config = require('../config');
const { requireRole, isAdmin } = require('../middleware/auth');
const { Parcel, Host } = require('../models');
const passes = require('../services/passes');
const parcels = require('../services/parcels');
const { siteDay, audit, cleanText, decodeJpeg, normalizeMobile } = require('../services/core');

// Couriers at the gate: parcels coming in for someone, and parcels going out with a courier.
const router = express.Router();
const isId = (v) => mongoose.isValidObjectId(v);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_PHOTO = 2 * 1024 * 1024;

function row(p) {
  const host = p.host?.fullName ? p.host : null;
  return {
    id: String(p._id), number: p.number, direction: p.direction, status: p.status, statusLabel: parcels.STATUS_LABEL[p.status],
    aging: parcels.aging(p), carrier: p.carrier, awb: p.awb, pieces: p.pieces, type: p.type, typeLabel: parcels.TYPE_LABEL[p.type],
    sender: p.sender, department: p.department, address: p.address, note: p.note,
    recipient: host ? { kind: 'host', id: String(host._id), name: host.fullName, unit: host.unit } : { kind: 'person', name: p.person?.name || '', room: p.person?.room || '', mobile: p.person?.mobile || null },
    hasCode: Boolean(p.codeSealed), codeLocked: (p.codeTries || 0) >= parcels.MAX_TRIES, notifiedVia: p.notifiedVia || null, notifiedAt: p.notifiedAt || null, reminders: p.reminders || 0,
    handover: p.handover?.at ? { at: p.handover.at, to: p.handover.to, mobile: p.handover.mobile || null, how: p.handover.how, reason: p.handover.reason || '', gate: p.handover.gateName, by: p.handover.byName } : null,
    movements: (p.movements || []).map((x) => ({ kind: x.kind, at: x.at, gate: x.gateName, by: x.byName })),
    photos: (p.photos || []).map((_, i) => `/api/parcels/${p._id}/photo/${i}`),
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
  const term = cleanText(query.q, 60);
  if (term) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const hosts = await Host.find({ $or: [{ fullName: re }, { unit: re }] }, '_id').limit(50).lean();
    q.$or = [{ number: re }, { awb: re }, { carrier: re }, { 'person.name': re }, { 'person.room': re }, { 'sender.name': re }, { 'sender.company': re }, { department: re }, { host: { $in: hosts.map((h) => h._id) } }];
  }
  return q;
}

router.get('/', requireRole('guard', 'admin'), async (req, res) => {
  const list = await Parcel.find(await search(req.query)).sort({ createdAt: -1 }).limit(Math.min(500, Number(req.query.limit) || 200)).populate('host').lean();
  const [waiting, aging, outgoing] = await Promise.all([
    Parcel.countDocuments(VIEWS.waiting), Parcel.countDocuments({ ...VIEWS.aging, createdAt: { $lte: agingCut() } }), Parcel.countDocuments(VIEWS.outgoing),
  ]);
  res.json({ rows: list.map(row), counts: { waiting, aging, outgoing }, carriers: parcels.CARRIERS, types: parcels.TYPES });
});

router.get('/export.xlsx', requireRole('admin'), async (req, res) => {
  const list = await Parcel.find(await search(req.query)).sort({ createdAt: 1 }).limit(20000).populate('host').lean();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Couriers', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'No.', key: 'number', width: 12 }, { header: 'Received / booked', key: 'at', width: 18 }, { header: 'In / out', key: 'dir', width: 8 },
    { header: 'Status', key: 'status', width: 20 }, { header: 'Courier', key: 'carrier', width: 16 }, { header: 'AWB', key: 'awb', width: 18 },
    { header: 'Pieces', key: 'pieces', width: 7 }, { header: 'Type', key: 'type', width: 12 }, { header: 'For / from', key: 'who', width: 24 },
    { header: 'Flat / room / dept', key: 'unit', width: 16 }, { header: 'Sender', key: 'sender', width: 22 }, { header: 'Address', key: 'address', width: 30 },
    { header: 'Notified by', key: 'notified', width: 11 }, { header: 'Handed to', key: 'to', width: 20 }, { header: 'How', key: 'how', width: 10 },
    { header: 'Override reason', key: 'reason', width: 26 }, { header: 'Handed at', key: 'handedAt', width: 18 }, { header: 'Guard', key: 'guard', width: 18 },
  ];
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  for (const p of list) {
    const r = row(p);
    ws.addRow({
      number: r.number, at: fmt(r.createdAt), dir: r.direction === 'in' ? 'In' : 'Out', status: r.aging ? 'Waiting (overdue)' : r.statusLabel, carrier: r.carrier, awb: r.awb,
      pieces: r.pieces, type: r.typeLabel, who: r.recipient.name, unit: r.recipient.kind === 'host' ? r.recipient.unit : r.recipient.room || r.department,
      sender: [r.sender?.name, r.sender?.company].filter(Boolean).join(', '), address: r.address, notified: r.notifiedVia || '',
      to: r.handover?.to || '', how: r.handover?.how || '', reason: r.handover?.reason || '', handedAt: fmt(r.handover?.at), guard: r.handover?.by || r.createdBy,
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  audit(req.user, 'parcel.exported', { details: { rows: list.length, view: req.query.view || 'all' }, ip: req.ip });
  res.type(XLSX).attachment(`courier register ${siteDay()}.xlsx`).send(Buffer.from(await wb.xlsx.writeBuffer()));
});

router.get('/:id', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (p) res.json(row(p.toObject()));
});

router.get('/:id/photo/:n', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const p = await Parcel.findById(req.params.id, 'photos').lean();
  const file = p?.photos?.[Number(req.params.n)];
  if (!file) return res.status(404).end();
  res.type('jpeg').sendFile(path.resolve(file));
});

// A parcel arrives (in), or a department hands one over to be sent (out).
router.post('/', requireRole('guard', 'admin'), async (req, res) => {
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
  const photos = [];
  for (const ph of (Array.isArray(b.photos) ? b.photos : []).slice(0, 2)) {
    const buf = decodeJpeg(ph, MAX_PHOTO);
    if (!buf) return res.status(400).json({ error: 'A photo could not be read. Take it again.' });
    const dir = path.resolve(config.uploadDir, 'parcels');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.jpg`);
    await fs.writeFile(file, buf);
    photos.push(file);
  }
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const p = await Parcel.create({
    ...parcel,
    number: await parcels.nextNumber(),
    status: direction === 'in' ? 'received' : 'booked',
    host: host?._id,
    // A pickup code only when someone can be told it.
    ...(direction === 'in' && host ? { codeSealed: parcels.sealCode(parcels.newCode()) } : {}),
    ...(direction === 'in' ? { movements: [passes.movement('in', gate, req.user, now)] } : {}),
    photos: photos.length ? photos : undefined,
    createdBy: req.user.id, createdByName: req.user.fullName,
  });
  audit(req.user, direction === 'in' ? 'parcel.received' : 'parcel.booked', { entity: 'Parcel', entityId: p._id, details: { number: p.number, carrier: p.carrier, awb: p.awb, for: parcels.forWhom(p, host), gate: gate.name }, ip: req.ip });
  const via = direction === 'in' ? await parcels.notify(p, host) : null;
  res.status(201).json({ ...row((await Parcel.findById(p._id).populate('host').lean())), notifiedVia: via });
});

// Handing a parcel over at the desk: with the recipient's code, or by override (a reason is required).
router.post('/:id/collect', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  if (p.direction !== 'in' || p.status !== 'received') return res.status(409).json({ error: `This parcel is already ${parcels.STATUS_LABEL[p.status].toLowerCase()}.` });
  const b = req.body || {};
  const to = cleanText(b.collector, 80);
  if (to.length < 2) return res.status(400).json({ error: 'Who is collecting it? Enter their name' });
  const mobile = b.mobile ? normalizeMobile(b.mobile) : undefined;
  if (b.mobile && !mobile) return res.status(400).json({ error: 'The collector’s mobile number is not valid' });
  let how = 'code';
  let reason = '';
  if (b.override) {
    reason = cleanText(b.reason, 200);
    if (reason.length < 5) return res.status(400).json({ error: 'Say why the code is not being used (at least 5 characters)' });
    if (!mobile) return res.status(400).json({ error: 'For an override, record the collector’s mobile number' });
    how = 'override';
  } else if (p.codeSealed) {
    const check = await parcels.checkCode(p.toObject(), b.code);
    if (!check.ok) {
      audit(req.user, 'parcel.wrong_code', { entity: 'Parcel', entityId: p._id, details: { number: p.number, locked: Boolean(check.locked) }, ip: req.ip });
      return res.status(400).json({ error: check.error, locked: Boolean(check.locked) });
    }
  } else {
    how = 'override';
    reason = cleanText(b.reason, 200) || 'No pickup code (recipient not reachable): ID checked at the desk';
  }
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const doc = await Parcel.findOneAndUpdate(
    { _id: p._id, status: 'received' },
    { status: 'collected', handover: { at: now, to, mobile, how, reason, gateName: gate.name, by: req.user.id, byName: req.user.fullName } },
    { new: true },
  ).populate('host').lean();
  if (!doc) return res.status(409).json({ error: 'Someone else just handed this parcel over.' });
  audit(req.user, how === 'override' ? 'parcel.collected_override' : 'parcel.collected', { entity: 'Parcel', entityId: p._id, details: { number: p.number, to, ...(reason ? { reason } : {}) }, ip: req.ip });
  res.json(row(doc));
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
  const reason = cleanText(req.body?.reason, 200);
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

// Outgoing: the courier's agent takes it.
router.post('/:id/dispatch', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  const agent = cleanText(req.body?.agent, 80);
  if (agent.length < 2) return res.status(400).json({ error: 'Enter the courier agent’s name' });
  const carrier = cleanText(req.body?.carrier, 40) || p.carrier;
  if (!carrier) return res.status(400).json({ error: 'Which courier is taking it?' });
  const awb = cleanText(req.body?.awb, 40).replace(/\s+/g, '').toUpperCase() || p.awb;
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const doc = await Parcel.findOneAndUpdate(
    { _id: p._id, direction: 'out', status: 'booked' },
    { status: 'dispatched', carrier, awb, handover: { at: now, to: agent, how: 'dispatch', gateName: gate.name, by: req.user.id, byName: req.user.fullName }, $push: { movements: passes.movement('out', gate, req.user, now) } },
    { new: true },
  ).populate('host').lean();
  if (!doc) return res.status(409).json({ error: 'Only a parcel waiting to be dispatched can be handed to a courier' });
  audit(req.user, 'parcel.dispatched', { entity: 'Parcel', entityId: p._id, details: { number: p.number, carrier, awb, agent }, ip: req.ip });
  res.json(row(doc));
});

router.post('/:id/notify', requireRole('guard', 'admin'), async (req, res) => {
  const p = await load(req, res);
  if (!p) return;
  if (p.status !== 'received') return res.status(409).json({ error: 'This parcel is no longer waiting' });
  const host = p.host ? await Host.findOne({ _id: p.host._id, active: true }).lean() : null;
  const via = await parcels.notify(p.toObject(), host, { reminder: true });
  if (!via) return res.status(409).json({ error: 'This person cannot be reached on WhatsApp or Telegram. Call them.' });
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

module.exports = router;
