const { Outbox } = require('../models');
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

module.exports = { retireTelegram };
