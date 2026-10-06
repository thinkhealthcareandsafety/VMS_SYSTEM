const express = require('express');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const { findByToken, decide } = require('../services/decision');

// Hosts open this from an SMS link. No login: the single-use token is the credential.
const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60e3, limit: 60, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

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

router.post('/:token/decision', async (req, res) => {
  const { status, body } = await decide(req.params.token, req.body?.decision, { ip: req.ip });
  res.status(status).json(body);
});

module.exports = router;
