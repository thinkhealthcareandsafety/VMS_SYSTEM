const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const archiver = require('archiver');
const config = require('../config');
const { requireRole, isAdmin } = require('../middleware/auth');
const telegram = require('../services/telegram');
const email = require('../services/email');
const messaging = require('../services/messaging');
const exporter = require('../services/export');
const { Visit, Host, Outbox, Audit, User, Invite, Block, Gate, Material, Parcel, Group } = require('../models');
const passes = require('../services/passes');
const settings = require('../services/settings');
const sheets = require('../services/sheets');
const overstay = require('../services/overstay');
const license = require('../services/license');
const { siteDay, audit, normalizeMobile, cleanText, tidyName, passwordProblem, sha256 } = require('../services/core');

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
  if (query.gate && mongoose.isValidObjectId(query.gate)) q['movements.gate'] = new mongoose.Types.ObjectId(String(query.gate));
  if (['match', 'partial', 'mismatch', 'unread'].includes(query.idCheck)) q['idCheck.status'] = query.idCheck;
  if (query.company) q.company = new RegExp(esc(cleanText(query.company, 100)), 'i');
  if (query.name) {
    const re = new RegExp(esc(cleanText(query.name, 100)), 'i');
    const digits = String(query.name).replace(/\D/g, '');
    const card = passes.cardNo(query.name);
    q.$or = [{ firstName: re }, { lastName: re }, { ref: re }, ...(digits.length >= 4 ? [{ mobile: new RegExp(esc(digits)) }] : []), ...(passes.CARD_RE.test(card) ? [{ 'card.no': card }] : [])];
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
      id: String(v._id), ref: v.ref, name: `${v.firstName} ${v.lastName}`, mobile: v.mobile, email: v.email ?? null, company: v.company,
      purpose: v.purpose, host: v.host?.fullName, unit: v.host?.unit, status: v.status, gender: v.gender ?? null, faceMatchScore: v.faceMatchScore ?? null, idType: v.idType || 'aadhaar', idCheck: v.idCheck?.status ? v.idCheck : null, mobileVerified: v.mobileVerified ?? null,
      dailyNumber: v.dailyNumber ?? null, dailyDay: v.dailyDay ?? null, visitDay: v.visitDay,
      card: v.card?.no ? { no: v.card.no, type: v.card.type || 'visitor' } : null,
      createdAt: v.createdAt, decidedAt: v.decidedAt, checkedOutAt: v.checkedOutAt, forceReason: v.forceReason,
      hasIdImage: Boolean(v.idImagePath),
      validity: passes.validityLabel(v.validity), validUntil: v.validUntil ?? null, ...passes.entryExit(v),
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
  pending: 'Awaiting host', approved: 'On premises', rejected: 'Declined', expired: 'Host did not reply',
  cancelled: 'Cancelled', checked_out: 'Checked out', force_checked_out: 'Checked out by admin', away: 'Outside, pass valid',
};
const localStamp = (d) => (d ? new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(d)).replace(',', '') : '');
const safeName = (s) => String(s).replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60);
const photoFile = (v) => `${v.visitDay}/${v.ref} ${safeName(`${v.firstName} ${v.lastName}`)}/photo.jpg`;
const exportName = (q, ext) => `visitors ${q.from || 'start'} to ${q.to || siteDay()}.${ext}`;
// Excel turns "+9180..." into 9.18E+11, so Indian numbers go out as "80104 77969" under a "(+91)" header.
const sheetMobile = (m = '') => (m.startsWith(config.defaultCountryCode) ? m.slice(config.defaultCountryCode.length).replace(/^(\d{5})(\d{5})$/, '$1 $2') : m.replace(/^\+/, ''));
// A cell starting with = + - @ runs as a formula in Excel (CSV injection); a leading apostrophe keeps it text.
const sheetCell = (v) => csvCell(/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v);

// Excel reads UTF-8 CSV correctly only with a BOM; CRLF keeps Excel and Notepad happy.
function visitsSheet(docs) {
  const header = ['Visitor ID', 'Date', 'Pass no', 'Lanyard card', 'First name', 'Last name', 'Gender', `Mobile (${config.defaultCountryCode})`, 'Email', 'Number checked', 'Company', 'Purpose', 'Host', 'Flat / dept',
    'Status', 'Arrived', 'Let in', 'Left', 'Minutes inside', 'Entry gate', 'Let in by', 'Exit gate', 'Checked out by', 'Entries', 'Pass for', 'Pass valid till',
    'Force checkout reason', 'Face match %', 'Photo file'];
  const lines = docs.map((v) => {
    const admitted = ['approved', 'away', 'checked_out', 'force_checked_out'].includes(v.status);
    const moves = passes.entryExit(v);
    const end = v.checkedOutAt ? new Date(v.checkedOutAt) : v.status === 'approved' ? new Date() : moves.exit ? new Date(moves.exit.at) : null;
    const mins = admitted && v.decidedAt && end ? Math.round((end - new Date(v.decidedAt)) / 60000) : '';
    return [v.ref, v.visitDay, v.dailyNumber ?? '', v.card?.no ? `${passes.CARD_LABEL[v.card.type] || 'Visitor'} ${v.card.no}` : '', v.firstName, v.lastName, exporter.GENDER_LABEL[v.gender] || '', sheetMobile(v.mobile), v.email, exporter.VERIFIED_LABEL[v.mobileVerified] || '', v.company, v.purpose, v.host?.fullName, v.host?.unit,
      STATUS_LABEL[v.status] || v.status, localStamp(v.createdAt), admitted ? localStamp(v.decidedAt) : '', localStamp(v.checkedOutAt || moves.exit?.at),
      mins, moves.entry?.gate || '', moves.entry?.by || '', moves.exit?.gate || '', moves.exit?.by || '', moves.entries || '',
      v.validity ? passes.validityLabel(v.validity) : '', localStamp(v.validUntil), v.forceReason, v.faceMatchScore ?? '', v.photoPath ? photoFile(v) : ''].map(sheetCell).join(',');
  });
  return `﻿${[header.map(sheetCell).join(','), ...lines].join('\r\n')}\r\n`;
}

router.get('/visits.csv', requireRole('admin'), async (req, res) => {
  const { docs } = await searchVisits(req.query, { page: 1, limit: EXPORT_LIMIT });
  audit(req.user, 'export.visits_csv', { details: { rows: docs.length, from: req.query.from, to: req.query.to }, ip: req.ip });
  res.type('text/csv; charset=utf-8').attachment(exportName(req.query, 'csv')).send(visitsSheet(docs));
});

// What the download covers, in words, for the About sheet and the report header.
async function exportMeta(req) {
  const q = req.query;
  const range = q.from || q.to ? `${q.from || 'start'} to ${q.to || siteDay()}` : `All dates to ${siteDay()}`;
  const filters = [
    q.name && `visitor "${cleanText(q.name, 60)}"`, q.host && `host "${cleanText(q.host, 60)}"`,
    q.company && `company "${cleanText(q.company, 60)}"`, q.status && `status: ${exporter.STATUS_LABEL[q.status] || q.status}`,
  ].filter(Boolean).join(', ');
  return { by: req.user.fullName || req.user.username, range, filters, site: (await settings.get()).siteName };
}
const exists = (p) => Boolean(p) && fs.existsSync(path.resolve(p));
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Excel sheet on its own: formatted columns, real dates, filters, and an "About this download" tab.
router.get('/visits.xlsx', requireRole('admin'), async (req, res) => {
  const { docs } = await searchVisits(req.query, { page: 1, limit: EXPORT_LIMIT });
  const buf = await exporter.workbook(exporter.records(docs), { meta: await exportMeta(req) });
  audit(req.user, 'export.visits_xlsx', { details: { rows: docs.length, from: req.query.from, to: req.query.to }, ip: req.ip });
  res.type(XLSX).attachment(exportName(req.query, 'xlsx')).send(Buffer.from(buf));
});

// Full record: the Excel sheet, a printable report, and one folder per visit with the photo and,
// when asked for, the masked Aadhaar image. Streamed, never held in memory as a whole.
//   Visitor records <dates>/Visitors.xlsx
//   Visitor records <dates>/Report.html
//   Visitor records <dates>/2026-10-06/V-000012 Ravi Kumar/photo.jpg
//   Visitor records <dates>/2026-10-06/V-000012 Ravi Kumar/aadhaar-masked.jpg
router.get('/visits.zip', requireRole('admin'), async (req, res) => {
  const aadhaar = req.query.aadhaar === '1';
  const { docs } = await searchVisits(req.query, { page: 1, limit: EXPORT_LIMIT });
  const recs = exporter.records(docs).map((r) => ({ ...r, hasPhoto: exists(r.photoPath), hasIdImage: aadhaar && exists(r.idImagePath) }));
  const meta = await exportMeta(req);
  const sheet = await exporter.workbook(recs, { files: { aadhaar }, meta });
  audit(req.user, 'export.visits_zip', {
    details: { rows: docs.length, from: req.query.from, to: req.query.to, aadhaar, aadhaarImages: recs.filter((r) => r.hasIdImage).length }, ip: req.ip,
  });

  const q = req.query;
  const root = `Visitor records ${q.from ? `${q.from} to ${q.to || siteDay()}` : `up to ${q.to || siteDay()}`}`;
  res.type('application/zip').attachment(`${root}.zip`);
  const zip = archiver('zip', { zlib: { level: 1 } }); // JPEGs barely compress; favour speed
  zip.on('error', (err) => { console.error('export zip:', err.message); res.destroy(err); });
  zip.pipe(res);
  zip.append(Buffer.from(sheet), { name: `${root}/Visitors.xlsx` });
  zip.append(exporter.report(recs, { meta, aadhaar }), { name: `${root}/Report.html` });
  for (const r of recs) {
    if (r.hasPhoto) zip.file(path.resolve(r.photoPath), { name: `${root}/${r.folder}/photo.jpg` });
    if (r.hasIdImage) zip.file(path.resolve(r.idImagePath), { name: `${root}/${r.folder}/aadhaar-masked.jpg` });
  }
  await zip.finalize();
});

// Everything that happened to one visit, oldest first (detail drawer timeline).
router.get('/visits/:id/timeline', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const rows = await Audit.find({ entity: 'Visit', entityId: req.params.id }).sort({ at: 1 }).lean();
  res.json({ rows: rows.map((r) => ({ at: r.at, actor: r.actor, role: r.actorRole, action: r.action, details: r.details })) });
});

// Still inside after their pass ended. Passes from before validity existed fall back to the hours rule.
// A multi-day pass holder who came back in today is not overstaying, however long ago the pass began.
const overstayQuery = (now = new Date()) => ({
  status: 'approved',
  $or: [{ validUntil: { $lt: now } }, { validUntil: { $exists: false }, decidedAt: { $lt: new Date(now.getTime() - config.maxInsideHours * 3600e3) } }],
});

// What needs someone at the office now, beyond visitors: drives the Overview cards and the sidebar badges.
async function gateWork(today) {
  const [materialPending, materialOverdue, materialAtGate, parcelsWaiting, parcelsOld, parcelsDeclined, groupsToday, idMismatchToday, overstayEscalated] = await Promise.all([
    Material.countDocuments({ direction: 'out', status: 'pending' }),
    Material.countDocuments({ kind: 'returnable', status: { $in: ['out', 'partly_returned'] }, returnBy: { $lt: today } }),
    Material.countDocuments({ direction: 'in', kind: 'delivery', status: 'received' }),
    Parcel.countDocuments({ direction: 'in', status: 'received' }),
    Parcel.countDocuments({ direction: 'in', status: 'received', createdAt: { $lt: new Date(Date.now() - 72 * 3600e3) } }),
    Parcel.countDocuments({ direction: 'in', status: 'received', 'response.kind': 'declined' }),
    Group.countDocuments({ status: 'active', startDay: { $lte: today }, endDay: { $gte: today } }),
    Visit.countDocuments({ visitDay: today, 'idCheck.status': 'mismatch' }),
    Visit.countDocuments({ ...overstay.query(), 'overstay.escalatedAt': { $exists: true } }),
  ]);
  return { materialPending, materialOverdue, materialAtGate, parcelsWaiting, parcelsOld, parcelsDeclined, groupsToday, idMismatchToday, overstayEscalated };
}

router.get('/stats', requireRole('admin'), async (req, res) => {
  const today = siteDay();
  const [inside, pending, checkedOutToday, forceToday, printFailed, smsFailed, staleCut] = await Promise.all([
    Visit.countDocuments({ status: 'approved' }),
    Visit.countDocuments({ status: 'pending' }),
    Visit.countDocuments({ visitDay: today, status: 'checked_out' }),
    Visit.countDocuments({ visitDay: today, status: 'force_checked_out' }),
    Outbox.countDocuments({ kind: 'print', status: 'failed' }),
    Outbox.countDocuments({ kind: { $in: ['sms', 'telegram', 'whatsapp', 'email'] }, status: 'failed' }),
    Visit.countDocuments(overstayQuery()),
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
    smsLive: config.sms.driver !== 'console', telegramOn: telegram.enabled(), emailOn: email.enabled(), printerOn: config.printer.mode !== 'off',
    expectedToday: await Invite.countDocuments({ day: today, status: 'expected' }),
    ...(await gateWork(today)),
  });
});

// Force checkout lives in routes/visits.js; this is the admin list of stale "still inside" visitors.
router.get('/stale', requireRole('admin'), async (req, res) => {
  const rows = await Visit.find(overstayQuery()).populate('host').lean();
  res.json({ rows: rows.map((v) => ({ id: String(v._id), ref: v.ref, name: `${v.firstName} ${v.lastName}`, host: v.host?.fullName, decidedAt: v.decidedAt, validUntil: v.validUntil ?? null })) });
});

router.get('/outbox', requireRole('admin'), async (req, res) => {
  const kind = req.query.kind === 'print' ? 'print' : 'sms';
  const rows = await Outbox.find({ kind: kind === 'print' ? 'print' : { $in: ['sms', 'telegram', 'whatsapp', 'email'] } }).sort({ _id: -1 }).limit(100).populate('visit', 'ref').lean();
  res.json({
    rows: rows.map((o) => ({
      id: String(o._id), ref: o.visit?.ref, status: o.status, attempts: o.attempts, lastError: o.lastError,
      channel: o.kind, to: o.kind === 'sms' ? o.to : o.kind === 'telegram' ? 'Telegram' : undefined,
      body: o.kind === 'print' ? undefined : o.body, createdAt: o.createdAt, sentAt: o.sentAt,
    })),
  });
});

// Newest first, 100 at a time (`before` = the last id shown). `q` finds a person, a visitor ID or a word in the details.
router.get('/audit', requireRole('admin'), async (req, res) => {
  const filter = {};
  if (req.query.action) filter.action = new RegExp(esc(cleanText(req.query.action, 60)));
  const q = cleanText(req.query.q, 60);
  if (q) {
    const re = new RegExp(esc(q), 'i');
    filter.$or = [{ actor: re }, { 'details.ref': re }, { 'details.name': re }, { 'details.username': re }, { 'details.mobile': re }, { 'details.reason': re }, { 'details.guest': re }, { 'details.host': re }];
  }
  if (mongoose.isValidObjectId(req.query.before)) filter._id = { $lt: new mongoose.Types.ObjectId(String(req.query.before)) };
  const rows = await Audit.find(filter).sort({ _id: -1 }).limit(101).lean();
  res.json({ rows: rows.slice(0, 100), more: rows.length > 100 });
});

// One box for everything: a visitor (name, mobile, visitor ID, today's pass number), a host, an event, a staff member.
router.get('/search', requireRole('admin'), async (req, res) => {
  const q = cleanText(req.query.q, 60);
  if (q.length < 2 && !/^\d+$/.test(q)) return res.json({ visits: [], hosts: [], groups: [], staff: [] });
  const re = new RegExp(esc(q), 'i');
  const digits = q.replace(/\D/g, '');
  const words = q.split(' ').filter(Boolean);
  const nameQ = words.length > 1
    ? { firstName: new RegExp(`^${esc(words[0])}`, 'i'), lastName: new RegExp(`^${esc(words.slice(1).join(' '))}`, 'i') }
    : null;
  const visitOr = [{ firstName: re }, { lastName: re }, { ref: re }, { company: re }, ...(nameQ ? [nameQ] : [])];
  if (digits.length >= 4) visitOr.push({ mobile: new RegExp(`${esc(digits)}`) });
  if (/^\d{1,4}$/.test(q)) visitOr.push({ dailyDay: siteDay(), dailyNumber: Number(q) });
  if (passes.CARD_RE.test(passes.cardNo(q))) visitOr.push({ 'card.no': passes.cardNo(q), status: { $in: ['pending', 'approved'] } }); // who has card 07 now
  const [visits, hosts, grps, staff] = await Promise.all([
    Visit.find({ $or: visitOr }).sort({ createdAt: -1 }).limit(8).populate('host', 'fullName unit').lean(),
    Host.find({ $or: [{ fullName: re }, { unit: re }, ...(digits.length >= 4 ? [{ mobile: new RegExp(esc(digits)) }] : [])] }).sort({ active: -1, fullName: 1 }).limit(5).lean(),
    Group.find({ name: re }).sort({ startDay: -1 }).limit(4).lean(),
    User.find({ $or: [{ fullName: re }, { username: re }] }).sort({ active: -1, fullName: 1 }).limit(4).lean(),
  ]);
  res.json({
    visits: visits.map((v) => ({
      id: String(v._id), ref: v.ref, name: `${v.firstName} ${v.lastName}`.trim(), company: v.company, status: v.status,
      dailyNumber: v.dailyNumber ?? null, dailyDay: v.dailyDay ?? null, host: v.host?.fullName || '', unit: v.host?.unit || '', createdAt: v.createdAt,
    })),
    hosts: hosts.map((h) => ({ id: String(h._id), name: h.fullName, unit: h.unit, active: h.active })),
    groups: grps.map((g) => ({ id: String(g._id), name: g.name, days: `${g.startDay}${g.endDay !== g.startDay ? ` to ${g.endDay}` : ''}`, status: g.status })),
    staff: staff.map((u) => ({ id: String(u._id), name: u.fullName, username: u.username, role: u.role, active: u.active })),
  });
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
  res.json({ rows: hosts.map((h) => ({ id: String(h._id), fullName: h.fullName, unit: h.unit, mobile: h.mobile, email: h.email, active: h.active, telegram: Boolean(h.telegramChatId) })) });
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
  if (b.disconnectTelegram === true) Object.assign(unset, { telegramChatId: 1, telegramLinkHash: 1, telegramLinkExpires: 1 });
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

// One-time link and QR for a host to connect Telegram. Valid 24 hours, works once.
router.post('/hosts/:id/telegram-link', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (!telegram.enabled()) return res.status(503).json({ error: 'Telegram is not set up yet. Add the bot token in the server settings.' });
  let bot;
  try { bot = await telegram.botUsername(); } catch { return res.status(502).json({ error: 'Could not reach Telegram. Check the bot token.' }); }
  const code = crypto.randomBytes(18).toString('base64url');
  const expires = new Date(Date.now() + 24 * 3600e3);
  const host = await Host.findByIdAndUpdate(req.params.id, { telegramLinkHash: sha256(code), telegramLinkExpires: expires }, { new: true });
  if (!host) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'host.telegram_link', { entity: 'Host', entityId: host._id, details: { unit: host.unit }, ip: req.ip });
  res.json({ url: `https://t.me/${bot}?start=${code}`, bot, expiresAt: expires });
});

// Bulk import from Excel, CSV or pasted text: name, flat / department, mobile, email (optional).
// A host is known by their mobile, so importing the directory again updates people instead of adding them twice.
// dryRun: true checks every line and says what would happen, without saving anything.
const HOST_HEAD = {
  fullName: ['name', 'fullname', 'hostname', 'host', 'resident', 'employee', 'employeename', 'residentname'],
  unit: ['unit', 'flat', 'flatno', 'flatnumber', 'department', 'dept', 'room', 'office', 'floor', 'wing', 'unitno', 'apartment'],
  mobile: ['mobile', 'phone', 'mobileno', 'mobilenumber', 'phonenumber', 'phoneno', 'contact', 'contactno', 'contactnumber', 'cell', 'whatsapp'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
};
router.post('/hosts/import', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  let rows;
  try {
    rows = sheets.columns(await sheets.readCells({ text: b.text ?? b.csv, file: b.file, filename: b.filename }), HOST_HEAD, ['fullName', 'unit', 'mobile', 'email']);
  } catch (e) {
    return res.status(400).json({ error: e.expose ? e.message : 'That file could not be read. Save it as .xlsx or .csv and try again.' });
  }
  if (!rows.length) return res.status(400).json({ error: 'No hosts found. One per line: name, flat or department, mobile, email.' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Import at most 5,000 hosts at a time' });

  const mobiles = rows.map((r) => normalizeMobile(r.mobile)).filter(Boolean);
  const known = new Map((await Host.find({ mobile: { $in: mobiles } }).lean()).map((h) => [h.mobile, h]));
  const seen = new Set();
  const out = rows.map((r) => {
    const mobile = normalizeMobile(r.mobile);
    const email = r.email.toLowerCase();
    const row = { line: r.line, fullName: r.fullName, unit: r.unit, mobile: mobile || r.mobile, email };
    if (r.fullName.length < 2) return { ...row, action: 'error', error: 'Name missing' };
    if (!r.unit) return { ...row, action: 'error', error: 'Flat or department missing' };
    if (!mobile) return { ...row, action: 'error', error: r.mobile ? `"${r.mobile}" is not a valid mobile. Use the 10-digit number` : 'No mobile number' };
    if (email && !z.string().email().safeParse(email).success) return { ...row, action: 'error', error: `"${r.email}" is not a valid email` };
    if (seen.has(mobile)) return { ...row, action: 'error', error: 'Same mobile as an earlier line' };
    seen.add(mobile);
    const h = known.get(mobile);
    if (!h) return { ...row, action: 'add' };
    const same = h.fullName === r.fullName && h.unit === r.unit && (h.email || '') === (email || h.email || '');
    return { ...row, action: same ? 'same' : 'update', id: String(h._id) };
  });
  const count = (a) => out.filter((r) => r.action === a).length;
  const summary = { add: count('add'), update: count('update'), same: count('same'), errors: out.filter((r) => r.action === 'error').map(({ line, fullName, error }) => ({ line, name: fullName, error })) };
  if (b.dryRun === true) return res.json({ ...summary, rows: out.slice(0, 1000) });

  const adds = out.filter((r) => r.action === 'add').map((r) => ({ fullName: r.fullName, unit: r.unit, mobile: r.mobile, email: r.email || undefined }));
  const updates = out.filter((r) => r.action === 'update').map((r) => ({
    updateOne: { filter: { _id: r.id }, update: { $set: { fullName: r.fullName, unit: r.unit, ...(r.email ? { email: r.email } : {}) } } },
  }));
  if (adds.length) await Host.insertMany(adds);
  if (updates.length) await Host.bulkWrite(updates);
  audit(req.user, 'host.imported', { details: { created: adds.length, updated: updates.length, errors: summary.errors.length }, ip: req.ip });
  res.json({ created: adds.length, updated: updates.length, same: summary.same, errors: summary.errors });
});

// ----- Staff accounts: guards and admins -----
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
// No look-alike characters (0/O, 1/l/I), so a guard can read a reset password off paper.
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genPassword = () => Array.from(crypto.randomBytes(14)).map((b) => PW_ALPHABET[b % PW_ALPHABET.length]).join('');
const staffRow = (u) => ({
  id: String(u._id), username: u.username, fullName: u.fullName, role: u.role, active: u.active,
  gate: u.gate && u.gate.name ? { id: String(u.gate._id), name: u.gate.name, active: u.gate.active } : null,
  lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt || null,
});

// A Super Admin is made by a Super Admin. The very first one can be made by any admin, once.
const ROLES = ['guard', 'admin', 'superadmin'];
const mayAppointSuper = async (actor) => actor.role === 'superadmin' || !(await User.exists({ role: 'superadmin', active: true }));

router.get('/users', requireRole('admin'), async (req, res) => {
  const users = await User.find().sort({ active: -1, role: 1, fullName: 1 }).populate('gate', 'name active').lean();
  res.json({ rows: users.map(staffRow), canAppointSuper: await mayAppointSuper(req.user) });
});

router.post('/users', requireRole('admin'), async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const fullName = cleanText(req.body?.fullName, 80);
  const { role } = req.body || {};
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3 to 30 lowercase letters or numbers (dot, dash and underscore allowed)' });
  if (fullName.length < 2) return res.status(400).json({ error: "Enter the person's full name" });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose guard, admin or super admin' });
  if (role === 'superadmin' && !(await mayAppointSuper(req.user))) return res.status(403).json({ error: 'Only a Super Admin can make another Super Admin' });
  if (await User.exists({ username })) return res.status(409).json({ error: `The username "${username}" is already taken` });
  const typed = typeof req.body?.password === 'string' && req.body.password.length > 0;
  const password = typed ? req.body.password : genPassword();
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  const gate = await gateChoice(req.body?.gateId);
  if (gate === false) return res.status(400).json({ error: 'Pick one of the active gates' });
  const user = await User.create({ username, fullName, role, gate: gate || undefined, passwordHash: await bcrypt.hash(password, 12) });
  audit(req.user, 'user.created', { entity: 'User', entityId: user._id, details: { username, role, ...(gate ? { gate: gate.name } : {}) }, ip: req.ip });
  const saved = await User.findById(user._id).populate('gate', 'name active').lean();
  res.status(201).json({ ...staffRow(saved), password: typed ? undefined : password });
});

// Edit name/role, switch access on or off, or issue a new password. A reset signs the person out everywhere.
router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const self = String(user._id) === req.user.id;
  const b = req.body || {};
  const changes = {};
  if (user.role === 'superadmin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only a Super Admin can change a Super Admin account' });

  if (b.fullName !== undefined) {
    const fullName = cleanText(b.fullName, 80);
    if (fullName.length < 2) return res.status(400).json({ error: "Enter the person's full name" });
    changes.fullName = fullName;
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Choose guard, admin or super admin' });
    if (b.role === 'superadmin' && user.role !== 'superadmin' && !(await mayAppointSuper(req.user))) {
      return res.status(403).json({ error: 'Only a Super Admin can make another Super Admin' });
    }
    if (self && !isAdmin({ role: b.role })) return res.status(400).json({ error: 'You cannot remove your own admin access' });
    if (self && user.role === 'superadmin' && b.role !== 'superadmin'
      && !(await User.exists({ role: 'superadmin', active: true, _id: { $ne: user._id } }))) {
      return res.status(400).json({ error: 'Make someone else Super Admin before giving this up' });
    }
    changes.role = b.role;
  }
  if (b.gateId !== undefined) {
    const gate = await gateChoice(b.gateId);
    if (gate === false) return res.status(400).json({ error: 'Pick one of the active gates' });
    changes.gate = gate ? gate._id : null;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return res.status(400).json({ error: 'Invalid value' });
    if (self && !b.active) return res.status(400).json({ error: 'You cannot switch off your own account' });
    changes.active = b.active;
  }
  // Never leave the site without an active admin.
  const losesAdmin = isAdmin(user) && user.active && (changes.role === 'guard' || changes.active === false);
  if (losesAdmin && (await User.countDocuments({ role: { $in: ['admin', 'superadmin'] }, active: true, _id: { $ne: user._id } })) === 0) {
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
  res.json({ ...staffRow(await User.findById(user._id).populate('gate', 'name active').lean()), password });
});

// ----- Gates (entry points). Switched off, never deleted: past entries keep their gate. -----
// '' or null = no fixed gate (the site's first gate is used); an id must be an active gate; anything else is refused (false).
async function gateChoice(id) {
  if (id === undefined || id === null || id === '') return null;
  if (!mongoose.isValidObjectId(id)) return false;
  return (await Gate.findOne({ _id: id, active: true }).lean()) || false;
}
const gateRow = (g, staff = 0) => ({ id: String(g._id), name: g.name, active: g.active, staff });

router.get('/gates', requireRole('admin'), async (req, res) => {
  await passes.ensureDefaultGate();
  const [gates, counts] = await Promise.all([
    Gate.find().sort({ active: -1, createdAt: 1 }).lean(),
    User.aggregate([{ $match: { active: true, gate: { $ne: null } } }, { $group: { _id: '$gate', n: { $sum: 1 } } }]),
  ]);
  const staff = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({ rows: gates.map((g) => gateRow(g, staff.get(String(g._id)) || 0)) });
});

const sameName = (name) => ({ name: new RegExp(`^${esc(name)}$`, 'i') });
router.post('/gates', requireRole('admin'), async (req, res) => {
  const name = cleanText(req.body?.name, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Enter the gate name (at least 2 characters)' });
  await passes.ensureDefaultGate();
  if (await Gate.exists(sameName(name))) return res.status(409).json({ error: `There is already a gate called "${name}"` });
  if ((await Gate.countDocuments({ active: true })) >= 20) return res.status(400).json({ error: 'A site can have up to 20 active gates' });
  const gate = await Gate.create({ name });
  audit(req.user, 'gate.created', { entity: 'Gate', entityId: gate._id, details: { name }, ip: req.ip });
  res.status(201).json(gateRow(gate.toObject()));
});

router.patch('/gates/:id', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const gate = await Gate.findById(req.params.id);
  if (!gate) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const before = gate.name;
  if (b.name !== undefined) {
    const name = cleanText(b.name, 40);
    if (name.length < 2) return res.status(400).json({ error: 'Enter the gate name (at least 2 characters)' });
    if (await Gate.exists({ ...sameName(name), _id: { $ne: gate._id } })) return res.status(409).json({ error: `There is already a gate called "${name}"` });
    gate.name = name;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return res.status(400).json({ error: 'Invalid value' });
    if (!b.active && gate.active && (await Gate.countDocuments({ active: true, _id: { $ne: gate._id } })) === 0) {
      return res.status(400).json({ error: 'Keep at least one gate open' });
    }
    gate.active = b.active;
  }
  await gate.save();
  // Guards at a closed gate fall back to the site's first gate until the admin moves them.
  audit(req.user, 'gate.updated', { entity: 'Gate', entityId: gate._id, details: { name: gate.name, ...(before !== gate.name ? { renamed: `${before} → ${gate.name}` } : {}), active: gate.active }, ip: req.ip });
  res.json(gateRow(gate.toObject()));
});

// ----- Licence (GateSmartX): see services/license.js -----
router.post('/license', requireRole('admin'), async (req, res) => {
  const r = await license.install(req.body?.key);
  if (r.error) return res.status(400).json({ error: r.error });
  audit(req.user, 'license.installed', { details: { site: r.lic.site, until: r.lic.until }, ip: req.ip });
  res.json(await license.status());
});

// ----- Site settings -----
const RETENTION_DAYS = [1, 7, 30, 90, 180, 365];
router.get('/settings', requireRole('admin'), async (req, res) => {
  const s = await settings.get();
  res.json({
    ...s,
    retentionChoices: RETENTION_DAYS,
    channels: {
      otp: messaging.otpLive(),
      telegram: telegram.enabled() ? await telegram.botUsername().catch(() => null) || 'connected' : null,
      sms: config.sms.driver !== 'console',
      smsAlerts: messaging.smsAlertsLive(),
      whatsapp: require('../services/whatsapp').enabled(),
      email: email.enabled() ? config.email.from : null,
      printer: config.printer.mode,
    },
  });
});

router.patch('/settings', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.siteName !== undefined) {
    const v = cleanText(b.siteName, 60);
    if (v.length < 2) return res.status(400).json({ error: 'Enter the site name (at least 2 characters)' });
    patch.siteName = v;
  }
  if (b.gateName !== undefined) {
    const v = cleanText(b.gateName, 40);
    if (v.length < 2) return res.status(400).json({ error: 'Enter the gate name (at least 2 characters)' });
    patch.gateName = v;
  }
  if (b.idRetentionDays !== undefined) {
    if (!RETENTION_DAYS.includes(Number(b.idRetentionDays))) return res.status(400).json({ error: 'Pick one of the listed retention periods' });
    patch.idRetentionDays = Number(b.idRetentionDays);
  }
  if (b.otpMode !== undefined) {
    if (!['off', 'optional', 'required'].includes(b.otpMode)) return res.status(400).json({ error: 'Pick off, optional or required' });
    patch.otpMode = b.otpMode;
  }
  if (b.fullIdCapture !== undefined) {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only a Super Admin can change this' });
    if (typeof b.fullIdCapture !== 'boolean') return res.status(400).json({ error: 'Invalid value' });
    patch.fullIdCapture = b.fullIdCapture;
  }
  if (b.assemblyPoint !== undefined) patch.assemblyPoint = cleanText(b.assemblyPoint, 120);
  // Who is told when a visitor overstays: mobile numbers (WhatsApp) and email addresses, in one list.
  if (b.escalateTo !== undefined) {
    const parts = String(Array.isArray(b.escalateTo) ? b.escalateTo.join(',') : b.escalateTo || '').split(/[\s,;]+/).filter(Boolean);
    const mobiles = [];
    const emails = [];
    for (const p of parts) {
      if (p.includes('@')) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p)) return res.status(400).json({ error: `${p} is not a valid email address` });
        emails.push(p.toLowerCase());
      } else {
        const m = normalizeMobile(p);
        if (!m) return res.status(400).json({ error: `${p} is not a valid mobile number` });
        mobiles.push(m);
      }
    }
    if (mobiles.length > 10 || emails.length > 10) return res.status(400).json({ error: 'Up to 10 numbers and 10 email addresses' });
    patch.escalateTo = { mobiles: [...new Set(mobiles)], emails: [...new Set(emails)] };
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
  const before = await settings.get();
  const after = await settings.update(patch);
  const show = (v) => (v && typeof v === 'object' ? [...(v.mobiles || []), ...(v.emails || [])].join(', ') || 'nobody' : v);
  audit(req.user, 'settings.updated', { details: Object.fromEntries(Object.keys(patch).map((k) => [k, `${show(before[k])} → ${show(after[k])}`])), ip: req.ip });
  res.json(after);
});

// ----- Expected visitors (let in on arrival without waiting for the host) -----
const inviteRow = (i) => ({
  id: String(i._id), firstName: i.firstName, lastName: i.lastName, mobile: i.mobile, company: i.company, purpose: i.purpose, note: i.note,
  day: i.day, status: i.status, visitId: i.visit ? String(i.visit) : null,
  host: i.host ? { id: String(i.host._id), name: i.host.fullName, unit: i.host.unit } : null, createdAt: i.createdAt,
});

router.get('/invites', requireRole('admin'), async (req, res) => {
  const today = siteDay();
  const rows = await Invite.find({ $or: [{ day: { $gte: today } }, { status: 'arrived', day: today }] })
    .sort({ day: 1, createdAt: 1 }).limit(500).populate('host').lean();
  res.json({ today, rows: rows.map(inviteRow) });
});

router.post('/invites', requireRole('admin'), license.requireLicense, async (req, res) => {
  const b = req.body || {};
  const firstName = cleanText(b.firstName, 60);
  const lastName = cleanText(b.lastName, 60);
  const mobile = normalizeMobile(b.mobile);
  const today = siteDay();
  const last = siteDay(new Date(Date.now() + 90 * 86400e3));
  if (firstName.length < 1 || lastName.length < 1) return res.status(400).json({ error: 'Enter the visitor\'s first and last name' });
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number (Indian mobiles start with 6 to 9)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) || b.day < today || b.day > last) return res.status(400).json({ error: 'Pick a date from today up to 90 days ahead' });
  if (!mongoose.isValidObjectId(b.hostId)) return res.status(400).json({ error: 'Choose whom they are meeting' });
  const host = await Host.findOne({ _id: b.hostId, active: true }).lean();
  if (!host) return res.status(400).json({ error: 'That host is not active' });
  if (await Block.exists({ mobile, active: true })) return res.status(409).json({ error: 'This number is on the blocked list' });
  if (await Invite.exists({ mobile, day: b.day, status: 'expected' })) return res.status(409).json({ error: 'This visitor is already expected that day' });
  const invite = await Invite.create({
    firstName, lastName, mobile, company: cleanText(b.company, 100), purpose: cleanText(b.purpose, 100), note: cleanText(b.note, 200),
    host: host._id, day: b.day, createdBy: req.user.id,
  });
  audit(req.user, 'invite.created', { entity: 'Invite', entityId: invite._id, details: { name: `${firstName} ${lastName}`, day: b.day, host: host.fullName }, ip: req.ip });
  res.status(201).json(inviteRow({ ...invite.toObject(), host }));
});

// A whole list at once: interview candidates, a delegation, a contractor crew. Same rules as one by one.
// The batch has a day and a host; a row may name its own (a Date column, a Host column with a name or flat).
// dryRun: true checks every line and returns what would happen, without saving anything.
const INVITE_HEAD = {
  name: ['name', 'fullname', 'visitorname', 'guestname', 'visitor', 'guest', 'candidate', 'candidatename', 'attendee'],
  first: ['firstname', 'first', 'givenname', 'fname'],
  last: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  mobile: ['mobile', 'phone', 'mobileno', 'mobilenumber', 'phonenumber', 'phoneno', 'contact', 'contactno', 'contactnumber', 'cell', 'whatsapp'],
  company: ['company', 'organisation', 'organization', 'org', 'firm', 'from', 'companyname', 'vendor'],
  purpose: ['purpose', 'reason', 'visitpurpose', 'agenda'],
  note: ['note', 'notes', 'remarks', 'instructions', 'comment', 'comments'],
  day: ['date', 'day', 'visitdate', 'arrivaldate', 'arrival', 'on'],
  host: ['host', 'meeting', 'whomtomeet', 'tomeet', 'hostname', 'flat', 'unit', 'department', 'dept'],
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "2026-10-20", "20/10/2026", "20-10-26", "20 Oct 2026", "Oct 20, 2026": Indian sheets put the day first.
function parseDay(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y, mo, d;
  if (m) [, y, mo, d] = m.map(Number);
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s))) [, d, mo, y] = m.map(Number);
  else if ((m = /^(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{2,4})$/i.exec(s))) { d = Number(m[1]); mo = MONTHS[m[2].toLowerCase()]; y = Number(m[3]); }
  else if ((m = /^(?:[a-z]{3},?\s+)?([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i.exec(s))) { mo = MONTHS[m[1].toLowerCase()]; d = Number(m[2]); y = Number(m[3]); }
  else return null;
  if (y < 100) y += 2000;
  if (!mo || mo > 12 || !d || d > 31) return null;
  const ymd = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${ymd}T00:00:00Z`).toISOString().slice(0, 10) === ymd ? ymd : null;
}

router.post('/invites/import', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const today = siteDay();
  const last = siteDay(new Date(Date.now() + 90 * 86400e3));
  const defaultDay = b.day ? String(b.day) : '';
  if (defaultDay && (!/^\d{4}-\d{2}-\d{2}$/.test(defaultDay) || defaultDay < today || defaultDay > last)) return res.status(400).json({ error: 'Pick a date from today up to 90 days ahead' });
  const defaultHost = mongoose.isValidObjectId(b.hostId) ? await Host.findOne({ _id: b.hostId, active: true }).lean() : null;
  if (b.hostId && !defaultHost) return res.status(400).json({ error: 'That host is not active' });

  let rows;
  try {
    rows = sheets.columns(await sheets.readCells({ text: b.text, file: b.file, filename: b.filename }), INVITE_HEAD, ['name', 'mobile', 'company', 'purpose', 'note']);
  } catch (e) {
    return res.status(400).json({ error: e.expose ? e.message : 'That file could not be read. Save it as .xlsx or .csv and try again.' });
  }
  if (!rows.length) return res.status(400).json({ error: 'No visitors found. One per line: name, mobile, company.' });
  if (rows.length > 1000) return res.status(400).json({ error: 'Import at most 1,000 visitors at a time' });

  // Hosts named in the sheet, by exact name or flat. A flat shared by two hosts is ambiguous and refused.
  const hostKeys = [...new Set(rows.map((r) => r.host.toLowerCase()).filter(Boolean))];
  const byKey = new Map();
  if (hostKeys.length) {
    const hosts = await Host.find({ active: true, $or: [{ fullName: { $in: hostKeys.map((k) => new RegExp(`^${esc(k)}$`, 'i')) } }, { unit: { $in: hostKeys.map((k) => new RegExp(`^${esc(k)}$`, 'i')) } }] }).lean();
    for (const k of hostKeys) {
      const named = hosts.filter((h) => h.fullName.toLowerCase() === k);
      const flat = hosts.filter((h) => h.unit.toLowerCase() === k);
      byKey.set(k, named.length === 1 ? named[0] : named.length ? 'many' : flat.length === 1 ? flat[0] : flat.length ? 'many' : null);
    }
  }
  const mobiles = rows.map((r) => normalizeMobile(r.mobile)).filter(Boolean);
  const [blocked, expected] = await Promise.all([
    Block.find({ mobile: { $in: mobiles }, active: true }, 'mobile').lean(),
    Invite.find({ mobile: { $in: mobiles }, status: 'expected', day: { $gte: today } }, 'mobile day').lean(),
  ]);
  const blockedSet = new Set(blocked.map((x) => x.mobile));
  const taken = new Set(expected.map((x) => `${x.mobile}|${x.day}`));

  const out = rows.map((r) => {
    let full = r.name || `${r.first} ${r.last}`.trim();
    const parts = full.split(' ').filter(Boolean);
    const firstName = r.name ? parts[0] || '' : r.first || parts[0] || '';
    const lastName = r.name ? parts.slice(1).join(' ') : r.last || parts.slice(1).join(' ');
    full = `${firstName} ${lastName}`.trim();
    const mobile = normalizeMobile(r.mobile);
    const day = r.day ? parseDay(r.day) : defaultDay;
    const hostHit = r.host ? byKey.get(r.host.toLowerCase()) : defaultHost;
    const row = {
      line: r.line, name: full, mobile: mobile || r.mobile, company: r.company, purpose: r.purpose, note: r.note, day: day || r.day,
      host: hostHit && hostHit !== 'many' ? { id: String(hostHit._id), name: hostHit.fullName, unit: hostHit.unit } : null,
    };
    const fail = (error) => ({ ...row, action: 'error', error });
    if (!firstName || !lastName) return fail(full ? 'Give a first and last name' : 'Name missing');
    if (!/^[\p{L} .'-]{1,60}$/u.test(firstName) || !/^[\p{L} .'-]{1,60}$/u.test(lastName)) return fail('The name has characters that are not letters');
    if (!mobile) return fail(r.mobile ? `"${r.mobile}" is not a valid mobile. Use the 10-digit number` : 'No mobile number');
    if (!day) return fail(r.day ? `"${r.day}" is not a date. Write it as 20/10/2026` : 'No day. Go back and pick the day, or add a Date column');
    if (day < today || day > last) return fail('The date must be from today up to 90 days ahead');
    if (r.host && hostHit === 'many') return fail(`Several hosts share "${r.host}". Use the host's full name instead`);
    if (r.host && !hostHit) return fail(`No host called "${r.host}". Use the host's full name or flat as listed under Hosts`);
    if (!hostHit) return fail('No host. Go back and pick whom they meet, or add a Host column');
    if (blockedSet.has(mobile)) return fail('On the blocked list');
    if (taken.has(`${mobile}|${day}`)) return fail('Already expected that day');
    taken.add(`${mobile}|${day}`);
    return { ...row, action: 'add', firstName, lastName, hostId: hostHit._id };
  });
  const ok = out.filter((r) => r.action === 'add');
  const errors = out.filter((r) => r.action === 'error').map(({ line, name, error }) => ({ line, name, error }));
  const clean = ({ firstName, lastName, hostId, ...r }) => r; // eslint-disable-line no-unused-vars
  if (b.dryRun === true) return res.json({ add: ok.length, errors, rows: out.slice(0, 1000).map(clean) });

  const docs = ok.map((r) => ({
    firstName: tidyName(r.firstName), lastName: tidyName(r.lastName), mobile: r.mobile, company: cleanText(r.company, 100), purpose: cleanText(r.purpose, 100),
    note: cleanText(r.note, 200), host: r.hostId, day: r.day, createdBy: req.user.id,
  }));
  if (docs.length) await Invite.insertMany(docs);
  audit(req.user, 'invite.imported', { details: { created: docs.length, errors: errors.length }, ip: req.ip });
  res.json({ created: docs.length, errors });
});

// Several expected visitors called off at once (a meeting moved, a delegation postponed).
router.post('/invites/cancel', requireRole('admin'), async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((id) => mongoose.isValidObjectId(id)).slice(0, 1000);
  if (!ids.length) return res.status(400).json({ error: 'Pick the visitors to cancel' });
  const r = await Invite.updateMany({ _id: { $in: ids }, status: 'expected' }, { status: 'cancelled' });
  audit(req.user, 'invite.cancelled', { details: { count: r.modifiedCount }, ip: req.ip });
  res.json({ cancelled: r.modifiedCount });
});

router.patch('/invites/:id', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (req.body?.status !== 'cancelled') return res.status(400).json({ error: 'Only cancelling is supported' });
  const inv = await Invite.findOneAndUpdate({ _id: req.params.id, status: 'expected' }, { status: 'cancelled' }, { new: true });
  if (!inv) return res.status(409).json({ error: 'Only an expected visitor who has not arrived can be cancelled' });
  audit(req.user, 'invite.cancelled', { entity: 'Invite', entityId: inv._id, details: { name: `${inv.firstName} ${inv.lastName}`, day: inv.day }, ip: req.ip });
  res.json({ ok: true });
});

// ----- Blocked visitors -----
const blockRow = (b) => ({ id: String(b._id), mobile: b.mobile, name: b.name, reason: b.reason, createdAt: b.createdAt, by: b.createdBy?.fullName || null });

router.get('/blocks', requireRole('admin'), async (req, res) => {
  const rows = await Block.find({ active: true }).sort({ createdAt: -1 }).limit(1000).populate('createdBy', 'fullName').lean();
  res.json({ rows: rows.map(blockRow) });
});

router.post('/blocks', requireRole('admin'), async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  const name = cleanText(req.body?.name, 80);
  const reason = cleanText(req.body?.reason, 200);
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number' });
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters). Guards see it at the gate.' });
  if (await Block.exists({ mobile, active: true })) return res.status(409).json({ error: 'This number is already blocked' });
  const block = await Block.create({ mobile, name, reason, createdBy: req.user.id });
  // Anyone with this number expected later must not be let in on arrival either.
  await Invite.updateMany({ mobile, status: 'expected' }, { status: 'cancelled' });
  audit(req.user, 'block.added', { entity: 'Block', entityId: block._id, details: { mobile, name, reason }, ip: req.ip });
  res.status(201).json(blockRow(block.toObject()));
});

router.patch('/blocks/:id', requireRole('admin'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (req.body?.active !== false) return res.status(400).json({ error: 'Only removing a block is supported' });
  const b = await Block.findOneAndUpdate({ _id: req.params.id, active: true }, { active: false, removedAt: new Date() }, { new: true });
  if (!b) return res.status(404).json({ error: 'Not found' });
  audit(req.user, 'block.removed', { entity: 'Block', entityId: b._id, details: { mobile: b.mobile, name: b.name }, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
