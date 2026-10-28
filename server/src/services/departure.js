const config = require('../config');
const { Host, Outbox } = require('../models');
const settings = require('./settings');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');
const email = require('./email');

// When a visitor leaves for good, two people are told:
//   the host: who left, when and by which gate (WhatsApp or Telegram, email, and SMS once its template is approved);
//   the visitor: a thank-you (email when they gave one, and SMS once its template is approved).
// Each has its own switch in Settings. Not for event guests (their organiser sees the event's list), nor for someone
// stepping out on a multi-day pass (they are coming back).
const fmt = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' });

// by: 'gate' (a guard at the gate) or 'security' (checked out from the console).
// delayMs: held back this long (a gate scan can be undone for 30 seconds; undo() then calls forget()).
async function tellHost(v, { at = new Date(), gateName = '', delayMs = 0, by = 'gate' } = {}) {
  if (v.group || !['checked_out', 'force_checked_out', 'away'].includes(v.status)) return;
  const { notifyCheckout, thankVisitor, siteName } = await settings.get();
  const who = `${v.firstName} ${v.lastName}`.trim();
  const when = `${fmt(at)}${gateName ? `, ${gateName}` : ''}`;
  const jobs = [];

  const host = v.host?.fullName ? v.host : await Host.findById(v.host).lean();
  if (notifyCheckout && host && host.active !== false) {
    const left = by === 'security' ? `was checked out by security at ${fmt(at)}` : `has left: ${when}`;
    const text = `👋 Your visitor ${who}${v.company ? ` (${v.company})` : ''} ${left}.`;
    if (whatsapp.enabled() && host.mobile && config.approvalChannel !== 'sms') jobs.push({ kind: 'whatsapp', to: host.mobile, body: text, vars: { plain: true } });
    else if (telegram.enabled() && host.telegramChatId) jobs.push({ kind: 'telegram', to: String(host.telegramChatId), body: text, vars: { plain: true } });
    if (email.enabled() && host.email) {
      const mail = email.noticeEmail({
        headline: `Your visitor ${who} has left`,
        rows: [['Visitor', who], ['Company', v.company], ['Left', by === 'security' ? `${fmt(at)}, checked out by security` : when], ['Visitor ID', v.ref]],
      });
      jobs.push({ kind: 'email', to: host.email, body: mail.text, vars: { subject: `Your visitor ${who} has left`, html: mail.html } });
    }
    const smsLive = config.sms.driver === 'http' || Boolean(config.otp.authKey && config.sms.msg91CheckoutTemplateId);
    if (smsLive && host.mobile) jobs.push({ kind: 'sms', to: host.mobile, body: text, vars: { checkout: true, who, when } });
  }

  // Not when stepping out on a pass that stays valid: they are coming back.
  if (thankVisitor && v.status !== 'away') {
    const site = siteName || config.siteName;
    if (email.enabled() && v.email) {
      const mail = email.noticeEmail({
        headline: `Thank you for visiting ${site}, ${v.firstName}`,
        rows: [['Checked out', when], ['Visitor ID', v.ref]],
        note: 'We hope to see you again soon.',
      });
      jobs.push({ kind: 'email', to: v.email, body: mail.text, vars: { subject: `Thank you for visiting ${site}`, html: mail.html } });
    }
    const smsLive = config.sms.driver === 'http' || Boolean(config.otp.authKey && config.sms.msg91ThanksTemplateId);
    if (smsLive && v.mobile) {
      jobs.push({ kind: 'sms', to: v.mobile, body: `Thank you for visiting ${config.sms.alertSiteShort || site}. You checked out at ${when}.`, vars: { thanks: true, site: config.sms.alertSiteShort || site, when } });
    }
  }

  const sendAt = new Date(Date.now() + delayMs);
  if (jobs.length) await Outbox.insertMany(jobs.map((j) => ({ ...j, visit: v._id, nextAttemptAt: sendAt, vars: { ...j.vars, departure: true } })));
}

// A scan out taken back: nobody is told.
const forget = (visitId) => Outbox.deleteMany({ visit: visitId, status: 'queued', 'vars.departure': true });

module.exports = { tellHost, forget };
