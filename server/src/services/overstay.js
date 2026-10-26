const config = require('../config');
const { Visit, Outbox } = require('../models');
const settings = require('./settings');
const telegram = require('./telegram');
const whatsapp = require('./whatsapp');
const email = require('./email');
const passes = require('./passes');
const { audit } = require('./core');

// Visitors still inside after their pass ended. The guard and admin screens pop them up; the guard acknowledges
// ("seen, I am on it"); if the person has still not checked out an hour after the pass ended, it is escalated:
// the host and the site's escalation contacts are told, and the admin screen shows it in red.
// Event guests are left out: they are signed out automatically when the event ends.
const ESCALATE_AFTER_MIN = 60;

const query = (now = new Date()) => ({ status: 'approved', group: { $exists: false }, validUntil: { $lt: now } });

const fmt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function rowOf(v, now = Date.now()) {
  const ended = new Date(v.validUntil).getTime();
  const ee = passes.entryExit(v);
  return {
    id: String(v._id), ref: v.ref, firstName: v.firstName, lastName: v.lastName, company: v.company,
    dailyNumber: v.dailyNumber ?? null, dailyDay: v.dailyDay ?? null,
    host: v.host?.fullName ? { name: v.host.fullName, unit: v.host.unit } : null,
    validUntil: v.validUntil, overMinutes: Math.max(0, Math.round((now - ended) / 60000)),
    escalatesAt: new Date(ended + ESCALATE_AFTER_MIN * 60e3),
    lastIn: ee.lastIn,
    ack: v.overstay?.ackAt ? { at: v.overstay.ackAt, by: v.overstay.ackByName || '', note: v.overstay.ackNote || '' } : null,
    escalatedAt: v.overstay?.escalatedAt || null,
  };
}

async function list(now = new Date()) {
  const rows = await Visit.find(query(now)).sort({ validUntil: 1 }).limit(300).populate('host').lean();
  return rows.map((v) => rowOf(v, now.getTime()));
}

// Worker: an hour past the pass and still inside -> escalated once. Claimed atomically, so two workers never both send.
async function escalate(now = new Date()) {
  const due = await Visit.find({
    ...query(new Date(now.getTime() - ESCALATE_AFTER_MIN * 60e3)), 'overstay.escalatedAt': { $exists: false },
  }).limit(100).populate('host').lean();
  if (!due.length) return 0;
  const { escalateTo, siteName } = await settings.get();
  let n = 0;
  for (const v of due) {
    const r = await Visit.updateOne({ _id: v._id, status: 'approved', validUntil: v.validUntil, 'overstay.escalatedAt': { $exists: false } }, { $set: { 'overstay.escalatedAt': now } });
    if (!r.modifiedCount) continue;
    n += 1;
    const name = `${v.firstName} ${v.lastName}`;
    const where = passes.entryExit(v).lastIn?.gate;
    const line = `${name}${v.company ? ` (${v.company})` : ''}, pass ${v.dailyNumber ?? v.ref}, is still inside. The pass ended at ${fmt(v.validUntil)}${where ? `; they came in at ${where}` : ''}.`;
    const ackLine = v.overstay?.ackAt ? `\nSecurity (${v.overstay.ackByName}) is aware${v.overstay.ackNote ? `: ${v.overstay.ackNote}` : ''}.` : '\nThe gate has not responded yet.';
    const sent = [];
    // The host: they are responsible for their visitor.
    const host = v.host?.active !== false ? v.host : null;
    if (host) {
      const text = `⏰ Your visitor ${line}\n\nPlease ask them to check out at the gate, or ask security to extend the pass.`;
      if (whatsapp.enabled() && host.mobile && config.approvalChannel !== 'sms') { await Outbox.create({ kind: 'whatsapp', visit: v._id, to: host.mobile, body: text, vars: { plain: true } }); sent.push('host:whatsapp'); }
      else if (telegram.enabled() && host.telegramChatId) { await Outbox.create({ kind: 'telegram', visit: v._id, to: String(host.telegramChatId), body: text, vars: { plain: true } }); sent.push('host:telegram'); }
    }
    // The site's escalation contacts (security manager, duty manager).
    const text = `🚨 ${siteName}: ${line}${ackLine}\n\nOpen On premises: ${config.appBaseUrl}/admin?s=inside`;
    if (whatsapp.enabled()) {
      for (const to of escalateTo?.mobiles || []) await Outbox.create({ kind: 'whatsapp', visit: v._id, to, body: text, vars: { plain: true } });
      if (escalateTo?.mobiles?.length) sent.push(`whatsapp:${escalateTo.mobiles.length}`);
    }
    if (email.enabled()) {
      const all = [...(escalateTo?.emails || []), ...(host?.email ? [host.email] : [])];
      for (const to of all) {
        const mail = email.approvalEmail({
          headline: `${name} is still inside after the pass ended.`,
          rows: [['Pass', String(v.dailyNumber ?? v.ref)], ['Company', v.company], ['Meeting', host ? `${host.fullName}, ${host.unit}` : ''], ['Pass ended', fmt(v.validUntil)], ['Came in at', where]],
          link: `${config.appBaseUrl}/admin?s=inside`, button: 'Open On premises', note: 'Check them out at the gate, or extend the pass.',
        });
        await Outbox.create({ kind: 'email', visit: v._id, to, body: mail.text, vars: { subject: `Still inside after the pass ended: ${name}`, html: mail.html } });
      }
      if (all.length) sent.push(`email:${all.length}`);
    }
    audit({ label: 'system' }, 'visit.overstay_escalated', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, acknowledged: Boolean(v.overstay?.ackAt), told: sent.join(', ') || 'nobody reachable' } });
  }
  return n;
}

module.exports = { ESCALATE_AFTER_MIN, query, list, rowOf, escalate };
