const jwt = require('jsonwebtoken');
const { User } = require('../models');

const COOKIE = 'vms_session';

function signSession(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, process.env.JWT_SECRET, { expiresIn: `${process.env.SESSION_HOURS || 12}h` });
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: Number(process.env.SESSION_HOURS || 12) * 3600e3,
  });
}

// Loads the user on every request so deactivating an account takes effect immediately.
async function loadUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findOne({ _id: payload.sub, active: true }).lean();
    return user ? { id: String(user._id), username: user.username, fullName: user.fullName, role: user.role } : null;
  } catch {
    return null;
  }
}

function requireRole(...roles) {
  return async (req, res, next) => {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: 'Login required' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Not allowed for this role' });
    req.user = user;
    next();
  };
}

module.exports = { COOKIE, signSession, setSessionCookie, requireRole, loadUser };
