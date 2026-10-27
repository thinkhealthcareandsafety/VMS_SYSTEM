const { Visit, Guest, Group, Block, Host } = require('../models');
const config = require('../config');
const { audit } = require('./core');
const passes = require('./passes');
const groups = require('./groups');

// One scan at any gate does the right thing for whoever holds the pass:
//   inside                      -> out (a pass that runs past today stays valid, as at the desk)
//   outside on a valid pass     -> in again, no new approval
//   an event guest not yet in   -> in, on the guest list
//   anything else               -> a plain reason, and nobody moves
// A pass scanned twice within a minute is not flipped back: the second scan only says what just happened.
const BOUNCE_MS = 60e3;
const UNDO_MS = 30e3;

const nameOf = (v) => `${v.firstName} ${v.lastName}`.trim();
const lastMove = (v) => (v.movements || [])[(v.movements || []).length - 1] || null;
const until = (d) => new Intl.DateTimeFormat('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
const secondsAgo = (at) => Math.max(1, Math.round((Date.now() - new Date(at).getTime()) / 1000));

async function card(v, extra = {}) {
  const host = v.host?.fullName ? v.host : v.host ? await Host.findById(v.host, 'fullName unit').lean() : null;
  const group = v.group ? await Group.findById(v.group, 'name').lean() : null;
  return {
    id: String(v._id), ref: v.ref, name: nameOf(v), company: v.company, status: v.status,
    dailyNumber: v.dailyNumber ?? null, dailyDay: v.dailyDay ?? null, validUntil: v.validUntil ?? null,
    host: host ? { name: host.fullName, unit: host.unit } : null, group: group ? group.name : null,
    card: v.card?.no ? { no: v.card.no, type: v.card.type || 'visitor' } : null, ...extra,
  };
}

const reply = async (result, message, visit, extra = {}) => ({
  result, ok: ['in', 'out'].includes(result), message, visit: visit ? await card(visit) : null, ...extra,
});

async function checkOut(v, user, ip) {
  const now = new Date();
  const gate = await passes.gateOf(user.id);
  const keep = passes.staysOpen(v.validity, v.validUntil, now);
  const exit = passes.movement('out', gate, user, now);
  const done = await Visit.findOneAndUpdate(
    { _id: v._id, status: 'approved' },
    keep ? { status: 'away', $push: { movements: exit } } : { status: 'checked_out', checkedOutAt: now, checkedOutBy: user.id, $push: { movements: exit } },
    { new: true },
  ).lean();
  if (!done) return reply('busy', 'Another gate just recorded this person. Scan again.', v);
  audit(user, keep ? 'visit.went_out' : 'visit.checked_out', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, gate: gate.name, via: 'scan' }, ip });
  const ended = v.validUntil && new Date(v.validUntil) < now;
  // The hotel's lanyard card comes back at every exit, even on a pass that stays valid.
  const cardBack = v.card?.no ? ` Collect ${v.card.type === 'vendor' ? 'vendor' : 'visitor'} card ${v.card.no}.` : '';
  return reply('out', keep
    ? `They keep the pass: it is valid till ${until(v.validUntil)}. Scan it again when they come back.${cardBack}`
    : `${ended ? 'Their pass had already ended. ' : ''}Take the pass back.${cardBack}`, done, { undo: { action: 'out', seconds: UNDO_MS / 1000 } });
}

async function letBackIn(v, user, ip) {
  if (v.mobile && (await Block.exists({ mobile: v.mobile, active: true }))) {
    audit(user, 'visit.blocked_attempt', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, via: 'scan' }, ip });
    return reply('blocked', 'Do not admit. This person is on the blocked list. Call your supervisor.', v);
  }
  const now = new Date();
  const gate = await passes.gateOf(user.id);
  const done = await Visit.findOneAndUpdate(
    { _id: v._id, status: 'away', validUntil: { $gt: now } },
    { status: 'approved', $unset: { card: 1 }, $push: { movements: passes.movement('in', gate, user, now) } }, // the card came back at exit
    { new: true },
  ).lean();
  if (!done) return reply('ended', 'This pass has ended. Check them in as a new visitor.', v);
  audit(user, 'visit.reentered', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, gate: gate.name, via: 'scan' }, ip });
  return reply('in', `Let them in. Same pass, no new approval needed.${v.card?.no ? ' Give them a lanyard card and note its number.' : ''}`, done, { undo: { action: 'in', seconds: UNDO_MS / 1000 } });
}

// A visit found by its pass: what the scan does depends on where the person is now.
async function scanVisit(v, user, ip) {
  const last = lastMove(v);
  const recent = last && Date.now() - new Date(last.at).getTime() < BOUNCE_MS;
  if (v.status === 'approved') {
    if (recent && last.kind === 'in') return reply('just_in', `Let in ${secondsAgo(last.at)} seconds ago. Nothing changed. To check them out now, use the On premises list.`, v);
    return checkOut(v, user, ip);
  }
  if (v.status === 'away') {
    if (recent && last.kind === 'out') return reply('just_out', `Checked out ${secondsAgo(last.at)} seconds ago. Nothing changed.`, v);
    if (!v.validUntil || new Date(v.validUntil) <= new Date()) return reply('ended', 'This pass has ended. Check them in as a new visitor.', v);
    return letBackIn(v, user, ip);
  }
  if (['checked_out', 'force_checked_out'].includes(v.status)) {
    if (recent && last.kind === 'out') return reply('just_out', `Checked out ${secondsAgo(last.at)} seconds ago. Nothing changed.`, v);
    return reply('ended', 'This pass has been used and is closed. Check them in as a new visitor.', v);
  }
  if (v.status === 'pending') return reply('waiting', 'Still waiting for the host to approve. Do not let them in yet.', v);
  if (v.status === 'rejected') return reply('declined', 'The host declined this visit. Do not let them in.', v);
  return reply('ended', 'This visit was never let in. Check them in as a new visitor.', v);
}

// An event guest's pass: in on the list the first time; out and back in like any pass after that.
async function scanGuest(guest, user, ip) {
  const group = await Group.findById(guest.group).lean();
  if (!group) return { result: 'unknown', ok: false, message: 'No one has this pass. Check them in as a visitor.' };
  const current = guest.visit ? await Visit.findById(guest.visit).lean() : null;
  if (current && current.status === 'approved') return scanVisit(current, user, ip);
  const out = await groups.admit(guest, group, user);
  const result = { let_in: 'in', reentered: 'in', inside: 'just_in', not_today: 'not_today', cancelled: 'ended', removed: 'ended', blocked: 'blocked', busy: 'busy' }[out.result] || out.result;
  const visit = out.visit || current;
  const extra = result === 'in' ? { undo: { action: 'in', seconds: UNDO_MS / 1000 } } : {};
  return {
    result, ok: result === 'in', message: result === 'in' ? `Let them in. Guest of ${group.name}.` : out.message,
    visit: visit ? await card(visit) : { name: `${guest.firstName} ${guest.lastName}`.trim(), group: group.name, company: guest.company },
    ...extra,
  };
}

async function scan(raw, user, ip) {
  const code = groups.readCode(raw);
  if (!code) return { result: 'unknown', ok: false, message: 'That is not a pass from this site. Check the code, or check them in as a visitor.' };
  const visit = await Visit.findOne({ passCode: code }).populate('host', 'fullName unit').lean();
  if (visit && !visit.guest) return scanVisit(visit, user, ip);
  const guest = await Guest.findOne({ code }).lean();
  if (guest) return scanGuest(guest, user, ip);
  if (visit) return scanVisit(visit, user, ip);
  return { result: 'unknown', ok: false, message: 'No pass has this code. Check them in as a visitor.' };
}

// Undo a scan made by mistake, within 30 seconds: the last entry or exit is taken back.
async function undo(id, action, user, ip) {
  const v = await Visit.findById(id).lean();
  const last = v && lastMove(v);
  if (!v || !last || last.kind !== action || Date.now() - new Date(last.at).getTime() > UNDO_MS) {
    return { status: 409, body: { error: 'Too late to undo. Use the On premises list instead.' } };
  }
  let done;
  if (action === 'out') {
    done = await Visit.findOneAndUpdate(
      { _id: v._id, status: { $in: ['away', 'checked_out'] }, 'movements.at': last.at },
      { $set: { status: 'approved' }, $unset: { checkedOutAt: 1, checkedOutBy: 1 }, $pop: { movements: 1 } },
      { new: true },
    ).lean();
  } else {
    const first = (v.movements || []).length === 1;
    // A first entry (an event guest just let in) cannot be taken back into "never came"; only a return can.
    if (first) return { status: 409, body: { error: 'A first entry cannot be undone. Check them out instead.' } };
    done = await Visit.findOneAndUpdate(
      { _id: v._id, status: 'approved', 'movements.at': last.at },
      { $set: { status: 'away' }, $pop: { movements: 1 } },
      { new: true },
    ).lean();
  }
  if (!done) return { status: 409, body: { error: 'Something changed meanwhile. Check the On premises list.' } };
  audit(user, 'visit.scan_undone', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, undone: action === 'out' ? 'exit' : 'entry' }, ip });
  return { status: 200, body: { ok: true, status: done.status, message: action === 'out' ? 'Undone: they are inside again.' : 'Undone: they are outside again.' } };
}

// Passes printed before pass codes existed get one, so every pass in use can be scanned.
async function backfillPassCodes() {
  const { newPassCode } = require('../models');
  const old = await Visit.find({ passCode: { $exists: false }, status: { $in: ['approved', 'away'] } }, '_id').limit(5000).lean();
  for (const v of old) await Visit.updateOne({ _id: v._id, passCode: { $exists: false } }, { $set: { passCode: newPassCode() } });
  return old.length;
}

module.exports = { scan, undo, backfillPassCodes, BOUNCE_MS, UNDO_MS };
