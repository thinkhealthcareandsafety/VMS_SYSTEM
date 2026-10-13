const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');
const config = require('../config');
const { requireRole, isAdmin } = require('../middleware/auth');
const { Material } = require('../models');
const settings = require('../services/settings');
const passes = require('../services/passes');
const material = require('../services/material');
const { siteDay, audit, cleanText, decodeJpeg } = require('../services/core');

// Material gate passes and gate entries. Guards and admins work them at the gate; heads approve from WhatsApp,
// Telegram or the link; an admin can decide in the console when the head cannot be reached.
const router = express.Router();
const isId = (v) => mongoose.isValidObjectId(v);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_PHOTO = 2 * 1024 * 1024;

function row(m, admin) {
  const ee = passes.entryExit(m);
  const back = (m.items || []).reduce((n, i) => n + (i.returnedQty || 0), 0);
  return {
    id: String(m._id), number: m.number, direction: m.direction, kind: m.kind, kindLabel: material.KIND_LABEL[m.kind],
    status: m.status, statusLabel: material.STATUS_LABEL[m.status], overdue: material.overdue(m),
    items: (m.items || []).map((i) => ({ id: String(i._id), name: i.name, qty: i.qty, unit: i.unit, serial: i.serial, returnedQty: i.returnedQty || 0 })),
    itemCount: (m.items || []).length, returnedSome: back > 0,
    party: m.party, department: m.department, purpose: m.purpose, note: m.note, vehicle: m.vehicle, docs: m.docs, returnBy: m.returnBy || null,
    approver: m.approver?.fullName ? { id: String(m.approver._id), name: m.approver.fullName, unit: m.approver.unit } : null,
    decidedAt: m.decidedAt || null, decidedBy: m.decidedBy || null, decisionNote: m.decisionNote || '',
    handedTo: m.handedTo || null, handedAt: m.handedAt || null,
    returns: (m.returns || []).map((r) => ({ at: r.at, gate: r.gateName, by: r.byName, note: r.note, items: r.items.map((x) => ({ item: String(x.item), qty: x.qty })) })),
    movements: (m.movements || []).map((x) => ({ kind: x.kind, at: x.at, gate: x.gateName, by: x.byName })),
    out: ee.exit, in: ee.entry,
    photos: (m.photos || []).map((_, i) => `/api/material/${m._id}/photo/${i}`),
    createdAt: m.createdAt, createdBy: m.createdByName || '',
    ...(admin ? {} : {}),
  };
}

async function load(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  const m = await Material.findById(req.params.id).populate('approver');
  if (!m) { res.status(404).json({ error: 'Not found' }); return null; }
  return m;
}

// ---------- Registers ----------
// view: pending | ready (approved, not out) | out (everything out that comes back) | overdue | inward | all
const VIEWS = {
  pending: { direction: 'out', status: 'pending' },
  ready: { direction: 'out', status: 'approved' },
  out: { kind: 'returnable', status: { $in: ['out', 'partly_returned'] } },
  overdue: { kind: 'returnable', status: { $in: ['out', 'partly_returned'] } },
  inside: { kind: 'returnable_in', status: 'received' },
  inward: { direction: 'in' },
  outward: { direction: 'out' },
  all: {},
};
function search(query) {
  const q = { ...(VIEWS[query.view] || VIEWS.all) };
  if (query.view === 'overdue') q.returnBy = { $lt: siteDay() };
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? passes.endOfSiteDay(passes.addDays(query.from, -1)) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? passes.endOfSiteDay(query.to) : null;
  if (from || to) q.createdAt = { ...(from ? { $gt: from } : {}), ...(to ? { $lte: to } : {}) };
  const term = cleanText(query.q, 60);
  if (term) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ number: re }, { 'party.name': re }, { 'party.company': re }, { 'items.name': re }, { 'items.serial': re }, { 'vehicle.number': re }, { department: re }, { 'docs.dc': re }, { 'docs.invoice': re }, { 'docs.po': re }];
  }
  return q;
}

router.get('/', requireRole('guard', 'admin'), async (req, res) => {
  const list = await Material.find(search(req.query)).sort({ createdAt: -1 }).limit(Math.min(500, Number(req.query.limit) || 200)).populate('approver').lean();
  const today = siteDay();
  const [pending, ready, out, overdue, inside] = await Promise.all([
    Material.countDocuments(VIEWS.pending), Material.countDocuments(VIEWS.ready), Material.countDocuments(VIEWS.out),
    Material.countDocuments({ ...VIEWS.overdue, returnBy: { $lt: today } }), Material.countDocuments(VIEWS.inside),
  ]);
  res.json({ rows: list.map((m) => row(m, isAdmin(req.user))), counts: { pending, ready, out, overdue, inside }, units: material.UNITS });
});

// The registers in Excel: one row per item, so quantities can be totalled.
router.get('/export.xlsx', requireRole('admin'), async (req, res) => {
  const list = await Material.find(search(req.query)).sort({ createdAt: 1 }).limit(20000).populate('approver').lean();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Material', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Pass', key: 'number', width: 12 }, { header: 'Date', key: 'date', width: 17 }, { header: 'In / out', key: 'dir', width: 8 },
    { header: 'Type', key: 'kind', width: 22 }, { header: 'Status', key: 'status', width: 20 }, { header: 'Item', key: 'item', width: 30 },
    { header: 'Qty', key: 'qty', width: 8 }, { header: 'Unit', key: 'unit', width: 8 }, { header: 'Serial / tag', key: 'serial', width: 16 },
    { header: 'Returned', key: 'back', width: 9 }, { header: 'Return by', key: 'returnBy', width: 12 }, { header: 'Party', key: 'party', width: 24 },
    { header: 'Department', key: 'dept', width: 16 }, { header: 'Purpose', key: 'purpose', width: 22 }, { header: 'Vehicle', key: 'vehicle', width: 14 },
    { header: 'Driver', key: 'driver', width: 18 }, { header: 'DC no.', key: 'dc', width: 12 }, { header: 'Invoice no.', key: 'invoice', width: 12 },
    { header: 'PO no.', key: 'po', width: 12 }, { header: 'E-way bill', key: 'eway', width: 14 }, { header: 'Approved by', key: 'approver', width: 18 },
    { header: 'Gate', key: 'gate', width: 16 }, { header: 'Guard', key: 'guard', width: 18 }, { header: 'Moved at', key: 'moved', width: 17 },
  ];
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  for (const m of list) {
    const move = m.direction === 'out' ? passes.entryExit(m).exit : passes.entryExit(m).entry;
    for (const it of m.items) {
      ws.addRow({
        number: m.number, date: fmt(m.createdAt), dir: m.direction === 'out' ? 'Out' : 'In', kind: material.KIND_LABEL[m.kind],
        status: material.overdue(m) ? 'Overdue' : material.STATUS_LABEL[m.status], item: it.name, qty: it.qty, unit: it.unit, serial: it.serial,
        back: m.kind === 'returnable' ? it.returnedQty || 0 : '', returnBy: m.returnBy || '', party: [m.party?.name, m.party?.company].filter(Boolean).join(', '),
        dept: m.department, purpose: m.purpose, vehicle: m.vehicle?.number, driver: m.vehicle?.driver, dc: m.docs?.dc, invoice: m.docs?.invoice, po: m.docs?.po,
        eway: m.docs?.eway, approver: m.decidedBy || '', gate: move?.gate || '', guard: move?.by || '', moved: fmt(move?.at),
      });
    }
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  audit(req.user, 'material.exported', { details: { rows: list.length, view: req.query.view || 'all' }, ip: req.ip });
  res.type(XLSX).attachment(`material register ${siteDay()}.xlsx`).send(Buffer.from(await wb.xlsx.writeBuffer()));
});

router.get('/:id', requireRole('guard', 'admin'), async (req, res) => {
  const m = await load(req, res);
  if (m) res.json(row(m.toObject(), isAdmin(req.user)));
});

router.get('/:id/photo/:n', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const m = await Material.findById(req.params.id, 'photos').lean();
  const file = m?.photos?.[Number(req.params.n)];
  if (!file) return res.status(404).end();
  res.type('jpeg').sendFile(path.resolve(file));
});

// ---------- Create ----------
// Outward: waits for the head's approval (or is approved at once by an admin). Inward: recorded as it arrives.
router.post('/', requireRole('guard', 'admin'), async (req, res) => {
  const b = req.body || {};
  const direction = b.direction === 'in' ? 'in' : b.direction === 'out' ? 'out' : null;
  if (!direction) return res.status(400).json({ error: 'Is the material coming in or going out?' });
  const { pass, error } = material.readPass(b, direction);
  if (error) return res.status(400).json({ error });

  let approver = null;
  if (direction === 'out') {
    approver = isId(b.approverId) ? await material.approverFor(b.approverId) : null;
    if (!approver) return res.status(400).json({ error: 'Choose who approves this pass (head of department)' });
  }
  const photos = [];
  for (const p of (Array.isArray(b.photos) ? b.photos : []).slice(0, 3)) {
    const buf = decodeJpeg(p, MAX_PHOTO);
    if (!buf) return res.status(400).json({ error: 'A photo could not be read. Take it again.' });
    const dir = path.resolve(config.uploadDir, 'material');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.jpg`);
    await fs.writeFile(file, buf);
    photos.push(file);
  }

  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const approveNow = direction === 'out' && b.approveNow === true && isAdmin(req.user);
  const m = await Material.create({
    ...pass,
    number: await material.nextNumber(direction),
    status: direction === 'in' ? 'received' : approveNow ? 'approved' : 'pending',
    approver: approver?._id,
    ...(approveNow ? { decidedAt: now, decidedBy: req.user.fullName } : {}),
    ...(direction === 'in' ? { movements: [passes.movement('in', gate, req.user, now)] } : {}),
    photos: photos.length ? photos : undefined,
    createdBy: req.user.id, createdByName: req.user.fullName,
  });
  audit(req.user, direction === 'in' ? 'material.received' : approveNow ? 'material.approved' : 'material.requested', {
    entity: 'Material', entityId: m._id, details: { number: m.number, kind: m.kind, items: m.items.length, ...(approveNow ? { via: 'admin' } : {}) }, ip: req.ip,
  });
  let channel = null;
  if (direction === 'out' && !approveNow) channel = await material.requestApproval(m, approver);
  const fresh = await Material.findById(m._id).populate('approver').lean();
  res.status(201).json({ ...row(fresh, isAdmin(req.user)), approvalSentBy: channel });
});

// ---------- Approval ----------
router.post('/:id/decision', requireRole('admin'), async (req, res) => {
  const m = await load(req, res);
  if (!m) return;
  const r = await material.decide(m, req.body?.decision, { actor: { name: req.user.fullName, audit: req.user }, via: 'admin', note: req.body?.note, ip: req.ip });
  res.status(r.status).json(r.body);
});

router.post('/:id/resend', requireRole('guard', 'admin'), async (req, res) => {
  const m = await load(req, res);
  if (!m) return;
  if (m.status !== 'pending') return res.status(409).json({ error: 'This pass is not waiting for approval' });
  const host = m.approver ? await material.approverFor(m.approver._id) : null;
  if (!host) return res.status(409).json({ error: 'The approver is no longer active. Ask an admin to decide.' });
  const channel = await material.requestApproval(m, host);
  audit(req.user, 'material.resent', { entity: 'Material', entityId: m._id, details: { number: m.number }, ip: req.ip });
  res.json({ ok: true, approvalSentBy: channel });
});

// ---------- At the gate ----------
// Out through the gate: an approved pass, or contractor tools brought in earlier leaving again.
router.post('/:id/let-out', requireRole('guard', 'admin'), async (req, res) => {
  const m = await load(req, res);
  if (!m) return;
  const from = m.kind === 'returnable_in' ? 'received' : 'approved';
  if (m.status !== from) {
    const why = { pending: 'This pass is still waiting for approval. Do not let the material out.', rejected: 'This pass was declined. Do not let the material out.', cancelled: 'This pass was cancelled.' }[m.status];
    return res.status(409).json({ error: why || `This pass is already ${material.STATUS_LABEL[m.status].toLowerCase()}.` });
  }
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const doc = await Material.findOneAndUpdate(
    { _id: m._id, status: from },
    { status: m.kind === 'returnable_in' ? 'closed' : 'out', $push: { movements: passes.movement('out', gate, req.user, now) } },
    { new: true },
  ).populate('approver').lean();
  if (!doc) return res.status(409).json({ error: 'Someone else just updated this pass. Open it again.' });
  audit(req.user, 'material.let_out', { entity: 'Material', entityId: m._id, details: { number: m.number, gate: gate.name }, ip: req.ip });
  res.json(row(doc, isAdmin(req.user)));
});

router.post('/:id/return', requireRole('guard', 'admin'), async (req, res) => {
  const m = await load(req, res);
  if (!m) return;
  const gate = await passes.gateOf(req.user.id);
  const r = await material.recordReturn(m.toObject(), req.body?.items, { gate, user: req.user, note: req.body?.note });
  if (r.error) return res.status(r.error.startsWith('Someone') ? 409 : 400).json({ error: r.error });
  audit(req.user, 'material.returned', { entity: 'Material', entityId: m._id, details: { number: m.number, status: r.m.status, gate: gate.name }, ip: req.ip });
  res.json(row((await Material.findById(m._id).populate('approver').lean()), isAdmin(req.user)));
});

// A delivery handed from the gate to the receiving / stores person.
router.post('/:id/hand-over', requireRole('guard', 'admin'), async (req, res) => {
  const m = await load(req, res);
  if (!m) return;
  const to = cleanText(req.body?.to, 80);
  if (to.length < 2) return res.status(400).json({ error: 'Who took it? Enter their name' });
  const doc = await Material.findOneAndUpdate({ _id: m._id, kind: 'delivery', status: 'received' }, { status: 'handed_over', handedTo: to, handedAt: new Date() }, { new: true }).populate('approver').lean();
  if (!doc) return res.status(409).json({ error: 'Only a delivery still at the gate can be handed over' });
  audit(req.user, 'material.handed_over', { entity: 'Material', entityId: m._id, details: { number: m.number, to }, ip: req.ip });
  res.json(row(doc, isAdmin(req.user)));
});

router.post('/:id/cancel', requireRole('guard', 'admin'), async (req, res) => {
  const m = await load(req, res);
  if (!m) return;
  if (!['pending', 'approved'].includes(m.status)) return res.status(409).json({ error: 'Only a pass that has not gone out can be cancelled' });
  if (!isAdmin(req.user) && String(m.createdBy) !== req.user.id) return res.status(403).json({ error: 'Only the person who raised it or an admin can cancel it' });
  const doc = await Material.findOneAndUpdate({ _id: m._id, status: { $in: ['pending', 'approved'] } }, { status: 'cancelled' }, { new: true }).populate('approver').lean();
  if (!doc) return res.status(409).json({ error: 'This pass just changed. Open it again.' });
  audit(req.user, 'material.cancelled', { entity: 'Material', entityId: m._id, details: { number: m.number }, ip: req.ip });
  res.json(row(doc, isAdmin(req.user)));
});

// ---------- The approver's link (no login: the single-use token is the credential) ----------
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 10 * 60e3, limit: 60, standardHeaders: true, legacyHeaders: false }));
publicRouter.get('/:token', async (req, res) => {
  const found = await material.findByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This link is invalid' });
  const { token, m } = found;
  let state = m.status;
  if (m.status === 'pending' && token.usedAt) state = 'superseded';
  else if (m.status === 'pending' && token.expiresAt < new Date()) state = 'expired';
  res.json({ ...row(m, false), state, approverName: m.approver?.fullName, siteName: (await settings.get()).siteName, expiresAt: token.expiresAt });
});
publicRouter.post('/:token/decision', async (req, res) => {
  const r = await material.decideByToken(req.params.token, req.body?.decision, { ip: req.ip, note: req.body?.note });
  res.status(r.status).json(r.body);
});

module.exports = { router, publicRouter };
