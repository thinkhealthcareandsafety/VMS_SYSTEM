const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');
const config = require('../config');
const { requireRole, isAdmin } = require('../middleware/auth');
const { Group, Guest, Host, Visit, Block } = require('../models');
const settings = require('../services/settings');
const passes = require('../services/passes');
const groups = require('../services/groups');
const { siteDay, audit, cleanText, normalizeMobile } = require('../services/core');

// Groups of expected guests: the admin sets them up, any gate lets the guests in.
const router = express.Router();
const isId = (v) => mongoose.isValidObjectId(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// How many are on the list, have come, and are inside right now, per group.
async function countsFor(ids) {
  const [listed, inside] = await Promise.all([
    Guest.aggregate([
      { $match: { group: { $in: ids }, removedAt: { $exists: false } } },
      { $group: { _id: '$group', guests: { $sum: 1 }, arrived: { $sum: { $cond: [{ $ifNull: ['$arrivedAt', false] }, 1, 0] } }, joined: { $sum: { $cond: ['$selfRegistered', 1, 0] } } } },
    ]),
    Visit.aggregate([{ $match: { group: { $in: ids }, status: 'approved' } }, { $group: { _id: '$group', n: { $sum: 1 } } }]),
  ]);
  const map = new Map(ids.map((id) => [String(id), { guests: 0, arrived: 0, inside: 0, joined: 0 }]));
  for (const r of listed) Object.assign(map.get(String(r._id)), { guests: r.guests, arrived: r.arrived, joined: r.joined });
  for (const r of inside) map.get(String(r._id)).inside = r.n;
  return map;
}

const groupRow = (g, counts, admin = false) => ({
  id: String(g._id), name: g.name, purpose: g.purpose, note: g.note, startDay: g.startDay, endDay: g.endDay,
  days: groups.dayRange(g), allowWalkIns: g.allowWalkIns, status: g.status,
  ...(admin ? { joinOpen: Boolean(g.joinOpen && g.joinCode), joinLimit: g.joinLimit || 0, joinLink: g.joinCode ? `${config.appBaseUrl}/join/${g.joinCode}` : null } : {}),
  host: g.host?.fullName ? { id: String(g.host._id), name: g.host.fullName, unit: g.host.unit } : null,
  today: g.startDay <= siteDay() && siteDay() <= g.endDay,
  ...(counts || { guests: 0, arrived: 0, inside: 0 }),
});

// Guest as the gate sees it: the mobile shows only its last 4 digits. The admin sees everything.
function guestRow(g, visit, admin) {
  const status = !visit ? 'expected' : visit.status === 'approved' ? 'inside' : visit.status === 'away' ? 'out' : 'left';
  const ee = visit ? passes.entryExit(visit) : {};
  return {
    id: String(g._id), firstName: g.firstName, lastName: g.lastName, company: g.company, status,
    mobileEnd: g.mobile ? g.mobile.slice(-4) : null, addedAtGate: g.addedAtGate, arrivedAt: g.arrivedAt || null,
    visitId: visit ? String(visit._id) : null, dailyNumber: visit?.dailyNumber ?? null,
    lastIn: ee.lastIn || null, exit: ee.exit || null,
    ...(admin ? { mobile: g.mobile || null, code: groups.showCode(g.code), link: groups.passUrl(g.code), removed: Boolean(g.removedAt), selfRegistered: Boolean(g.selfRegistered) } : {}),
  };
}

async function loadGroup(req, res) {
  if (!isId(req.params.id)) { res.status(404).json({ error: 'Not found' }); return null; }
  const g = await Group.findById(req.params.id).populate('host').lean();
  if (!g) { res.status(404).json({ error: 'Not found' }); return null; }
  return g;
}

function validateGroup(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = cleanText(b.name, 80);
    if (out.name.length < 2) return { error: 'Give the group a name, e.g. "Sharma wedding, Grand Ballroom"' };
  }
  if (!partial || b.startDay !== undefined || b.endDay !== undefined) {
    const start = String(b.startDay || ''), end = String(b.endDay || b.startDay || '');
    if (!DAY_RE.test(start) || !DAY_RE.test(end)) return { error: 'Pick the first and last day' };
    if (end < start) return { error: 'The last day cannot be before the first day' };
    if (passes.addDays(start, passes.MAX_DAYS) < end) return { error: `A group can run for at most ${passes.MAX_DAYS} days` };
    if (!partial && end < siteDay()) return { error: 'The last day is already over' };
    Object.assign(out, { startDay: start, endDay: end });
  }
  if (b.purpose !== undefined) out.purpose = cleanText(b.purpose, 80);
  if (b.note !== undefined) out.note = cleanText(b.note, 300);
  if (b.allowWalkIns !== undefined) out.allowWalkIns = b.allowWalkIns === true;
  return { patch: out };
}

// ---------- Lists ----------
// scope=today: groups a gate can let in today (guards and admins). Otherwise every group (admins).
router.get('/', requireRole('guard', 'admin'), async (req, res) => {
  const today = siteDay();
  const admin = isAdmin(req.user);
  if (req.query.scope !== 'today' && !admin) return res.status(403).json({ error: 'Not allowed for this role' });
  const q = req.query.scope === 'today' ? { status: 'active', startDay: { $lte: today }, endDay: { $gte: today } } : {};
  const rows = await Group.find(q).sort({ startDay: -1, createdAt: -1 }).limit(300).populate('host').lean();
  const counts = await countsFor(rows.map((g) => g._id));
  res.json({ rows: rows.map((g) => groupRow(g, counts.get(String(g._id)), admin)) });
});

// A ready-made sheet to fill in.
router.get('/template.xlsx', requireRole('admin'), async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Guests');
  ws.columns = [{ header: 'Name', key: 'n', width: 28 }, { header: 'Mobile', key: 'm', width: 16 }, { header: 'Company', key: 'c', width: 26 }];
  ws.addRow({ n: 'Ravi Kumar', m: '98765 43210', c: 'Groom side' });
  ws.addRow({ n: 'Anita Desai', m: '', c: 'Infosys' });
  ws.getRow(1).font = { bold: true };
  ws.getColumn('m').numFmt = '@';
  res.type(XLSX).attachment('guest list template.xlsx').send(Buffer.from(await wb.xlsx.writeBuffer()));
});

router.post('/', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const { error, patch } = validateGroup(b);
  if (error) return res.status(400).json({ error });
  if (!isId(b.hostId)) return res.status(400).json({ error: 'Pick the host responsible for this group' });
  const host = await Host.findOne({ _id: b.hostId, active: true }).lean();
  if (!host) return res.status(400).json({ error: 'That host is not active' });
  const g = await Group.create({ ...patch, host: host._id, createdBy: req.user.id });
  audit(req.user, 'group.created', { entity: 'Group', entityId: g._id, details: { name: g.name, days: groups.dayRange(g), host: host.fullName } });
  res.status(201).json(groupRow({ ...g.toObject(), host }, null, true));
});

router.get('/:id', requireRole('guard', 'admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  const counts = await countsFor([g._id]);
  res.json(groupRow(g, counts.get(String(g._id)), isAdmin(req.user)));
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  const b = req.body || {};
  const { error, patch } = validateGroup(b, { partial: true });
  if (error) return res.status(400).json({ error });
  if (b.hostId !== undefined) {
    const host = isId(b.hostId) ? await Host.findOne({ _id: b.hostId, active: true }).lean() : null;
    if (!host) return res.status(400).json({ error: 'That host is not active' });
    patch.host = host._id;
  }
  if (b.status !== undefined) {
    if (!['active', 'cancelled'].includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
    patch.status = b.status;
  }
  if (b.joinLimit !== undefined) {
    const n = Number(b.joinLimit);
    if (!Number.isInteger(n) || n < 1 || n > groups.MAX_GUESTS) return res.status(400).json({ error: `Allow between 1 and ${groups.MAX_GUESTS} guests to add themselves` });
    patch.joinLimit = n;
  }
  if (b.joinOpen !== undefined) {
    patch.joinOpen = b.joinOpen === true;
    if (patch.joinOpen && !(patch.joinLimit || g.joinLimit)) return res.status(400).json({ error: 'Set how many guests may add themselves' });
    if (patch.joinOpen && !g.joinCode) patch.joinCode = groups.newCode() + groups.newCode().slice(0, 2);
  }
  // A new link: the old one stops working at once (it was forwarded too widely).
  if (b.newJoinLink === true) patch.joinCode = groups.newCode() + groups.newCode().slice(0, 2);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
  await Group.updateOne({ _id: g._id }, { $set: patch });
  audit(req.user, patch.status === 'cancelled' ? 'group.cancelled' : 'group.updated', { entity: 'Group', entityId: g._id, details: { name: patch.name || g.name, changed: Object.keys(patch).join(', ') } });
  const fresh = await Group.findById(g._id).populate('host').lean();
  res.json(groupRow(fresh, (await countsFor([g._id])).get(String(g._id)), true));
});

// ---------- Guests ----------
router.get('/:id/guests', requireRole('guard', 'admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  const admin = isAdmin(req.user);
  const q = { group: g._id, ...(admin && req.query.removed === '1' ? {} : { removedAt: { $exists: false } }) };
  const term = cleanText(req.query.q, 60);
  if (term) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const digits = term.replace(/\D/g, '');
    const code = groups.readCode(term);
    q.$or = [{ firstName: re }, { lastName: re }, { company: re }, ...(digits.length >= 3 ? [{ mobile: new RegExp(`${digits}$`) }] : []), ...(code ? [{ code }] : [])];
  }
  const list = await Guest.find(q).sort({ firstName: 1, lastName: 1 }).limit(admin ? 2000 : 200).lean();
  const visits = await Visit.find({ _id: { $in: list.map((x) => x.visit).filter(Boolean) } }).lean();
  const byId = new Map(visits.map((v) => [String(v._id), v]));
  res.json({ rows: list.map((x) => guestRow(x, x.visit ? byId.get(String(x.visit)) : null, admin)) });
});

// Add guests: an uploaded sheet (file: base64 .xlsx or .csv), pasted text, or a list.
router.post('/:id/guests', requireRole('admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  const b = req.body || {};
  let entries;
  try {
    entries = Array.isArray(b.guests)
      ? b.guests.map((x, i) => ({ line: i + 1, full: cleanText(x.name, 120), mobileRaw: cleanText(x.mobile, 30), company: cleanText(x.company, 120) }))
      : await groups.readList({ text: b.text, file: b.file, filename: b.filename });
  } catch (e) {
    return res.status(400).json({ error: e.message === 'The file is larger than 5 MB' ? e.message : 'That file could not be read. Save it as .xlsx or .csv and try again.' });
  }
  if (!entries.length) return res.status(400).json({ error: 'No guests found. The sheet needs a Name column (and Mobile if you have it).' });
  try {
    res.json(await groups.addGuests(g, entries, req.user));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id/guests/:guestId', requireRole('admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g || !isId(req.params.guestId)) return g && res.status(404).json({ error: 'Not found' });
  const guest = await Guest.findOne({ _id: req.params.guestId, group: g._id });
  if (!guest) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.remove === true) guest.removedAt = new Date();
  if (b.restore === true) guest.removedAt = undefined;
  if (b.name !== undefined) {
    const full = cleanText(b.name, 120);
    if (!groups.NAME_RE.test(full)) return res.status(400).json({ error: 'Enter a valid name' });
    Object.assign(guest, groups.splitName(full));
  }
  if (b.mobile !== undefined) {
    const m = b.mobile ? normalizeMobile(b.mobile) : null;
    if (b.mobile && !m) return res.status(400).json({ error: 'That mobile number is not valid' });
    if (m && (await Guest.exists({ group: g._id, mobile: m, _id: { $ne: guest._id }, removedAt: { $exists: false } }))) {
      return res.status(409).json({ error: 'Someone on this list already has that number' });
    }
    guest.mobile = m || undefined;
  }
  if (b.company !== undefined) guest.company = cleanText(b.company, 120);
  await guest.save();
  audit(req.user, b.remove ? 'group.guest_removed' : 'group.guest_updated', { entity: 'Group', entityId: g._id, details: { guest: `${guest.firstName} ${guest.lastName}`.trim() } });
  res.json(guestRow(guest.toObject(), null, true));
});

// The list with every pass link (to forward on WhatsApp) and who came, in Excel.
router.get('/:id/guests.xlsx', requireRole('admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  const list = await Guest.find({ group: g._id, removedAt: { $exists: false } }).sort({ firstName: 1 }).lean();
  const visits = new Map((await Visit.find({ _id: { $in: list.map((x) => x.visit).filter(Boolean) } }).lean()).map((v) => [String(v._id), v]));
  const label = { expected: 'Not arrived', inside: 'Inside', out: 'Out (pass valid)', left: 'Left' };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Guests', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Name', key: 'name', width: 26 }, { header: 'Mobile', key: 'mobile', width: 15 }, { header: 'Company', key: 'company', width: 22 },
    { header: 'Pass code', key: 'code', width: 12 }, { header: 'Pass link', key: 'link', width: 42 }, { header: 'Status', key: 'status', width: 16 },
    { header: 'Arrived', key: 'arrived', width: 18 }, { header: 'Gate', key: 'gate', width: 16 }, { header: 'Added at gate', key: 'walkin', width: 13 },
  ];
  const fmt = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
  for (const x of list) {
    const v = x.visit ? visits.get(String(x.visit)) : null;
    const row = guestRow(x, v, true);
    ws.addRow({
      name: `${x.firstName} ${x.lastName}`.trim(), mobile: x.mobile ? x.mobile.replace(/^\+91/, '') : '', company: x.company,
      code: row.code, link: { text: row.link, hyperlink: row.link }, status: label[row.status], arrived: fmt(x.arrivedAt),
      gate: v ? passes.entryExit(v).entry?.gate || '' : '', walkin: x.addedAtGate ? 'Yes' : '',
    });
  }
  ws.getRow(1).font = { bold: true };
  audit(req.user, 'group.list_downloaded', { entity: 'Group', entityId: g._id, details: { name: g.name, rows: list.length } });
  res.type(XLSX).attachment(`${g.name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 50)} guests.xlsx`).send(Buffer.from(await wb.xlsx.writeBuffer()));
});

// End of the event: everyone of this group still inside is checked out at once.
router.post('/:id/checkout-all', requireRole('admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  // Inside: out now, at this admin's gate. Out on a multi-day pass: the pass just closes.
  const inside = await Visit.updateMany(
    { group: g._id, status: 'approved' },
    { $set: { status: 'checked_out', checkedOutAt: now, checkedOutBy: req.user.id }, $push: { movements: passes.movement('out', gate, req.user, now) } },
  );
  const away = await Visit.updateMany({ group: g._id, status: 'away' }, { $set: { status: 'checked_out', checkedOutAt: now, checkedOutBy: req.user.id } });
  audit(req.user, 'group.checked_out_all', { entity: 'Group', entityId: g._id, details: { name: g.name, visitors: inside.modifiedCount, passesClosed: away.modifiedCount } });
  res.json({ ok: true, checkedOut: inside.modifiedCount, passesClosed: away.modifiedCount });
});

// ---------- At the gate ----------
const admitReply = async (outcome, guest, group) => ({
  ...outcome,
  ok: ['let_in', 'reentered'].includes(outcome.result),
  guest: { id: String(guest._id), name: `${guest.firstName} ${guest.lastName}`.trim(), company: guest.company },
  group: { id: String(group._id), name: group.name },
  visit: outcome.visit ? { id: String(outcome.visit._id), dailyNumber: outcome.visit.dailyNumber, validUntil: outcome.visit.validUntil } : null,
});

// A scanned pass (QR, scanner gun) or a typed code.
router.post('/scan', requireRole('guard', 'admin'), async (req, res) => {
  const code = groups.readCode(req.body?.code);
  if (!code) return res.status(400).json({ result: 'unknown', ok: false, message: 'That is not a guest pass. Check the code, or check them in as a visitor.' });
  const guest = await Guest.findOne({ code }).lean();
  const group = guest ? await Group.findById(guest.group).lean() : null;
  if (!guest || !group) return res.status(404).json({ result: 'unknown', ok: false, message: 'No guest has this pass. Check them in as a visitor instead.' });
  res.json(await admitReply(await groups.admit(guest, group, req.user), guest, group));
});

router.post('/:id/guests/:guestId/admit', requireRole('guard', 'admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g || !isId(req.params.guestId)) return g && res.status(404).json({ error: 'Not found' });
  const guest = await Guest.findOne({ _id: req.params.guestId, group: g._id }).lean();
  if (!guest) return res.status(404).json({ error: 'Not found' });
  res.json(await admitReply(await groups.admit(guest, g, req.user), guest, g));
});

// Several at once (a family, a team): one by one, so each gets its own pass and record.
router.post('/:id/admit-many', requireRole('guard', 'admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(isId).slice(0, 100);
  if (!ids.length) return res.status(400).json({ error: 'Pick the guests to let in' });
  const list = await Guest.find({ _id: { $in: ids }, group: g._id }).lean();
  const results = [];
  for (const guest of list) results.push(await admitReply(await groups.admit(guest, g, req.user), guest, g));
  res.json({ results, letIn: results.filter((r) => r.ok).length });
});

// Someone not on the list, when the admin allowed walk-ins for this group.
router.post('/:id/walk-in', requireRole('guard', 'admin'), async (req, res) => {
  const g = await loadGroup(req, res);
  if (!g) return;
  if (!g.allowWalkIns && !isAdmin(req.user)) return res.status(403).json({ error: 'Walk-ins are not allowed for this group. Check them in as a visitor and send the request to the host.' });
  const full = cleanText(req.body?.name, 120);
  if (!groups.NAME_RE.test(full)) return res.status(400).json({ error: 'Enter the guest’s name' });
  const mobile = req.body?.mobile ? normalizeMobile(req.body.mobile) : null;
  if (req.body?.mobile && !mobile) return res.status(400).json({ error: 'That mobile number is not valid' });
  if (mobile) {
    const same = await Guest.findOne({ group: g._id, mobile, removedAt: { $exists: false } }).lean();
    if (same) return res.json(await admitReply(await groups.admit(same, g, req.user), same, g));
  }
  const guest = await Guest.create({
    group: g._id, ...groups.splitName(full), mobile: mobile || undefined, company: cleanText(req.body?.company, 120),
    code: groups.newCode(), addedAtGate: true, createdBy: req.user.id,
  });
  audit(req.user, 'group.walk_in', { entity: 'Group', entityId: g._id, details: { name: g.name, guest: full } });
  res.status(201).json(await admitReply(await groups.admit(guest.toObject(), g, req.user), guest, g));
});

// ---------- The guest's own pass page (no login: the code is the pass) ----------
const publicRouter = express.Router();
publicRouter.use(rateLimit({ windowMs: 10 * 60e3, limit: 120, standardHeaders: true, legacyHeaders: false }));
// The group's shared link: guests add themselves. The link can be capped, closed or replaced by the admin;
// a number already on the list is never given that guest's pass, so a link cannot be used to copy someone's pass.
const joinLimiter = rateLimit({ windowMs: 10 * 60e3, limit: 20, standardHeaders: true, legacyHeaders: false });
const JOIN_RE = /^[A-Z0-9]{10}$/;
async function joinGroup(code) {
  const c = String(code || '').toUpperCase();
  if (!JOIN_RE.test(c)) return null;
  return Group.findOne({ joinCode: c }).lean();
}
async function joinState(g) {
  if (!g || g.status === 'cancelled' || !g.joinOpen) return 'closed';
  if (siteDay() > g.endDay) return 'over';
  return (g.joinCount || 0) >= (g.joinLimit || 0) ? 'full' : 'open';
}
publicRouter.get('/join/:code', async (req, res) => {
  const g = await joinGroup(req.params.code);
  if (!g) return res.status(404).json({ error: 'This link is not valid' });
  res.json({ group: g.name, days: groups.dayRange(g), state: await joinState(g), siteName: (await settings.get()).siteName });
});
publicRouter.post('/join/:code', joinLimiter, async (req, res) => {
  const g = await joinGroup(req.params.code);
  if (!g) return res.status(404).json({ error: 'This link is not valid' });
  const state = await joinState(g);
  if (state !== 'open') {
    return res.status(409).json({ error: { closed: 'This link is closed. Ask the host for your pass.', over: 'This event is over.', full: 'All places on this link are taken. Ask the host for your pass.' }[state] });
  }
  const full = cleanText(req.body?.name, 120);
  if (!groups.NAME_RE.test(full) || full.length < 2) return res.status(400).json({ error: 'Enter your full name' });
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number' });
  if (await Guest.exists({ group: g._id, mobile, removedAt: { $exists: false } })) {
    return res.status(409).json({ error: 'This number is already on the guest list. Use the pass you were sent, or ask the host.' });
  }
  if (await Block.exists({ mobile, active: true })) {
    audit({ label: 'public' }, 'group.join_refused', { entity: 'Group', entityId: g._id, details: { name: g.name, mobile, why: 'blocked' }, ip: req.ip });
    return res.status(403).json({ error: 'We could not add you to this list. Please contact the host.' });
  }
  // Reserve a place first: many people opening the link at once can never go past the limit.
  const seat = await Group.findOneAndUpdate(
    { _id: g._id, joinOpen: true, status: 'active', $expr: { $lt: [{ $ifNull: ['$joinCount', 0] }, '$joinLimit'] } },
    { $inc: { joinCount: 1 } },
  );
  if (!seat) return res.status(409).json({ error: 'All places on this link are taken. Ask the host for your pass.' });
  let guest;
  try {
    guest = await Guest.create({ group: g._id, ...groups.splitName(full), mobile, company: cleanText(req.body?.company, 120), code: groups.newCode(), selfRegistered: true });
  } catch (e) {
    await Group.updateOne({ _id: g._id }, { $inc: { joinCount: -1 } });
    throw e;
  }
  audit({ label: 'public' }, 'group.self_registered', { entity: 'Group', entityId: g._id, details: { name: g.name, guest: full }, ip: req.ip });
  res.status(201).json({ code: guest.code });
});

publicRouter.get('/:code', async (req, res) => {
  const code = groups.readCode(req.params.code);
  const guest = code ? await Guest.findOne({ code }).lean() : null;
  const group = guest ? await Group.findById(guest.group).lean() : null;
  if (!guest || !group) return res.status(404).json({ error: 'This pass is not valid' });
  const today = siteDay();
  const state = guest.removedAt || group.status === 'cancelled' ? 'invalid' : today > group.endDay ? 'over' : today < group.startDay ? 'upcoming' : 'valid';
  res.json({
    name: `${guest.firstName} ${guest.lastName}`.trim(), group: group.name, days: groups.dayRange(group),
    code: groups.showCode(guest.code), state, siteName: (await settings.get()).siteName,
  });
});

module.exports = { router, publicRouter };
