const { Outbox, Visit } = require('../models');
const telegram = require('./telegram');

// When a request ends some other way (the guard cancels, it expires, a newer one is sent, or the host
// decides on the web page), the Telegram message still shows live buttons. Replace them with what happened.
async function retireTelegram(visitId, text) {
  if (!telegram.enabled()) return;
  const jobs = await Outbox.find({ kind: 'telegram', visit: visitId, status: 'sent', providerRef: { $exists: true }, retiredAt: { $exists: false } }).lean();
  for (const job of jobs) {
    await telegram.finish(job.to, Number(job.providerRef), text);
    await Outbox.updateOne({ _id: job._id }, { retiredAt: new Date() });
  }
}

// WhatsApp could not deliver (host not on the allowed list, or hasn't messaged the business number in 24 hours):
// send the same request the way it would have gone without WhatsApp, unless the visit moved on meanwhile.
async function whatsappFallback(job) {
  const fallback = job.vars?.fallback;
  if (!fallback) return;
  const visit = await Visit.findById(job.visit, 'status').lean();
  if (visit?.status !== 'pending') return;
  if (await Outbox.exists({ visit: job.visit, kind: { $in: ['sms', 'telegram', 'whatsapp'] }, _id: { $gt: job._id } })) return;
  await Outbox.create({ ...fallback, visit: job.visit });
}

module.exports = { retireTelegram, whatsappFallback };
