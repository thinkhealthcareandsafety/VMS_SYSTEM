const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Material, Parcel } = require('../models');
const passes = require('../services/passes');
const settings = require('../services/settings');
const { siteDay, audit } = require('../services/core');
const materialRoutes = require('./material');
const parcelRoutes = require('./parcels');

// The day's registers for the paper file: material received, parcels in and parcels out, each entered on that site day.
// The screen lays them out on A4 and prints them.
const router = express.Router();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/daily', requireRole('admin'), async (req, res) => {
  const today = siteDay();
  const day = DAY_RE.test(req.query.day || '') ? req.query.day : today;
  if (day > today) return res.status(400).json({ error: 'Pick today or an earlier day' });
  const createdAt = { $gt: passes.endOfSiteDay(passes.addDays(day, -1)), $lte: passes.endOfSiteDay(day) };
  const [material, parcelsIn, parcelsOut, { siteName }] = await Promise.all([
    Material.find({ direction: 'in', createdAt }).sort({ createdAt: 1 }).populate('approver').lean(),
    Parcel.find({ direction: 'in', createdAt, status: { $ne: 'void' } }).sort({ createdAt: 1 }).populate('host').lean(),
    Parcel.find({ direction: 'out', createdAt, status: { $ne: 'void' } }).sort({ createdAt: 1 }).populate('host').lean(),
    settings.get(),
  ]);
  audit(req.user, 'report.daily', { details: { day, material: material.length, parcelsIn: parcelsIn.length, parcelsOut: parcelsOut.length }, ip: req.ip });
  res.json({
    day, siteName, printedBy: req.user.fullName || req.user.username,
    material: material.map((m) => materialRoutes.row(m, true)),
    parcelsIn: parcelsIn.map(parcelRoutes.row),
    parcelsOut: parcelsOut.map(parcelRoutes.row),
  });
});

module.exports = router;
