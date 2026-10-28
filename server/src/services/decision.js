const config = require('../config');
const { Visit, ApprovalToken, Outbox } = require('../models');
const { nextDailyNumber, audit, sha256 } = require('./core');
const { retireTelegram } = require('./notify');
const passes = require('./passes');

// One place decides what a host's tap does, whether it came from the web link or a Telegram button.
// The single-use token is the only credential.
async function findByToken(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
  const token = await ApprovalToken.findOne({ tokenHash: sha256(raw) }).lean();
  if (!token) return null;
  const visit = await Visit.findById(token.visit).populate('host').lean();
  return visit ? { token, visit } : null;
}

const CLOSED_REASON = {
  approved: 'You already approved this visitor.',
  rejected: 'You already declined this visit.',
  expired: 'This request expired. Ask the security desk to send a new link.',
  cancelled: 'The security desk cancelled this request. The visitor has left.',
  checked_out: 'This visit is over.',
  force_checked_out: 'This visit is over.',
};

// Approval in one write: the status, today's pass number, the start of the pass and the walk in at the gate where the
// visitor was checked in land together, so a crash or power cut can never leave someone approved without a pass number.
// Only from the statuses in `from`; null when someone else decided first (that pass number is then simply skipped).
async function approve(visit, from, extra = {}) {
  const { day, number } = await nextDailyNumber();
  const now = new Date();
  const a = visit.arrival || {};
  const claimed = await Visit.findOneAndUpdate(
    { _id: visit._id, status: { $in: from } },
    {
      status: 'approved', decidedAt: now, dailyDay: day, dailyNumber: number, checkedInAt: now,
      validUntil: passes.validUntil(visit.validity, now),
      movements: [passes.movement('in', { id: a.gate, name: a.gateName }, { id: a.by, fullName: a.byName }, now)],
      ...extra,
    },
    { new: true },
  );
  if (claimed && config.printer.mode !== 'off') await Outbox.create({ kind: 'print', visit: claimed._id });
  return claimed;
}

// The host did not answer the message but said yes on the phone: the guard lets the visitor in, noting who said so.
// Waiting (or expired) visits only; the open link stops working; the audit names the guard.
async function approveByPhone(id, user, note, ip) {
  const said = String(note || '').trim().slice(0, 120);
  if (said.length < 3) return { status: 400, body: { error: 'Write who said yes on the phone, e.g. "Asha Verma, on her mobile"' } };
  const visit = await Visit.findById(id).lean();
  if (!visit) return { status: 404, body: { error: 'Not found' } };
  const closed = { status: 409, body: { error: (CLOSED_REASON[visit.status] || 'This visit is already closed').replace('You already', 'The host already') } };
  if (!['pending', 'expired'].includes(visit.status)) return closed;
  const claimed = await approve(visit, ['pending', 'expired'], { phoneApproval: { by: user.id, byName: user.fullName, note: said } });
  if (!claimed) return closed;
  await ApprovalToken.updateMany({ visit: claimed._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  audit(user, 'visit.approved_by_phone', { entity: 'Visit', entityId: claimed._id, details: { ref: claimed.ref, dailyNumber: claimed.dailyNumber, note: said }, ip });
  await retireTelegram(claimed._id, `✅ ${claimed.firstName} ${claimed.lastName} was let in after your call with the security desk.`);
  return { status: 200, body: { ok: true, status: claimed.status, dailyNumber: claimed.dailyNumber } };
}

// Returns { status, body, visit? }. `via` is recorded in the audit trail ('link' or 'telegram').
async function decide(raw, decision, { ip, via = 'link' } = {}) {
  if (decision !== 'approve' && decision !== 'reject') return { status: 400, body: { error: 'Decision must be approve or reject' } };
  const found = await findByToken(raw);
  if (!found) return { status: 404, body: { error: 'This link is invalid' } };
  const { token, visit } = found;
  // Most specific reason first, so the host is never told something misleading.
  if (visit.status !== 'pending') return { status: 409, visit, body: { error: CLOSED_REASON[visit.status] || 'This visit is already closed', state: visit.status } };
  if (token.usedAt) return { status: 409, visit, body: { error: 'A newer link was sent for this visitor. Use the latest message from the security desk.', state: 'superseded' } };
  if (token.expiresAt < new Date()) return { status: 410, visit, body: { error: 'This request has expired. Ask the security desk to send a new one.', state: 'expired' } };

  // Claim the visit atomically: only one decision can win if the host taps twice.
  const claimed = decision === 'approve'
    ? await approve(visit, ['pending'])
    : await Visit.findOneAndUpdate({ _id: visit._id, status: 'pending' }, { status: 'rejected', decidedAt: new Date() }, { new: true });
  if (!claimed) return { status: 409, visit, body: { error: 'Already decided' } };
  await ApprovalToken.updateOne({ _id: token._id }, { usedAt: new Date() });

  audit({ label: `host:${visit.host._id}`, role: 'host' }, decision === 'approve' ? 'visit.approved' : 'visit.rejected', {
    entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, dailyNumber: claimed.dailyNumber, ...(via !== 'link' ? { via } : {}) }, ip,
  });
  if (via !== 'telegram') {
    const name = `${visit.firstName} ${visit.lastName}`;
    await retireTelegram(visit._id, decision === 'approve' ? `✅ You let ${name} in (on the web page).` : `❌ You declined ${name} (on the web page).`);
  }
  return { status: 200, visit, body: { ok: true, status: claimed.status, dailyNumber: claimed.dailyNumber ?? null } };
}

module.exports = { findByToken, decide, approveByPhone, CLOSED_REASON };
