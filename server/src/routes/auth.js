const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { User } = require('../models');
const { signSession, setSessionCookie, COOKIE, loadUser } = require('../middleware/auth');
const { audit } = require('../services/core');

const router = express.Router();

// Keyed on address + username: if a proxy ever hides real addresses, one person's typos still cannot lock out everyone.
const loginLimiter = rateLimit({
  windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.username || '').toLowerCase().slice(0, 50)}`,
});

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = z.object({ username: z.string().min(1).max(50), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Username and password required' });
  const user = await User.findOne({ username: parsed.data.username.toLowerCase(), active: true }).select('+passwordHash');
  const ok = user && (await bcrypt.compare(parsed.data.password, user.passwordHash));
  if (!ok) {
    audit({ label: parsed.data.username }, 'auth.login_failed', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  setSessionCookie(res, signSession(user));
  audit({ username: user.username, role: user.role }, 'auth.login', { ip: req.ip });
  res.json({ id: String(user._id), username: user.username, fullName: user.fullName, role: user.role });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', httpOnly: true });
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json(user);
});

module.exports = router;
