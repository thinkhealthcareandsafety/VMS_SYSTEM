const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const archiver = require('archiver');
const config = require('../config');
const { requireRole } = require('../middleware/auth');
const { Visit, Host, Outbox, Audit, User } = require('../models');
const { siteDay, audit, normalizeMobile, cleanText, passwordProblem } = require('../services/core');

const router = express.Router();
const dayStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const esc = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// Shared search for history + CSV. Filters: from, to, host, company, name, status.
async function searchVisits(query, { page = 1, limit = 50 } = {}) {
  const from = dayStr.safeParse(query.from), to = dayStr.safeParse(query.to);
  const q = {};
  if (from.success && from.data) q.visitDay = { ...(q.visitDay || {}), $gte: from.data };
  if (to.success && to.data) q.visitDay = { ...(q.visitDay || {}), $lte: to.data };
  if (query.status) q.status = String(query.status);
  if (query.company) q.company = new RegExp(esc(cleanText(query.company, 100)), 'i');
  if (query.name) {
    const re = new RegExp(esc(cleanText(query.name, 100)), 'i');
    const digits = String(query.name).replace(/\D/g, '');
    q.$or = [{ firstName: re }, { lastName: re }, { ref: re }, ...(digits.length >= 4 ? [{ mobile: new RegExp(esc(digits)) }] : [])];
  }
  if (query.host) {
    const hosts = await Host.find({ fullName: new RegExp(esc(cleanText(query.host, 100)), 'i') }, '_id').lean();
    q.host = { $in: hosts.map((h) => h._id) };
  }
  const [total, visits] = await Promise.all([
    Visit.countDocuments(q),
    Visit.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('host').lean(),
  ]);
  return {
    total, page, limit, docs: visits,
    rows: visits.map((v) => ({
      id: String(v._id), ref: v.ref, name: `${v.firstName} ${v.lastName}`, mobile: v.mobile, company: v.company,
      purpose: v.purpose, host: v.host?.fullName, unit: v.host?.unit, status: v.status,
      dailyNumber: v.dailyNumber ?? null, dailyDay: v.dailyDay ?? null, visitDay: v.visitDay,
      createdAt: v.createdAt, decidedAt: v.decidedAt, checkedOutAt: v.checkedOutAt, forceReason: v.forceReason,
      hasIdImage: Boolean(v.idImagePath),
    })),
  };
}

router.get('/visits', requireRole('admin'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const { docs, ...result } = await searchVisits(req.query, { page, limit }); // eslint-disable-line no-unused-vars
  res.json(result);
});

// ----- Export: one sheet builder shared by the CSV and the ZIP, so both always match -----
const EXPORT_LIMIT = 50000;
const STATUS_LABEL = {
  pending: 'Awaiting host', approved: 'On premises', rejected: 'Declined', expired: 'No response',
  cancelled: 'Cancelled', checked_out: 'Checked out', force_checked_out: 'Force checked out',
};
const localStamp = (d) => (d ? new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(d)).replace(',', '') : '');
const safeName = (s) => String(s).replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60);
const photoFile = (v) => `photos/${v.ref} ${safeName(`${v.firstName} ${v.lastName}`)}.jpg`;
const exportName = (q, ext) => `visitors ${q.from || 'start'} to ${q.to || siteDay()}.${ext}`;
// Excel turns "+9180..." into 9.18E+11, so Indian numbers go out as "80104 77969" under a "(+91)" header.
const sheetMobile = (m = '') => (m.startsWith(config.defaultCountryCode) ? m.slice(config.defaultCountryCode.length).replace(/^(\d{5})(\d{5})$/, '$1 $2') : m.replace(/^\+/, ''));
// A cell starting with = + - @ runs as a formula in Excel (CSV injection); a leading apostrophe keeps it text.
const sheetCell = (v) => csvCell(/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v);

// Excel reads UTF-8 CSV correctly only with a BOM; CRLF keeps Excel and Notepad happy.
function visitsSheet(docs) {
  const header = ['Visitor ID', 'Date', 'Pass no', 'First name', 'Last name', `Mobile (${config.defaultCountryCode})`, 'Company', 'Purpose', 'Host', 'Flat / dept',
    'Status', 'Arrived', 'Let in', 'Left', 'Minutes inside', 'Force checkout reason', 'Photo file'];
  const lines = docs.map((v) => {
    const admitted = ['approved', 'checked_out', 'force_checked_out'].includes(v.status);
    const end = v.checkedOutAt ? new Date(v.checkedOutAt) : v.status === 'approved' ? new Date() : null;
    const mins = admitted && v.decidedAt && end ? Math.round((end - new Date(v.decidedAt)) / 60000) : '';
    return [v.ref, v.visitDay, v.dailyNumber ?? '', v.firstName, v.lastName, sheetMobile(v.mobile), v.company, v.purpose, v.host?.fullName, v.host?.unit,
      STATUS_LABEL[v.status] || v.status, localStamp(v.createdAt), admitted ? localStamp(v.decidedAt) : '', localStamp(v.checkedOutAt),
      mins, v.forceReason, v.photoPath ? photoFile(v) : ''].map(sheetCell).join(',');
  });
  return `﻿${[header.map(sheetCell).join(','), ...lines].join('\r\n')}\r\n`;
}

router.get('/visits.csv', requireRole('admin'), async (req, res) => {
  const { docs } = await searchVisits(req.query, { page: 1, limit: EXPORT_LIMIT });
  audit(req.user, 'export.visits_csv', { details: { rows: docs.length, from: req.query.from, to: req.query.to }, ip: req.ip });
  res.type('text/csv; charset=utf-8').attachment(exportName(req.query, 'csv')).send(visitsSheet(docs));
});

// Full backup: the same sheet plus every visitor photo, streamed as a ZIP (never held in memory).
// Aadhaar images are deliberately left out: they are purged on a schedule and every view is audited.
router.get('/visits.zip', requireRole('admin'), async (req, res) => {
  const { docs } = await searchVisits(req.query, { page: 1, limit: EXPORT_LIMIT });
  audit(req.user, 'export.visits_zip', { details: { rows: docs.length, from: req.query.from, to: req.query.to }, ip: req.ip });
  res.type('application/zip').attachment(exportName(req.query, 'zip'));
  const zip = archiver('zip', { zlib: { level: 1 } }); // JPEGs barely compress; favour speed
  zip.on('error', (err) => { console.error('export zip:', err.message); res.destroy(err); });
  zip.pipe(res);
  zip.append(visitsSheet(docs), { name: 'visitors.csv' });
  for (const v of docs) {
    const file = v.photoPath && path.resolve(v.photoPath);
    if (file && fs.existsSync(file)) zip.file(file, { name: photoFile(v) });
  }
  await zip.finalize();
});

// Everything that happened to one visit, oldest first (detail drawer timeline).
router.get('/visits/:id/timeline', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const rows = await Audit.find({ entity: 'Visit', entityId: req.params.id }).sort({ at: 1 }).lean();
  res.json({ rows: rows.map((r) => ({ at: r.at, actor: r.actor, role: r.actorRole, action: r.action, details: r.details })) });
});

router.get('/stats', requireRole('admin'), async (req, res) => {
  const today = siteDay();
  const [inside, pending, checkedOutToday, forceToday, printFailed, smsFailed, staleCut] = await Promise.all([
    Visit.countDocuments({ status: 'approved' }),
    Visit.countDocuments({ status: 'pending' }),
    Visit.countDocuments({ visitDay: today, status: 'checked_out' }),
    Visit.countDocuments({ visitDay: today, status: 'force_checked_out' }),
    Outbox.countDocuments({ kind: 'print', status: 'failed' }),
    Outbox.countDocuments({ kind: 'sms', status: 'failed' }),
    Visit.countDocuments({ status: 'approved', decidedAt: { $lt: new Date(Date.now() - config.maxInsideHours * 3600e3) } }),
  ]);
  const arrivals = await Visit.find({ visitDay: today }, 'createdAt').lean();
  const byHour = Array(24).fill(0);
  for (const a of arrivals) {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hourCycle: 'h23' }).format(a.createdAt));
    byHour[h] += 1;
  }
  res.json({
    today, inside, pending, checkedOutToday, forceToday, printFailed, smsFailed, staleInside: staleCut, arrivalsToday: arrivals.length, byHour,
    // So the console can say plainly when SMS are only logged, or no sticker printer is connected.
    smsLive: config.sms.driver !== 'console', printerOn: config.printer.mode !== 'off',
  });
});

// Force checkout lives in routes/visits.js; this is the admin list of stale "still inside" visitors.
router.get('/stale', requireRole('admin'), async (req, res) => {
  const cut = new Date(Date.now() - config.maxInsideHours * 3600e3);
  const rows = await Visit.find({ status: 'approved', decidedAt: { $lt: cut } }).populate('host').lean();
  res.json({ rows: rows.map((v) => ({ id: String(v._id), ref: v.ref, name: `${v.firstName} ${v.lastName}`, host: v.host?.fullName, decidedAt: v.decidedAt })) });
});

router.get('/outbox', requireRole('admin'), async (req, res) => {
  const kind = req.query.kind === 'print' ? 'print' : 'sms';
  const rows = await Outbox.find({ kind }).sort({ _id: -1 }).limit(100).populate('visit', 'ref').lean();
  res.json({ rows: rows.map((o) => ({ id: String(o._id), ref: o.visit?.ref, status: o.status, attempts: o.attempts, lastError: o.lastError, to: o.kind === 'sms' ? o.to : undefined, body: o.kind === 'sms' ? o.body : undefined, createdAt: o.createdAt, sentAt: o.sentAt })) });
});

router.get('/audit', requireRole('admin'), async (req, res) => {
  const filter = req.query.action ? { action: new RegExp(esc(cleanText(req.query.action, 60))) } : {};
  const rows = await Audit.find(filter).sort({ _id: -1 }).limit(300).lean();
  res.json({ rows });
});

// ----- Hosts (resident / employee directory) -----
const hostSchema = z.object({
  fullName: z.string().min(2).max(80),
  unit: z.string().min(1).max(40),
  mobile: z.string().min(10).max(16),
  email: z.string().email().max(120).optional().or(z.literal('')),
});

router.get('/hosts', requireRole('admin'), async (req, res) => {
  const hosts = await Host.find().sort({ fullName: 1 }).lean();
  res.json({ rows: hosts.map((h) => ({ id: String(h._id), fullName: h.fullName, unit: h.unit, mobile: h.mobile, email: h.email, active: h.active })) });
});

router.post('/hosts', requireRole('admin'), async (req, res) => {
  const parsed = hostSchema.safeParse(req.body);
  const mobile = parsed.success ? normalizeMobile(parsed.data.mobile) : null;
  if (!parsed.success) return res.status(400).json({ error: 'Enter the name, flat and a mobile number' });
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number (Indian mobiles start with 6 to 9)' });
  const host = await Host.create({ ...parsed.data, mobile, email: parsed.data.email || undefined });
  audit(req.user, 'host.created', { entity: 'Host', entityId: host._id, details: { unit: host.unit }, ip: req.ip });
  res.status(201).json({ id: String(host._id) });
});

router.patch('/hosts/:id', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const allowed = {};
  const b = req.body || {};
  if (typeof b.active === 'boolean') allowed.active = b.active;
  if (b.fullName !== undefined) {
    const fullName = cleanText(b.fullName, 80);
    if (fullName.length < 2) return res.status(400).json({ error: 'Enter the host\'s full name' });
    allowed.fullName = fullName;
  }
  if (b.unit !== undefined) {
    const unit = cleanText(b.unit, 40);
    if (!unit) return res.status(400).json({ error: 'Enter the flat or department' });
    allowed.unit = unit;
  }
  if (b.mobile !== undefined) {
    const m = normalizeMobile(b.mobile);
    if (!m) return res.status(400).json({ error: 'Enter a valid mobile number (Indian mobiles start with 6 to 9)' });
    allowed.mobile = m;
  }
  const unset = {};
  if (b.email !== undefined) {
    const email = String(b.email || '').trim().toLowerCase();
    if (email && !z.string().email().safeParse(email).success) return res.status(400).json({ error: 'Enter a valid email, or leave it empty' });
    if (email) allowed.email = email; else unset.email = 1;
  }
  const host = await Host.findByIdAndUpdate(req.params.id, { $set: allowed, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true });
  if (!host) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'host.updated', { entity: 'Host', entityId: host._id, details: allowed, ip: req.ip });
  res.json({ ok: true });
});

// Bulk import: CSV lines "full name,unit,mobile[,email]". Returns per-line errors.
router.post('/hosts/import', requireRole('admin'), async (req, res) => {
  const lines = String(req.body?.csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 5000) return res.status(400).json({ error: 'Provide 1 to 5000 lines' });
  const errors = [];
  const docs = [];
  lines.forEach((line, i) => {
    const [fullName, unit, mobile, email] = line.split(',').map((s) => s.trim());
    const m = normalizeMobile(mobile);
    if (!fullName || !unit || !m) errors.push({ line: i + 1, error: 'Expected: name,unit,mobile' });
    else docs.push({ fullName, unit, mobile: m, email: email || undefined });
  });
  const result = docs.length ? await Host.insertMany(docs) : [];
  audit(req.user, 'host.imported', { details: { created: result.length, errors: errors.length }, ip: req.ip });
  res.json({ created: result.length, errors });
});

// ----- Staff accounts: guards and admins -----
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
// No look-alike characters (0/O, 1/l/I), so a guard can read a reset password off paper.
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genPassword = () => Array.from(crypto.randomBytes(14)).map((b) => PW_ALPHABET[b % PW_ALPHABET.length]).join('');
const staffRow = (u) => ({
  id: String(u._id), username: u.username, fullName: u.fullName, role: u.role, active: u.active,
  lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt || null,
});

router.get('/users', requireRole('admin'), async (req, res) => {
  const users = await User.find().sort({ active: -1, role: 1, fullName: 1 }).lean();
  res.json({ rows: users.map(staffRow) });
});

router.post('/users', requireRole('admin'), async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const fullName = cleanText(req.body?.fullName, 80);
  const { role } = req.body || {};
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3 to 30 lowercase letters or numbers (dot, dash and underscore allowed)' });
  if (fullName.length < 2) return res.status(400).json({ error: "Enter the person's full name" });
  if (!['guard', 'admin'].includes(role)) return res.status(400).json({ error: 'Choose guard or admin' });
  if (await User.exists({ username })) return res.status(409).json({ error: `The username "${username}" is already taken` });
  const typed = typeof req.body?.password === 'string' && req.body.password.length > 0;
  const password = typed ? req.body.password : genPassword();
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  const user = await User.create({ username, fullName, role, passwordHash: await bcrypt.hash(password, 12) });
  audit(req.user, 'user.created', { entity: 'User', entityId: user._id, details: { username, role }, ip: req.ip });
  res.status(201).json({ ...staffRow(user.toObject()), password: typed ? undefined : password });
});

// Edit name/role, switch access on or off, or issue a new password. A reset signs the person out everywhere.
router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const self = String(user._id) === req.user.id;
  const b = req.body || {};
  const changes = {};

  if (b.fullName !== undefined) {
    const fullName = cleanText(b.fullName, 80);
    if (fullName.length < 2) return res.status(400).json({ error: "Enter the person's full name" });
    changes.fullName = fullName;
  }
  if (b.role !== undefined) {
    if (!['guard', 'admin'].includes(b.role)) return res.status(400).json({ error: 'Choose guard or admin' });
    if (self && b.role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin access' });
    changes.role = b.role;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return res.status(400).json({ error: 'Invalid value' });
    if (self && !b.active) return res.status(400).json({ error: 'You cannot switch off your own account' });
    changes.active = b.active;
  }
  // Never leave the site without an active admin.
  const losesAdmin = user.role === 'admin' && user.active && (changes.role === 'guard' || changes.active === false);
  if (losesAdmin && (await User.countDocuments({ role: 'admin', active: true, _id: { $ne: user._id } })) === 0) {
    return res.status(400).json({ error: 'Keep at least one active admin' });
  }

  let password;
  if (b.resetPassword === true) {
    password = genPassword();
    changes.passwordHash = await bcrypt.hash(password, 12);
    changes.sessionVersion = (user.sessionVersion || 0) + 1;
  }
  Object.assign(user, changes);
  await user.save();
  const logged = Object.keys(changes).filter((k) => k !== 'passwordHash' && k !== 'sessionVersion');
  audit(req.user, password ? 'user.password_reset' : 'user.updated', { entity: 'User', entityId: user._id, details: { username: user.username, ...(logged.length ? { changed: logged.join(', ') } : {}) }, ip: req.ip });
  res.json({ ...staffRow(user.toObject()), password });
});

module.exports = router;
