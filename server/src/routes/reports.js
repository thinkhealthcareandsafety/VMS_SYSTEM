const express = require('express');
const { requireRole } = require('../middleware/auth');
const settings = require('../services/settings');
const dailyReport = require('../services/dailyReport');
const { siteDay, audit } = require('../services/core');
const materialRoutes = require('./material');
const parcelRoutes = require('./parcels');

// The day's registers for the paper file: material received, parcels in and parcels out, each entered on that site day.
// The screen lays them out on A4 and prints them; the same report goes out by email as a PDF every night.
const router = express.Router();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pickDay = (v) => (DAY_RE.test(v || '') ? v : siteDay());

router.get('/daily', requireRole('admin'), async (req, res) => {
  const day = pickDay(req.query.day);
  if (day > siteDay()) return res.status(400).json({ error: 'Pick today or an earlier day' });
  const [{ material, parcelsIn, parcelsOut }, { siteName }] = await Promise.all([dailyReport.dayData(day), settings.get()]);
  audit(req.user, 'report.daily', { details: { day, material: material.length, parcelsIn: parcelsIn.length, parcelsOut: parcelsOut.length }, ip: req.ip });
  res.json({
    day, siteName, printedBy: req.user.fullName || req.user.username,
    material: material.map((m) => materialRoutes.row(m, true)),
    parcelsIn: parcelsIn.map(parcelRoutes.row),
    parcelsOut: parcelsOut.map(parcelRoutes.row),
  });
});

// "Email it now": the chosen day's report to the addresses in Settings, without waiting for midnight.
router.post('/daily/email', requireRole('admin'), async (req, res) => {
  const day = pickDay(req.body?.day);
  if (day > siteDay()) return res.status(400).json({ error: 'Pick today or an earlier day' });
  try {
    res.json({ day, ...(await dailyReport.send(day, { actor: req.user })) });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.status ? err.message : `The email could not be sent: ${err.message || err}. Check the email settings and try again.` });
  }
});

module.exports = router;
