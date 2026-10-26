const fs = require('node:fs/promises');
const config = require('../config');
const { Visit, Outbox, ApprovalToken, Parcel } = require('../models');
const { sendSms, buildStickerZpl, deliverZpl } = require('./messaging');
const telegram = require('./telegram');
const whatsapp = require('./whatsapp');
const email = require('./email');
const { audit } = require('./core');
const { publish } = require('./events');
const settings = require('./settings');
const { retireTelegram, whatsappFallback } = require('./notify');
const passes = require('./passes');
const parcels = require('./parcels');
const overstay = require('./overstay');

const backoffMs = (attempts) => Math.min(60000, 2 ** attempts * 1000);
// The single-use token in a request's link: a visitor, a material gate pass or a parcel.
const LINK_TOKEN = /\/(?:approve|approve-material|parcel)\/([\w-]+)/;

// Emergency messages go first and ten at a time, so a whole building hears within seconds, not minutes;
// everything else follows in order.
async function processOutbox() {
  const due = { status: { $in: ['queued', 'failed'] }, attempts: { $lt: config.worker.maxAttempts }, nextAttemptAt: { $lte: new Date() } };
  const urgent = await Outbox.find({ ...due, emergency: { $exists: true } }).sort({ _id: 1 }).limit(300);
  for (let i = 0; i < urgent.length; i += 10) await Promise.all(urgent.slice(i, i + 10).map(deliver));
  const jobs = await Outbox.find({ ...due, emergency: { $exists: false } }).sort({ _id: 1 }).limit(20);
  for (const job of jobs) await deliver(job);
}

async function deliver(job) {
  try {
    if (job.kind === 'sms') {
      job.providerRef = await sendSms(job.to, job.body, job.vars || {});
    } else if (job.kind === 'telegram' && job.vars?.plain) {
      job.providerRef = String((await telegram.say(job.to, job.body, { disable_web_page_preview: true })).message_id);
    } else if (job.kind === 'whatsapp' && job.vars?.plain) {
      job.providerRef = String((await whatsapp.say(job.to, job.body)).messages?.[0]?.id || 'accepted');
    } else if (job.kind === 'telegram') {
      const token = LINK_TOKEN.exec(job.body)?.[1];
      if (!token) throw new Error('Approval link missing from message');
      job.providerRef = await telegram.sendApproval(job.to, job.body, token, job.vars?.prefix || '');
    } else if (job.kind === 'whatsapp') {
      const token = LINK_TOKEN.exec(job.body)?.[1];
      if (!token) throw new Error('Approval link missing from message');
      // The picture on top: the visitor's photo, or the first photo of the parcel.
      const visit = job.visit ? await Visit.findById(job.visit, 'photoPath').lean() : null;
      const parcel = job.parcel ? await Parcel.findById(job.parcel, 'photos').lean() : null;
      job.providerRef = await whatsapp.sendApproval(job.to, job.body, token, visit?.photoPath || parcel?.photos?.[0], job.vars?.prefix || '');
    } else if (job.kind === 'email') {
      job.providerRef = await email.send(job.to, job.vars?.subject || 'Security desk', job.vars?.html, job.body);
    } else if (job.kind === 'print') {
      const visit = await Visit.findById(job.visit).populate('host').lean();
      if (!visit) throw new Error('Visit not found');
      const d = new Date(visit.decidedAt || Date.now());
      const dateStr = d.toLocaleDateString('en-IN', { timeZone: config.timezone });
      const timeStr = d.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
      const until = visit.validUntil ? new Date(visit.validUntil).toLocaleString('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
      const zpl = buildStickerZpl(visit, visit.host.unit, visit.host.fullName, timeStr, dateStr, until);
      job.providerRef = await deliverZpl(zpl, visit.ref);
    }
    job.status = 'sent';
    job.sentAt = new Date();
    job.lastError = undefined;
    publish(`${job.kind}.sent`, { visitId: job.visit ? String(job.visit) : undefined });
  } catch (err) {
    job.attempts = err.permanent ? config.worker.maxAttempts : job.attempts + 1;
    job.lastError = String(err.message || err).slice(0, 300);
    job.status = job.attempts >= config.worker.maxAttempts ? 'failed' : 'queued';
    job.nextAttemptAt = new Date(Date.now() + backoffMs(job.attempts));
    if (job.status === 'failed') audit({ label: 'system' }, `${job.kind}.failed`, { entity: 'Visit', entityId: job.visit, details: { error: job.lastError } });
  }
  await job.save();
  if (job.kind === 'whatsapp' && job.status === 'failed') await whatsappFallback(job).catch((e) => console.error('[whatsapp] fallback failed:', e.message));
}

// Pending approvals whose latest link has expired become "expired" (guard can resend).
async function expireStaleApprovals() {
  const pending = await Visit.find({ status: 'pending' }, '_id ref firstName lastName').lean();
  for (const v of pending) {
    const latest = await ApprovalToken.findOne({ visit: v._id }).sort({ expiresAt: -1 }).lean();
    if (latest && latest.expiresAt < new Date()) {
      const r = await Visit.updateOne({ _id: v._id, status: 'pending' }, { status: 'expired', decidedAt: new Date() });
      if (r.modifiedCount) {
        audit({ label: 'system' }, 'visit.expired', { entity: 'Visit', entityId: v._id, details: { ref: v.ref } }); // also tells open screens
        await retireTelegram(v._id, `⌛ ${v.firstName} ${v.lastName}: no reply in time.\nThe security desk can send a new request.`);
      }
    }
  }
}

// A pass holder who is out when the pass runs out: the visit closes at their last exit. Someone still inside
// is never checked out by the system; the gate and admin see their pass as expired instead.
async function closeExpiredPasses() {
  const due = await Visit.find({ status: 'away', validUntil: { $lte: new Date() } }, '_id ref movements').limit(200).lean();
  for (const v of due) {
    const lastOut = passes.entryExit(v).exit?.at || new Date();
    const r = await Visit.updateOne({ _id: v._id, status: 'away' }, { status: 'checked_out', checkedOutAt: lastOut });
    if (r.modifiedCount) audit({ label: 'system' }, 'visit.pass_expired', { entity: 'Visit', entityId: v._id, details: { ref: v.ref } });
  }
}

// Event guests rarely sign out: once the group's last day is over, anyone still inside is signed out
// automatically, so the "on premises" and evacuation lists stay true. Ordinary visitors are never auto-signed-out.
async function closeEndedGroups() {
  const now = new Date();
  const due = await Visit.find({ group: { $exists: true }, status: 'approved', validUntil: { $lte: now } }, '_id ref').limit(500).lean();
  for (const v of due) {
    const r = await Visit.updateOne(
      { _id: v._id, status: 'approved' },
      { $set: { status: 'checked_out', checkedOutAt: now }, $push: { movements: { kind: 'out', at: now, gateName: 'Automatic: event ended', byName: 'System' } } },
    );
    if (r.modifiedCount) audit({ label: 'system' }, 'visit.auto_checked_out', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, why: 'event ended' } });
  }
}

// DPDP data minimisation: masked ID images are deleted after the retention window.
async function purgeIdImages() {
  const { idRetentionDays } = await settings.get();
  const cutoff = new Date(Date.now() - idRetentionDays * 86400e3);
  const due = await Visit.find({
    $or: [{ idImagePath: { $exists: true } }, { idFullPath: { $exists: true } }], idImagePurgedAt: { $exists: false }, createdAt: { $lt: cutoff },
  }, '_id idImagePath idFullPath').limit(100);
  for (const v of due) {
    await Promise.all([v.idImagePath, v.idFullPath].filter(Boolean).map((p) => fs.rm(p, { force: true })));
    await Visit.updateOne({ _id: v._id }, { $set: { idImagePurgedAt: new Date() }, $unset: { idImagePath: 1, idFullPath: 1 } });
  }
}

let running = false;
function start() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processOutbox();
      await expireStaleApprovals();
      await closeExpiredPasses();
      await closeEndedGroups();
      await parcels.remind();
      await overstay.escalate();
      await purgeIdImages();
    } catch (err) {
      console.error('[worker]', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.worker.intervalMs);
  timer.unref();
  return tick;
}

module.exports = { start, processOutbox, expireStaleApprovals, closeExpiredPasses, closeEndedGroups, purgeIdImages };
