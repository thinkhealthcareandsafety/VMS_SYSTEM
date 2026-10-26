const express = require('express');
const config = require('../config');
const { Host, Outbox } = require('../models');
const whatsapp = require('../services/whatsapp');
const { decide, findByToken } = require('../services/decision');
const material = require('../services/material');
const parcels = require('../services/parcels');
const { whatsappFallback } = require('../services/notify');
const { audit } = require('../services/core');

// Meta calls this for every message to the business number, every button tap and every delivery status.
// Not behind a login: each tap carries the single-use token and must come from the host's own number,
// so a forwarded message cannot be used to decide for someone else.
const router = express.Router();

async function onMessage(msg) {
  const from = whatsapp.digits(msg.from);
  const tap = msg.type === 'interactive' ? msg.interactive?.button_reply?.id : msg.type === 'button' ? msg.button?.payload : null;
  if (!tap) {
    // Anything else, usually the host's "Hi" that opens the 24-hour window: confirm who they are.
    const host = await Host.findOne({ mobile: `+${from}`, active: { $ne: false } }).lean();
    return whatsapp.say(from, host
      ? `Hi ${host.fullName.split(' ')[0]} 👋 You're connected.\n\nWhen someone arrives for you (${host.unit}), the request comes here with their photo and Let them in / Decline buttons.`
      : 'Hi! This number sends visitor requests from the gate. Nothing to do here.');
  }

  const [kind, token] = String(tap).split(':');
  // A material gate pass: only its approver's own number decides.
  if (kind === 'ma' || kind === 'mr') {
    const found = token ? await material.findByToken(token) : null;
    if (!found) return whatsapp.say(from, 'This request is no longer valid.', msg.id);
    if (whatsapp.digits(found.m.approver?.mobile) !== from) return whatsapp.say(from, 'This request was not sent to you.', msg.id);
    const r = await material.decideByToken(token, kind === 'ma' ? 'approve' : 'reject', { via: 'whatsapp' });
    return whatsapp.say(from, r.status === 200 ? `${kind === 'ma' ? '✅ Approved' : '❌ Declined'}: gate pass ${found.m.number}.\nSecurity has been told.` : r.body.error, msg.id);
  }
  // A parcel: only the recipient's own number answers.
  if (kind === 'pa' || kind === 'pr') {
    const found = token ? await parcels.findByToken(token) : null;
    if (!found) return whatsapp.say(from, 'This request is no longer valid.', msg.id);
    if (whatsapp.digits(found.p.host?.mobile) !== from) return whatsapp.say(from, 'This request was not sent to you.', msg.id);
    const r = await parcels.respondByToken(token, kind === 'pa' ? 'accept' : 'decline', { via: 'whatsapp' });
    return whatsapp.say(from, r.status === 200
      ? (kind === 'pa' ? `✅ Accepted: parcel ${found.p.number}.\nCollect it from security, or send someone; they give their name and number at the desk.` : `❌ Declined: parcel ${found.p.number}.\nSecurity will return it to the courier.`)
      : r.body.error, msg.id);
  }
  const decision = kind === 'a' ? 'approve' : kind === 'r' ? 'reject' : null;
  const found = decision && token ? await findByToken(token) : null;
  if (!found) return whatsapp.say(from, 'This request is no longer valid.', msg.id);
  if (whatsapp.digits(found.visit.host?.mobile) !== from) return whatsapp.say(from, 'This request was not sent to you.', msg.id);

  const { status, body, visit } = await decide(token, decision, { via: 'whatsapp' });
  const name = `${visit.firstName} ${visit.lastName}`;
  if (status === 200) {
    return whatsapp.say(from, `${decision === 'approve' ? `✅ You let ${name} in.` : `❌ You declined ${name}.`}\nSecurity has been told.`, msg.id);
  }
  return whatsapp.say(from, body.error, msg.id); // already decided, cancelled, expired, or replaced by a newer request
}

// A message Meta accepted can still fail later (host outside the 24-hour window, number not on WhatsApp).
async function onStatus(st) {
  if (st.status !== 'failed') return;
  const job = await Outbox.findOne({ kind: 'whatsapp', providerRef: String(st.id) });
  if (!job || job.status === 'failed') return;
  const e = st.errors?.[0] || {};
  job.status = 'failed';
  job.lastError = `${e.code || ''} ${e.error_data?.details || e.title || e.message || 'not delivered'}`.trim().slice(0, 300);
  await job.save();
  audit({ label: 'system' }, 'whatsapp.failed', { entity: 'Visit', entityId: job.visit, details: { error: job.lastError } });
  await whatsappFallback(job);
}

// Meta checks the address once when the webhook is saved in the app dashboard.
router.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && req.query['hub.verify_token'] === config.whatsapp.verifyToken;
  return ok ? res.type('text').send(String(req.query['hub.challenge'] || '')) : res.status(403).end();
});

router.post('/webhook', async (req, res) => {
  if (!whatsapp.enabled() || !whatsapp.signatureOk(req)) return res.status(401).end();
  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) await onMessage(msg);
        for (const st of change.value?.statuses || []) await onStatus(st);
      }
    }
  } catch (err) {
    console.error('[whatsapp] update failed:', err.message); // always answer 200, or Meta retries the same update
  }
  res.json({ ok: true });
});

module.exports = router;
