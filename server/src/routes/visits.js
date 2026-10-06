const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const config = require('../config');
const { requireRole } = require('../middleware/auth');
const { Visit, Host, ApprovalToken, Outbox } = require('../models');
const { siteDay, nextVisitorRef, audit, sha256, normalizeMobile, cleanText, decodeJpeg } = require('../services/core');

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
  ...(withMobile ? { mobile: v.mobile, visitDay: v.visitDay, createdAt: v.createdAt, checkedOutAt: v.checkedOutAt, forceReason: v.forceReason, hasIdImage: Boolean(v.idImagePath) } : {}),
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
  const body = `${visitorName} from ${company} is at the gate to meet you. Approve or reject: ${link} Link valid ${config.approvalTtlMinutes} min. -${config.sms.senderId}`;
  await Outbox.create({ kind: 'sms', visit: visit._id, to: host.mobile, body });
}

async function saveFile(folder, buf) {
  const dir = path.resolve(config.uploadDir, folder);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.jpg`;
  await fs.writeFile(path.join(dir, name), buf);
  return path.join(dir, name);
}

// Guard check-in: captures visitor, masked Aadhaar, host, and sends approval SMS.
router.post('/', requireRole('guard', 'admin'), async (req, res) => {
  const b = req.body || {};
  const firstName = cleanText(b.firstName, 60);
  const lastName = cleanText(b.lastName, 60);
  const company = cleanText(b.company, 100);
  const purpose = cleanText(b.purpose, 100);
  const mobile = normalizeMobile(b.mobile);

  if (!NAME_RE.test(firstName) || !NAME_RE.test(lastName)) return res.status(400).json({ error: 'Enter a valid first and last name' });
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number' });
  if (!company) return res.status(400).json({ error: 'Company / source is required' });
  if (!isId(b.hostId)) return res.status(400).json({ error: 'Select whom to meet' });
  if (b.idMaskConfirmed !== true) return res.status(400).json({ error: 'Confirm the Aadhaar number is fully masked' });

  const host = await Host.findOne({ _id: b.hostId, active: true }).lean();
  if (!host) return res.status(400).json({ error: 'Selected host is not active' });

  const photo = decodeJpeg(b.photo, MAX_PHOTO);
  if (!photo) return res.status(400).json({ error: 'A live photo is required' });
  const idImage = decodeJpeg(b.idImage, MAX_ID);
  if (!idImage) return res.status(400).json({ error: 'Aadhaar image is required' });

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
      photoPath, idImagePath: idPath,
      createdBy: req.user.id,
    });
    await issueApprovalLink(visit, host, visitorName, company);
    audit(req.user, 'visit.created', { entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, host: host.fullName }, ip: req.ip });
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
  const last = await Visit.findOne({ mobile }, 'firstName lastName company createdAt').sort({ createdAt: -1 }).lean();
  const visits = last ? await Visit.countDocuments({ mobile }) : 0;
  res.json(last ? { found: true, firstName: last.firstName, lastName: last.lastName, company: last.company, lastVisit: last.createdAt, visits } : { found: false });
});

router.get('/:id', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findById(req.params.id).populate('host').lean();
  if (!v) return res.status(404).json({ error: 'Not found' });
  const print = await Outbox.findOne({ kind: 'print', visit: v._id }).sort({ _id: -1 }).lean();
  res.json({
    ...publicVisit(v, v.host, req.user.role === 'admin'),
    createdAt: v.createdAt,
    printStatus: print ? print.status : null,
    printError: print?.status === 'failed' ? print.lastError : undefined,
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
  if (!['pending', 'expired'].includes(v.status)) return res.status(409).json({ error: `Cannot resend a ${v.status} visit` });
  v.status = 'pending';
  v.decidedAt = undefined;
  await v.save();
  await issueApprovalLink(v, v.host, `${v.firstName} ${v.lastName}`, v.company);
  audit(req.user, 'visit.resent', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
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
  const v = await Visit.findById(req.params.id, 'status ref').lean();
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (v.status !== 'approved' && v.status !== 'checked_out' && v.status !== 'force_checked_out') return res.status(409).json({ error: 'Pass not issued yet' });
  await Outbox.create({ kind: 'print', visit: v._id });
  audit(req.user, 'sticker.reprint_requested', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.status(202).json({ ok: true });
});

module.exports = router;
