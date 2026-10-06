const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { User } = require('../models');
const { signSession, setSessionCookie, COOKIE, loadUser, requireRole } = require('../middleware/auth');
const { audit, passwordProblem } = require('../services/core');

const router = express.Router();

// Keyed on address + username: if a proxy ever hides real addresses, one person's typos still cannot lock out everyone.
const loginLimiter = rateLimit({
  windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.username || '').toLowerCase().slice(0, 50)}`,
  message: { error: 'Too many attempts. Wait 15 minutes, or ask your admin to reset your password.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = z.object({ username: z.string().min(1).max(50), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Username and password required' });
  const user = await User.findOne({ username: parsed.data.username.trim().toLowerCase(), active: true }).select('+passwordHash');
  // Copy-pasting a password often drags a space or line break along. Accept it exactly as typed first,
  // then with the edges trimmed. (Generated passwords never contain spaces, and a trimmed match is still a full match.)
  const typed = parsed.data.password;
  let ok = Boolean(user) && (await bcrypt.compare(typed, user.passwordHash));
  if (!ok && user && typed !== typed.trim() && typed.trim()) ok = await bcrypt.compare(typed.trim(), user.passwordHash);
  if (!ok) {
    audit({ label: parsed.data.username }, 'auth.login_failed', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
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

// Change your own password. Signs out every other device; this one gets a fresh session.
const pwLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false });
router.post('/password', pwLimiter, requireRole(), async (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  if (current === next) return res.status(400).json({ error: 'Choose a password different from the current one' });
  const user = await User.findById(req.user.id).select('+passwordHash');
  if (!user || !(await bcrypt.compare(current, user.passwordHash))) return res.status(400).json({ error: 'Current password is not correct' });
  user.passwordHash = await bcrypt.hash(next, 12);
  user.sessionVersion = (user.sessionVersion || 0) + 1;
  await user.save();
  setSessionCookie(res, signSession(user));
  audit(req.user, 'auth.password_changed', { entity: 'User', entityId: user._id, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
