const fs = require('node:fs/promises');
const config = require('../config');
const { Visit, Outbox, ApprovalToken } = require('../models');
const { sendSms, buildStickerZpl, deliverZpl } = require('./messaging');
const { audit } = require('./core');
const { publish } = require('./events');

const backoffMs = (attempts) => Math.min(60000, 2 ** attempts * 1000);

async function processOutbox() {
  const jobs = await Outbox.find({
    status: { $in: ['queued', 'failed'] },
    attempts: { $lt: config.worker.maxAttempts },
    nextAttemptAt: { $lte: new Date() },
  }).sort({ _id: 1 }).limit(20);

  for (const job of jobs) {
    try {
      if (job.kind === 'sms') {
        job.providerRef = await sendSms(job.to, job.body);
      } else if (job.kind === 'print') {
        const visit = await Visit.findById(job.visit).populate('host').lean();
        if (!visit) throw new Error('Visit not found');
        const d = new Date(visit.decidedAt || Date.now());
        const dateStr = d.toLocaleDateString('en-IN', { timeZone: config.timezone });
        const timeStr = d.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
        const zpl = buildStickerZpl(visit, visit.host.unit, visit.host.fullName, timeStr, dateStr);
        job.providerRef = await deliverZpl(zpl, visit.ref);
      }
      job.status = 'sent';
      job.sentAt = new Date();
      job.lastError = undefined;
      publish(`${job.kind}.sent`, { visitId: String(job.visit) });
    } catch (err) {
      job.attempts += 1;
      job.lastError = String(err.message || err).slice(0, 300);
      job.status = job.attempts >= config.worker.maxAttempts ? 'failed' : 'queued';
      job.nextAttemptAt = new Date(Date.now() + backoffMs(job.attempts));
      if (job.status === 'failed') audit({ label: 'system' }, `${job.kind}.failed`, { entity: 'Visit', entityId: job.visit, details: { error: job.lastError } });
    }
    await job.save();
  }
}

// Pending approvals whose latest link has expired become "expired" (guard can resend).
async function expireStaleApprovals() {
  const pending = await Visit.find({ status: 'pending' }, '_id').lean();
  for (const v of pending) {
    const latest = await ApprovalToken.findOne({ visit: v._id }).sort({ expiresAt: -1 }).lean();
    if (latest && latest.expiresAt < new Date()) {
      const r = await Visit.updateOne({ _id: v._id, status: 'pending' }, { status: 'expired', decidedAt: new Date() });
      if (r.modifiedCount) publish('visit.expired', { visitId: String(v._id) });
    }
  }
}

// DPDP data minimisation: masked ID images are deleted after the retention window.
async function purgeIdImages() {
  const cutoff = new Date(Date.now() - config.idImageRetentionHours * 3600e3);
  const due = await Visit.find({ idImagePath: { $exists: true }, idImagePurgedAt: { $exists: false }, createdAt: { $lt: cutoff } }, '_id idImagePath').limit(100);
  for (const v of due) {
    await fs.rm(v.idImagePath, { force: true });
    await Visit.updateOne({ _id: v._id }, { $set: { idImagePurgedAt: new Date() }, $unset: { idImagePath: 1 } });
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

module.exports = { start, processOutbox, expireStaleApprovals, purgeIdImages };
