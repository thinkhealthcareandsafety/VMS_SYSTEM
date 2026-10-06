const express = require('express');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const { Visit, Host, ApprovalToken, Outbox } = require('../models');
const config = require('../config');
const { nextDailyNumber, audit, sha256 } = require('../services/core');

// Hosts open this from an SMS link. No login: the single-use token is the credential.
const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60e3, limit: 60, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

async function findByToken(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
  const token = await ApprovalToken.findOne({ tokenHash: sha256(raw) }).lean();
  if (!token) return null;
  const visit = await Visit.findById(token.visit).populate('host').lean();
  return visit ? { token, visit } : null;
}

router.get('/:token', async (req, res) => {
  const found = await findByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This link is invalid' });
  const { token, visit } = found;
  let state = visit.status;
  if (token.usedAt && visit.status === 'pending') state = 'superseded';
  else if (visit.status === 'pending' && token.expiresAt < new Date()) state = 'expired';
  res.json({
    ref: visit.ref,
    firstName: visit.firstName,
    lastName: visit.lastName,
    company: visit.company,
    purpose: visit.purpose,
    hostName: visit.host.fullName,
    state,
    expiresAt: token.expiresAt,
    arrivedAt: visit.createdAt,
    hostUnit: visit.host.unit,
    photoUrl: `/api/approvals/${req.params.token}/photo`,
  });
});

router.get('/:token/photo', async (req, res) => {
  const found = await findByToken(req.params.token);
  if (!found?.visit.photoPath) return res.status(404).end();
  // Data minimisation: a request closed without a visit, or a link more than a day old, no longer shows the photo.
  const stale = new Date(found.token.expiresAt).getTime() < Date.now() - 24 * 3600e3;
  if (stale || ['cancelled', 'expired'].includes(found.visit.status)) return res.status(404).end();
  res.type('jpeg').sendFile(path.resolve(found.visit.photoPath));
});

const CLOSED_REASON = {
  approved: 'You already approved this visitor.',
  rejected: 'You already declined this visit.',
  expired: 'This request expired. Ask the security desk to send a new link.',
  cancelled: 'The security desk cancelled this request. The visitor has left.',
  checked_out: 'This visit is over.',
  force_checked_out: 'This visit is over.',
};

router.post('/:token/decision', async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: 'Decision must be approve or reject' });

  const found = await findByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'This link is invalid' });
  const { token, visit } = found;
  // Most specific reason first, so the host is never told something misleading.
  if (visit.status !== 'pending') return res.status(409).json({ error: CLOSED_REASON[visit.status] || 'This visit is already closed', state: visit.status });
  if (token.usedAt) return res.status(409).json({ error: 'A newer link was sent for this visitor. Open the latest SMS from the security desk.', state: 'superseded' });
  if (token.expiresAt < new Date()) return res.status(410).json({ error: 'This link has expired. Ask the security desk to send a new one.', state: 'expired' });

  // Claim the visit atomically: only one decision can win if the host taps twice.
  const claimed = await Visit.findOneAndUpdate(
    { _id: visit._id, status: 'pending' },
    { status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: new Date() },
    { new: true },
  );
  if (!claimed) return res.status(409).json({ error: 'Already decided' });
  await ApprovalToken.updateOne({ _id: token._id }, { usedAt: new Date() });

  if (decision === 'approve') {
    const { day, number } = await nextDailyNumber();
    claimed.dailyDay = day;
    claimed.dailyNumber = number;
    claimed.checkedInAt = new Date();
    await claimed.save();
    if (config.printer.mode !== 'off') await Outbox.create({ kind: 'print', visit: claimed._id });
  }

  audit({ label: `host:${visit.host._id}`, role: 'host' }, decision === 'approve' ? 'visit.approved' : 'visit.rejected', {
    entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, dailyNumber: claimed.dailyNumber }, ip: req.ip,
  });
  res.json({ ok: true, status: claimed.status, dailyNumber: claimed.dailyNumber ?? null });
});

module.exports = router;
