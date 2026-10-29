const config = require('../config');
const { Invite, Outbox } = require('../models');
const email = require('./email');
const { siteDay } = require('./core');

// Expected visitors: the admin enters who is coming, from which day to which day, whom they meet and, if it matters,
// the gate they should use. Every gate tablet lists today's expected people; any gate may let them in (people do
// turn up at the wrong entrance), the named gate just shows them first. Each day of the range they are let in once
// without waiting for the host, and the host is told by email that they have arrived.

// Invites from before ranges existed have no dayTo: their one day is the range.
const endOf = (i) => i.dayTo || i.day;

// Still open for `day`: in range, not called off, not already let in that day.
const openOn = (day) => ({
  status: 'expected', day: { $lte: day },
  $or: [{ dayTo: { $gte: day } }, { dayTo: { $exists: false }, day }],
  'arrivals.day': { $ne: day },
});

const forMobile = (mobile, day = siteDay()) => Invite.findOne({ mobile, ...openOn(day) }).sort({ createdAt: -1 }).populate('host').populate('gate', 'name').lean();

// "Day 2 of 5" on a range; nothing on a single day.
function dayOf(i, day = siteDay()) {
  const to = endOf(i);
  if (to === i.day) return '';
  const n = (d) => Date.parse(`${d}T00:00:00Z`) / 86400e3;
  return `Day ${n(day) - n(i.day) + 1} of ${n(to) - n(i.day) + 1}`;
}

// Let in today: claimed once, so two gates cannot both use it. The last day of the range closes the invite.
async function claim(invite, visitId, day = siteDay()) {
  const last = endOf(invite) === day;
  return Invite.findOneAndUpdate(
    { _id: invite._id, ...openOn(day) },
    { $push: { arrivals: { day, visit: visitId, at: new Date() } }, visit: visitId, ...(last ? { status: 'arrived' } : {}) },
    { new: true },
  );
}

// After the range: 'arrived' if they came on any day, 'missed' (didn't come) if never. Run by the worker.
async function closePast(today = siteDay()) {
  const past = { status: 'expected', $or: [{ dayTo: { $lt: today } }, { dayTo: { $exists: false }, day: { $lt: today } }] };
  await Invite.updateMany({ ...past, 'arrivals.0': { $exists: true } }, { status: 'arrived' });
  await Invite.updateMany(past, { status: 'missed' });
}

// "Your guest has arrived": email to the host (free). Queued, so a slow mail server never holds up the gate.
async function tellHostArrived(visit, host, gateName) {
  if (!email.enabled() || !host?.email || host.active === false) return;
  const who = `${visit.firstName} ${visit.lastName}`.trim();
  const at = new Date().toLocaleTimeString('en-IN', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' });
  const mail = email.noticeEmail({
    headline: `Your guest ${who} has arrived`,
    rows: [['Guest', who], ['Company', visit.company], ['Arrived', `${at}${gateName ? `, ${gateName}` : ''}`], ['Pass', visit.dailyNumber != null ? String(visit.dailyNumber) : ''], ['Visitor ID', visit.ref]],
    note: 'You added them as expected, so the gate let them in without asking you.',
  });
  await Outbox.create({ kind: 'email', to: host.email, body: mail.text, visit: visit._id, vars: { subject: `Your guest ${who} has arrived`, html: mail.html } });
}

module.exports = { endOf, dayOf, openOn, forMobile, claim, closePast, tellHostArrived };
