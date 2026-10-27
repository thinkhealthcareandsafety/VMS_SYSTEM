const { Emergency, Visit, Host, Outbox, Group } = require('../models');
const settings = require('./settings');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');
const email = require('./email');
const { smsAlertsLive } = require('./messaging');

// Emergencies at the site: a fire, an evacuation, a drill. The first message starts one, with a roll call of
// everyone inside at that moment; more messages can follow; "All clear" ends it. Every message goes out on every
// channel that can reach the person (WhatsApp, SMS, email, Telegram), because in an emergency one channel failing
// must not mean someone is not told. The guard or admin picks a template and may change its words before sending.
const MAX_TEXT = 700;
const TEMPLATES = [
  { id: 'fire', title: 'Fire: evacuate now', tone: 'bad', text: '🔥 FIRE ALARM at {site}. Leave the building now by the nearest exit. Do not use the lifts. Go to the assembly point: {assembly}. Follow the instructions of hotel staff.' },
  { id: 'evacuate', title: 'Evacuate the building', tone: 'bad', text: '🚨 EMERGENCY at {site}. Please leave the building now, calmly, by the nearest exit. Do not use the lifts. Go to the assembly point: {assembly}.' },
  { id: 'gas', title: 'Gas leak or hazard', tone: 'bad', text: '⚠️ HAZARD at {site}. Leave the building now. Do not use lifts, light switches or open flames. Go to the assembly point: {assembly}.' },
  { id: 'shelter', title: 'Stay inside', tone: 'warn', text: '⚠️ SECURITY ALERT at {site}. Stay where you are, inside, away from windows and doors, until staff tell you it is safe. Do not come to the gates.' },
  { id: 'drill', title: 'Evacuation drill', tone: 'warn', text: 'This is an evacuation DRILL at {site}. Please leave the building calmly by the nearest exit and go to the assembly point: {assembly}. Do not use the lifts.' },
  { id: 'allclear', title: 'All clear', tone: 'ok', text: '✅ ALL CLEAR at {site}. The emergency is over and it is safe to return. Thank you for your cooperation.' },
  { id: 'custom', title: 'Write your own', tone: '', text: '' },
];

async function filledTemplates() {
  const s = await settings.get();
  // No assembly point set: "Go to the assembly point staff direct you to." reads as one sentence.
  const fill = (text) => (s.assemblyPoint ? text.replace(/\{assembly\}/g, s.assemblyPoint) : text.replace(/: \{assembly\}/g, ' staff direct you to'));
  return TEMPLATES.map((t) => ({ ...t, text: fill(t.text).replace(/\{site\}/g, s.siteName) }));
}

// Everyone inside right now (visitors and event guests), with their hosts.
async function inside() {
  return Visit.find({ status: 'approved' }).populate('host').lean();
}

// Who a message would reach, for the preview and for sending.
async function audienceOf(visits, { allHosts = false } = {}) {
  const visitorMobiles = new Map();
  for (const v of visits) if (v.mobile && !visitorMobiles.has(v.mobile)) visitorMobiles.set(v.mobile, v);
  const visitorEmails = [...new Set(visits.map((v) => v.email).filter(Boolean))];
  // Hosts with someone inside, and who that is: their message names them.
  const theirs = new Map();
  for (const v of visits) {
    if (!v.host?._id) continue;
    const id = String(v.host._id);
    if (!theirs.has(id)) theirs.set(id, { host: v.host, names: [] });
    theirs.get(id).names.push(`${v.firstName} ${v.lastName}`.trim());
  }
  let hosts = [...theirs.values()].filter((h) => h.host.active !== false);
  if (allHosts) {
    const everyone = await Host.find({ active: true }).lean();
    hosts = everyone.map((h) => theirs.get(String(h._id)) || { host: h, names: [] });
  }
  return { visitorMobiles: [...visitorMobiles.keys()], visitorEmails, hosts };
}

const channels = () => ({ whatsapp: whatsapp.enabled(), sms: smsAlertsLive(), email: email.enabled(), telegram: telegram.enabled() });

// The line added for a host whose visitors are inside, so they can make sure each one gets out.
const hostLine = (names) => (names.length ? `\n\nYour visitors inside: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}. Please make sure they reach safety.` : '');

// Queues one message for everyone in the audience, on every channel that reaches them. Returns the counts.
async function queue(em, n, text, audience, { visitors, allHosts, title }) {
  const ch = channels();
  const jobs = [];
  const base = { emergency: em._id, vars: { plain: true, alert: true, n } };
  const reach = await audienceOf(visitors, { allHosts });
  const subject = `${title}: ${(await settings.get()).siteName}`;
  const mail = (body) => ({ subject, html: `<div style="font:16px/1.5 Arial,sans-serif;white-space:pre-line">${body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>` });
  let visitorCount = 0;
  let hostCount = 0;
  if (audience !== 'hosts') {
    for (const to of reach.visitorMobiles) {
      if (ch.whatsapp) jobs.push({ ...base, kind: 'whatsapp', to, body: text });
      if (ch.sms) jobs.push({ ...base, kind: 'sms', to, body: text });
    }
    if (ch.email) for (const to of reach.visitorEmails) jobs.push({ ...base, kind: 'email', to, body: text, vars: { ...base.vars, ...mail(text) } });
    visitorCount = reach.visitorMobiles.length;
  }
  if (audience !== 'visitors') {
    for (const { host, names } of reach.hosts) {
      const body = text + hostLine(names);
      let told = false;
      if (ch.whatsapp && host.mobile) { jobs.push({ ...base, kind: 'whatsapp', to: host.mobile, body }); told = true; }
      if (ch.sms && host.mobile) { jobs.push({ ...base, kind: 'sms', to: host.mobile, body }); told = true; }
      if (ch.telegram && host.telegramChatId) { jobs.push({ ...base, kind: 'telegram', to: String(host.telegramChatId), body }); told = true; }
      if (ch.email && host.email) { jobs.push({ ...base, kind: 'email', to: host.email, body, vars: { ...base.vars, ...mail(body) } }); told = true; }
      if (told) hostCount += 1;
    }
  }
  if (jobs.length) await Outbox.insertMany(jobs);
  return { visitors: visitorCount, hosts: hostCount, jobs: jobs.length };
}

// Sends a message: into the emergency that is going on, or starting a new one. "All clear" ends it.
async function send({ template, text, audience, allHosts }, user, gate) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  if (clean.length < 10) return { error: 'Write the message (at least 10 characters)' };
  if (!['visitors', 'hosts', 'both'].includes(audience)) return { error: 'Choose who gets it: visitors, hosts or both' };
  const t = TEMPLATES.find((x) => x.id === template) || TEMPLATES.find((x) => x.id === 'custom');
  const visits = await inside();
  let em = await Emergency.findOne({ status: 'active' }).sort({ createdAt: -1 });
  const started = !em;
  if (!em) {
    if (t.id === 'allclear') return { error: 'There is no emergency going on to end' };
    const groups = new Map((await Group.find({ _id: { $in: visits.filter((v) => v.group).map((v) => v.group) } }, 'name').lean()).map((g) => [String(g._id), g.name]));
    em = await Emergency.create({
      kind: t.id, title: t.title, startedBy: user.id, startedByName: user.fullName, gateName: gate.name,
      people: visits.map((v) => ({
        visit: v._id, name: `${v.firstName} ${v.lastName}`.trim(), company: v.company || '', pass: v.dailyNumber, host: v.host?.fullName || '',
        hostUnit: v.host?.unit || '', mobile: v.mobile || '', group: v.group ? groups.get(String(v.group)) || 'Event' : '', card: v.card?.no || '',
      })),
    });
  }
  const n = em.messages.length;
  const counts = await queue(em, n, clean, audience, { visitors: visits, allHosts: Boolean(allHosts), title: t.id === 'custom' ? 'Emergency' : t.title });
  em.messages.push({ at: new Date(), template: t.id, title: t.title, text: clean, audience, allHosts: Boolean(allHosts), by: user.fullName, visitors: counts.visitors, hosts: counts.hosts });
  if (t.id === 'allclear') Object.assign(em, { status: 'closed', closedAt: new Date(), closedByName: user.fullName });
  await em.save();
  return { em, started, counts, closed: t.id === 'allclear' };
}

// Delivery per message and channel: { n: { whatsapp: { sent, failed, queued }, ... } }.
async function delivery(id) {
  const rows = await Outbox.aggregate([
    { $match: { emergency: id } },
    { $group: { _id: { n: '$vars.n', kind: '$kind', status: '$status' }, c: { $sum: 1 } } },
  ]);
  const out = {};
  for (const r of rows) {
    const m = (out[r._id.n] ||= {});
    const k = (m[r._id.kind] ||= { sent: 0, failed: 0, queued: 0 });
    k[r._id.status] = (k[r._id.status] || 0) + r.c;
  }
  return out;
}

function view(em, deliveries = {}) {
  const safe = em.people.filter((p) => p.safeAt).length;
  return {
    id: String(em._id), status: em.status, kind: em.kind, title: em.title, startedAt: em.createdAt, startedBy: em.startedByName, gate: em.gateName,
    closedAt: em.closedAt || null, closedBy: em.closedByName || null,
    total: em.people.length, safe,
    people: em.people.map((p) => ({ visitId: String(p.visit), name: p.name, company: p.company, pass: p.pass ?? null, host: p.host, hostUnit: p.hostUnit, mobile: p.mobile, group: p.group, card: p.card || '', safeAt: p.safeAt || null, safeBy: p.safeBy || null })),
    messages: em.messages.map((m, i) => ({ ...m, delivery: deliveries[i] || {} })),
  };
}

module.exports = { TEMPLATES, MAX_TEXT, filledTemplates, inside, audienceOf, channels, send, delivery, view, hostLine };
