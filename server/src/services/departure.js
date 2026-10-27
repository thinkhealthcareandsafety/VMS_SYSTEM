const config = require('../config');
const { Host, Outbox } = require('../models');
const settings = require('./settings');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');
const email = require('./email');

// When a visitor leaves, the host is told: who, when and by which gate. WhatsApp (or Telegram), email, and SMS once an
// approved template is set. Event guests are left out (their organiser sees the event's list), and so are admin
// check-outs made after the fact (those are corrections, not someone walking out now).
const fmt = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' });

// delayMs: held back this long (a gate scan can be undone for 30 seconds; undo() then calls forget()).
async function tellHost(v, { at = new Date(), gateName = '', delayMs = 0 } = {}) {
  if (v.group) return;
  const { notifyCheckout } = await settings.get();
  if (!notifyCheckout) return;
  const host = v.host?.fullName ? v.host : await Host.findById(v.host).lean();
  if (!host || host.active === false) return;
  const who = `${v.firstName} ${v.lastName}`.trim();
  const when = `${fmt(at)}${gateName ? `, ${gateName}` : ''}`;
  const text = `👋 Your visitor ${who}${v.company ? ` (${v.company})` : ''} has left: ${when}.`;
  const jobs = [];
  if (whatsapp.enabled() && host.mobile && config.approvalChannel !== 'sms') jobs.push({ kind: 'whatsapp', to: host.mobile, body: text, vars: { plain: true } });
  else if (telegram.enabled() && host.telegramChatId) jobs.push({ kind: 'telegram', to: String(host.telegramChatId), body: text, vars: { plain: true } });
  if (email.enabled() && host.email) {
    jobs.push({ kind: 'email', to: host.email, body: text, vars: { subject: `Your visitor ${who} has left`, html: `<p style="font:16px/1.5 Arial,sans-serif">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>` } });
  }
  const smsLive = config.sms.driver === 'http' || Boolean(config.otp.authKey && config.sms.msg91CheckoutTemplateId);
  if (smsLive && host.mobile) jobs.push({ kind: 'sms', to: host.mobile, body: text, vars: { checkout: true, who, when } });
  const sendAt = new Date(Date.now() + delayMs);
  if (jobs.length) await Outbox.insertMany(jobs.map((j) => ({ ...j, visit: v._id, nextAttemptAt: sendAt, vars: { ...j.vars, departure: true } })));
}

// A scan out taken back: the host is not told.
const forget = (visitId) => Outbox.deleteMany({ visit: visitId, status: 'queued', 'vars.departure': true });

module.exports = { tellHost, forget };
