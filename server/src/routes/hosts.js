const express = require('express');
const { requireRole } = require('../middleware/auth');
const { Host } = require('../models');

// Guard "whom to meet" picker. Never returns mobile numbers to guards.
const router = express.Router();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/', requireRole('guard', 'admin'), async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const filter = { active: true };
  if (q) {
    const re = new RegExp(esc(q), 'i');
    filter.$or = [{ fullName: re }, { unit: re }];
  }
  const hosts = await Host.find(filter, 'fullName unit').sort({ unit: 1, fullName: 1 }).limit(50).lean();
  res.json({ rows: hosts.map((h) => ({ id: String(h._id), name: h.fullName, unit: h.unit })) });
});

module.exports = router;
