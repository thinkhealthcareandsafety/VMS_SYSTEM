const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const config = require('../config');
const { requireRole } = require('../middleware/auth');
const { Visit, Host, ApprovalToken, Outbox, Invite, Block } = require('../models');
const { retireTelegram } = require('../services/notify');
const telegram = require('../services/telegram');
const { siteDay, nextVisitorRef, nextDailyNumber, audit, sha256, normalizeMobile, cleanText, tidyName, decodeJpeg } = require('../services/core');

const router = express.Router();
const NAME_RE = /^[\p{L} .'-]{1,60}$/u;
const MAX_PHOTO = 2 * 1024 * 1024;
const MAX_ID = 3 * 1024 * 1024;

const isId = (v) => mongoose.isValidObjectId(v);
const publicVisit = (v, host, withMobile = false) => ({
  id: String(v._id),
  ref: v.ref,
  firstName: v.firstName,
  lastName: v.lastName,
  company: v.company,
  purpose: v.purpose,
  status: v.status,
  dailyNumber: v.dailyNumber ?? null,
  dailyDay: v.dailyDay ?? null,
  host: host ? { id: String(host._id), name: host.fullName, unit: host.unit, ...(withMobile ? { mobile: host.mobile } : {}) } : null,
  ...(withMobile ? { mobile: v.mobile, visitDay: v.visitDay, createdAt: v.createdAt, checkedOutAt: v.checkedOutAt, forceReason: v.forceReason, hasIdImage: Boolean(v.idImagePath), idMaskMethod: v.idMaskMethod } : {}),
  decidedAt: v.decidedAt,
  checkedOutAt: v.checkedOutAt,
});

// Creates a fresh single-use approval link and queues the SMS to the host.
async function issueApprovalLink(visit, host, visitorName, company) {
  await ApprovalToken.updateMany({ visit: visit._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  const raw = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + config.approvalTtlMinutes * 60e3);
  await ApprovalToken.create({ visit: visit._id, tokenHash: sha256(raw), expiresAt });
  const link = `${config.appBaseUrl}/approve/${raw}`;
  const from = /^(personal|self|none|na|n\/a|-)$/i.test(company) ? '' : ` from ${company}`;
  const body = `${visitorName}${from} is at the gate to meet you. Approve or reject: ${link} Link valid ${config.approvalTtlMinutes} min. -${config.sms.senderId}`;
  if (telegram.enabled() && host.telegramChatId) {
    const text = `🚪 ${visitorName}${from} is at the gate to meet you.\n\nSee their photo and details: ${link}\nValid for ${config.approvalTtlMinutes} min.`;
    await Outbox.create({ kind: 'telegram', visit: visit._id, to: String(host.telegramChatId), body: text });
  } else {
    await Outbox.create({ kind: 'sms', visit: visit._id, to: host.mobile, body });
  }
}

async function saveFile(folder, buf) {
  const dir = path.resolve(config.uploadDir, folder);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.jpg`;
  await fs.writeFile(path.join(dir, name), buf);
  return path.join(dir, name);
}

const activeVisitFor = (mobile) => Visit.findOne({ mobile, status: { $in: ['pending', 'approved'] } }).sort({ createdAt: -1 }).populate('host').lean();
const activeSummary = (v) => ({
  id: String(v._id), ref: v.ref, status: v.status, name: `${v.firstName} ${v.lastName}`,
  dailyNumber: v.dailyNumber ?? null, host: v.host ? { name: v.host.fullName, unit: v.host.unit } : null,
});
const activeMessage = (v) => (v.status === 'approved'
  ? `${v.firstName} ${v.lastName} is already inside with pass ${v.dailyNumber} (meeting ${v.host?.fullName}). Check them out before registering a new visit.`
  : `${v.firstName} ${v.lastName} is already waiting for ${v.host?.fullName} to approve. Resend or cancel that request instead.`);

// Someone the admin blocked. Checked on lookup (red warning) and again on check-in (refused).
const blockFor = (mobile) => Block.findOne({ mobile, active: true }).lean();
const blockMessage = (b) => `Do not admit${b.name ? ` ${b.name}` : ''}. This number is on the blocked list: ${b.reason}. Call your supervisor.`;
// An expected visitor for today: let in without waiting for the host.
const inviteFor = (mobile) => Invite.findOne({ mobile, day: siteDay(), status: 'expected' }).sort({ createdAt: -1 }).populate('host').lean();

// Latest message status per visit (SMS or Telegram), in one query.
async function smsStatusFor(visitIds) {
  if (!visitIds.length) return new Map();
  const rows = await Outbox.aggregate([
    { $match: { kind: { $in: ['sms', 'telegram'] }, visit: { $in: visitIds } } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$visit', status: { $first: '$status' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

// Guard check-in: captures visitor, masked Aadhaar, host, and sends approval SMS.
router.post('/', requireRole('guard', 'admin'), async (req, res) => {
  const b = req.body || {};
  const firstName = tidyName(cleanText(b.firstName, 60));
  const lastName = tidyName(cleanText(b.lastName, 60));
  const company = cleanText(b.company, 100);
  const purpose = cleanText(b.purpose, 100);
  const mobile = normalizeMobile(b.mobile);

  if (!NAME_RE.test(firstName) || !NAME_RE.test(lastName)) return res.status(400).json({ error: 'Enter a valid first and last name' });
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number' });
  if (!company) return res.status(400).json({ error: 'Company / source is required' });
  if (!isId(b.hostId)) return res.status(400).json({ error: 'Select whom to meet' });

  const host = await Host.findOne({ _id: b.hostId, active: true }).lean();
  if (!host) return res.status(400).json({ error: 'Selected host is not active' });

  const blocked = await blockFor(mobile);
  if (blocked) {
    audit(req.user, 'visit.blocked_attempt', { details: { mobile, name: `${firstName} ${lastName}`, reason: blocked.reason }, ip: req.ip });
    return res.status(403).json({ code: 'blocked', error: blockMessage(blocked) });
  }

  // One person cannot be inside, or waiting at the gate, twice.
  const active = await activeVisitFor(mobile);
  if (active) return res.status(409).json({ code: 'already_active', error: activeMessage(active), visit: activeSummary(active) });

  // Expected visitor: only honoured for the same person, today, meeting the same host.
  let invite = null;
  if (b.inviteId) {
    invite = isId(b.inviteId) ? await Invite.findOne({ _id: b.inviteId, status: 'expected' }).lean() : null;
    if (!invite || invite.mobile !== mobile || invite.day !== siteDay() || String(invite.host) !== String(host._id)) {
      return res.status(409).json({ error: 'That expected-visitor entry no longer matches. Send the request to the host instead.' });
    }
  }

  const photo = decodeJpeg(b.photo, MAX_PHOTO);
  if (!photo) return res.status(400).json({ error: 'A live photo is required' });
  const idImage = decodeJpeg(b.idImage, MAX_ID);
  if (!idImage) return res.status(400).json({ error: 'Aadhaar image is required' });
  const idMaskMethod = ['auto', 'already', 'guide'].some((m) => b.idMask === m || b.idMask === `${m}+manual`) ? b.idMask : undefined;

  let photoPath, idPath;
  try {
    photoPath = await saveFile('photos', photo);
    idPath = await saveFile('id-masked', idImage);
    const visitorName = `${firstName} ${lastName}`;
    const visit = await Visit.create({
      ref: await nextVisitorRef(),
      firstName, lastName, mobile, company, purpose,
      host: host._id,
      status: 'pending',
      visitDay: siteDay(),
      photoPath, idImagePath: idPath, idMaskMethod,
      createdBy: req.user.id,
    });
    audit(req.user, 'visit.created', { entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, host: host.fullName }, ip: req.ip });

    if (invite) {
      // Claim the invite first, so two guards cannot both use it.
      const claimed = await Invite.findOneAndUpdate({ _id: invite._id, status: 'expected' }, { status: 'arrived', visit: visit._id }, { new: true });
      if (claimed) {
        const { day, number } = await nextDailyNumber();
        Object.assign(visit, { status: 'approved', decidedAt: new Date(), checkedInAt: new Date(), dailyDay: day, dailyNumber: number });
        await visit.save();
        if (config.printer.mode !== 'off') await Outbox.create({ kind: 'print', visit: visit._id });
        audit(req.user, 'visit.approved', { entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, dailyNumber: number, via: 'expected' }, ip: req.ip });
        return res.status(201).json({ id: String(visit._id), ref: visit.ref, status: visit.status, dailyNumber: number });
      }
    }
    await issueApprovalLink(visit, host, visitorName, company);
    res.status(201).json({ id: String(visit._id), ref: visit.ref, status: visit.status });
  } catch (err) {
    await Promise.all([photoPath, idPath].filter(Boolean).map((p) => fs.rm(p, { force: true })));
    console.error('check-in failed', err);
    res.status(500).json({ error: 'Could not register visitor. Please retry.' });
  }
});

// Status poll used by the guard screen while waiting for the host.
router.get('/inside', requireRole('guard', 'admin'), async (req, res) => {
  const visits = await Visit.find({ status: 'approved' }).sort({ decidedAt: 1 }).populate('host').lean();
  const now = Date.now();
  const rows = visits.map((v) => ({
    ...publicVisit(v, v.host, req.user.role === 'admin'),
    insideMinutes: Math.round((now - new Date(v.decidedAt).getTime()) / 60000),
  }));
  res.json({ count: rows.length, visits: rows, staleAfterHours: config.maxInsideHours });
});

// Returning visitor: last known name/company for a mobile number, to prefill check-in.
router.get('/lookup', requireRole('guard', 'admin'), async (req, res) => {
  const mobile = normalizeMobile(req.query.mobile);
  if (!mobile) return res.json({ found: false });
  const [last, blocked, invite] = await Promise.all([
    Visit.findOne({ mobile }, 'firstName lastName company createdAt').sort({ createdAt: -1 }).lean(),
    blockFor(mobile),
    inviteFor(mobile),
  ]);
  const visits = last ? await Visit.countDocuments({ mobile }) : 0;
  const active = last ? await activeVisitFor(mobile) : null;
  res.json({
    found: Boolean(last),
    ...(last ? { firstName: last.firstName, lastName: last.lastName, company: last.company, lastVisit: last.createdAt, visits } : {}),
    active: active ? { ...activeSummary(active), message: activeMessage(active) } : null,
    blocked: blocked ? { message: blockMessage(blocked) } : null,
    invite: invite && invite.host?.active ? {
      id: String(invite._id), firstName: invite.firstName, lastName: invite.lastName, company: invite.company, purpose: invite.purpose, note: invite.note,
      host: { id: String(invite.host._id), name: invite.host.fullName, unit: invite.host.unit },
    } : null,
  });
});

// The guard's "waiting for host" tray: everything still undecided, no-replies from the last 30 minutes, and decisions from the last 20,
// so the guard sees each approval or decline land even after moving on to the next visitor.
router.get('/queue', requireRole('guard', 'admin'), async (req, res) => {
  const now = Date.now();
  const visits = await Visit.find({
    $or: [
      { status: 'pending', createdAt: { $gte: new Date(now - 12 * 3600e3) } },
      { status: 'expired', decidedAt: { $gte: new Date(now - 30 * 60e3) } },
      { status: { $in: ['approved', 'rejected'] }, decidedAt: { $gte: new Date(now - 20 * 60e3) } },
    ],
  }).sort({ createdAt: -1 }).limit(40).populate('host').lean();
  const sms = await smsStatusFor(visits.map((v) => v._id));
  res.json({
    rows: visits.map((v) => ({ ...publicVisit(v, v.host), createdAt: v.createdAt, smsStatus: sms.get(String(v._id))?.status || null })),
  });
});

router.get('/:id', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findById(req.params.id).populate('host').lean();
  if (!v) return res.status(404).json({ error: 'Not found' });
  const print = await Outbox.findOne({ kind: 'print', visit: v._id }).sort({ _id: -1 }).lean();
  const sms = (await smsStatusFor([v._id])).get(String(v._id));
  res.json({
    ...publicVisit(v, v.host, req.user.role === 'admin'),
    createdAt: v.createdAt,
    printStatus: config.printer.mode === 'off' ? 'off' : print ? print.status : null,
    printError: print?.status === 'failed' ? print.lastError : undefined,
    smsStatus: sms?.status || null,
  });
});

router.get('/:id/photo', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const v = await Visit.findById(req.params.id, 'photoPath').lean();
  if (!v?.photoPath) return res.status(404).end();
  res.type('jpeg').sendFile(path.resolve(v.photoPath));
});

// Admin-only, every view is audited (DPDP accountability).
router.get('/:id/id-image', requireRole('admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const v = await Visit.findById(req.params.id, 'idImagePath ref').lean();
  if (!v?.idImagePath) return res.status(404).json({ error: 'ID image not available (purged or never captured)' });
  audit(req.user, 'id_image.viewed', { entity: 'Visit', entityId: req.params.id, details: { ref: v.ref }, ip: req.ip });
  res.type('jpeg').sendFile(path.resolve(v.idImagePath));
});

// Re-sends the approval SMS (host missed it, or link expired).
router.post('/:id/resend', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findById(req.params.id).populate('host');
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (!['pending', 'expired'].includes(v.status)) {
    const why = { approved: 'This visitor is already approved', rejected: 'The host declined this visit', cancelled: 'This visit was cancelled' }[v.status] || 'This visit is already closed';
    return res.status(409).json({ error: why });
  }
  const last = await Outbox.findOne({ kind: { $in: ['sms', 'telegram'] }, visit: v._id }).sort({ _id: -1 }).lean();
  if (last && Date.now() - new Date(last.createdAt).getTime() < 30e3) {
    return res.status(429).json({ error: 'A request was just sent. Give the host a few seconds before sending another.' });
  }
  await retireTelegram(v._id, `↻ ${v.firstName} ${v.lastName}: a newer request was sent below.`);
  v.status = 'pending';
  v.decidedAt = undefined;
  await v.save();
  await issueApprovalLink(v, v.host, `${v.firstName} ${v.lastName}`, v.company);
  audit(req.user, 'visit.resent', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.json({ ok: true, status: v.status });
});

// The guard printed the pass (browser print, any printer). Recorded for the audit trail; it is also the handover.
router.post('/:id/printed', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findOne({ _id: req.params.id, status: { $in: ['approved', 'checked_out', 'force_checked_out'] } }, 'ref').lean();
  if (!v) return res.status(409).json({ error: 'No pass has been issued for this visit' });
  audit(req.user, 'pass.printed', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.json({ ok: true });
});

// Visitor gave up before the host answered. Closes the approval link too.
router.post('/:id/cancel', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['pending', 'expired'] } },
    { status: 'cancelled', decidedAt: new Date() },
    { new: true },
  );
  if (!v) return res.status(409).json({ error: 'Only a visit still waiting for the host can be cancelled' });
  await ApprovalToken.updateMany({ visit: v._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  audit(req.user, 'visit.cancelled', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  await retireTelegram(v._id, `🚫 ${v.firstName} ${v.lastName}: cancelled by the security desk.\nThe visitor left before you replied. Nothing more to do.`);
  res.json({ ok: true, status: v.status });
});

// Guard marks departure.
router.post('/:id/checkout', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: 'approved' },
    { status: 'checked_out', checkedOutAt: new Date(), checkedOutBy: req.user.id },
    { new: true },
  );
  if (!v) return res.status(409).json({ error: 'Visitor is not currently inside' });
  audit(req.user, 'visit.checked_out', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.json({ ok: true, status: v.status, checkedOutAt: v.checkedOutAt });
});

// Admin force checkout when guard forgot to mark exit. Reason is mandatory.
router.post('/:id/force-checkout', requireRole('admin'), async (req, res) => {
  const reason = cleanText(req.body?.reason, 200);
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters)' });
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: 'approved' },
    { status: 'force_checked_out', checkedOutAt: new Date(), checkedOutBy: req.user.id, forceReason: reason },
    { new: true },
  );
  if (!v) return res.status(409).json({ error: 'Visitor is not currently inside' });
  audit(req.user, 'visit.force_checked_out', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, reason }, ip: req.ip });
  res.json({ ok: true, status: v.status });
});

// Re-queues the sticker print (printer jammed / offline).
router.post('/:id/reprint', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (config.printer.mode === 'off') return res.status(409).json({ error: 'No sticker printer is connected. Write the pass number on the visitor slip.' });
  const v = await Visit.findById(req.params.id, 'status ref').lean();
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (v.status !== 'approved' && v.status !== 'checked_out' && v.status !== 'force_checked_out') return res.status(409).json({ error: 'Pass not issued yet' });
  await Outbox.create({ kind: 'print', visit: v._id });
  audit(req.user, 'sticker.reprint_requested', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.status(202).json({ ok: true });
});

module.exports = router;
