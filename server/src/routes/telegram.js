const crypto = require('node:crypto');
const express = require('express');
const { Host, Outbox } = require('../models');
const telegram = require('../services/telegram');
const { decide, findByToken } = require('../services/decision');
const { audit, sha256 } = require('../services/core');

// Telegram calls this for every message to the bot and every button tap. Not behind a login:
// the shared webhook secret proves the call is from Telegram, and each tap must come from the
// chat that the host connected, so a forwarded message cannot be used to decide for someone else.
const router = express.Router();

async function onMessage(msg) {
  const chatId = String(msg.chat?.id || '');
  const text = String(msg.text || '').trim();
  if (!chatId || msg.chat?.type !== 'private') return;

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1];
    if (!code) {
      return telegram.say(chatId, 'Hi! I send visitor approval requests from the gate.\n\nTo connect, ask your admin for your personal connect link or QR code.');
    }
    const host = await Host.findOne({ telegramLinkHash: sha256(code), telegramLinkExpires: { $gt: new Date() } });
    if (!host) return telegram.say(chatId, 'That connect link has expired or was already used. Ask your admin for a new one.');
    host.telegramChatId = chatId;
    host.telegramLinkHash = undefined;
    host.telegramLinkExpires = undefined;
    await host.save();
    audit({ label: `host:${host._id}`, role: 'host' }, 'host.telegram_connected', { entity: 'Host', entityId: host._id, details: { unit: host.unit } });
    return telegram.say(chatId, `Connected ✅\n\nHi ${host.fullName.split(' ')[0]}. When someone arrives for you (${host.unit}), the request appears here with Let them in and Decline buttons.`);
  }
  return telegram.say(chatId, 'I only send visitor requests. Nothing to do here; tap the buttons on a request when one arrives.');
}

async function onButton(cb) {
  const chatId = String(cb.message?.chat?.id || '');
  const [kind, token] = String(cb.data || '').split(':');
  const decision = kind === 'a' ? 'approve' : kind === 'r' ? 'reject' : null;
  if (!decision || !token) return telegram.answer(cb.id, 'Unknown action');

  const found = await findByToken(token);
  if (!found) return telegram.answer(cb.id, 'This request is no longer valid', true);
  if (!found.visit.host?.telegramChatId || String(found.visit.host.telegramChatId) !== chatId) {
    return telegram.answer(cb.id, 'This request was not sent to you', true);
  }

  const { status, body, visit } = await decide(token, decision, { via: 'telegram' });
  const name = visit ? `${visit.firstName} ${visit.lastName}` : 'the visitor';
  if (status === 200) {
    const line = decision === 'approve' ? `✅ You let ${name} in.` : `❌ You declined ${name}.`;
    await telegram.answer(cb.id, decision === 'approve' ? 'Let in' : 'Declined');
    await Outbox.updateMany({ kind: 'telegram', to: chatId, providerRef: String(cb.message.message_id) }, { retiredAt: new Date() });
    return telegram.finish(chatId, cb.message.message_id, `${line}\nSecurity has been told.`);
  }
  // Already decided, cancelled, expired, or replaced by a newer request: say so and retire the buttons.
  await telegram.answer(cb.id, body.error, true);
  if (body.state) await telegram.finish(chatId, cb.message.message_id, `${cb.message.text.split('\n')[0]}\n\n${body.error}`);
}

router.post('/webhook', async (req, res) => {
  const given = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') || ''));
  const want = Buffer.from(telegram.enabled() ? telegram.webhookSecret() : '\0');
  if (!telegram.enabled() || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).end();
  try {
    if (req.body?.message) await onMessage(req.body.message);
    else if (req.body?.callback_query) await onButton(req.body.callback_query);
  } catch (err) {
    console.error('[telegram] update failed:', err.message); // always answer 200, or Telegram retries the same update
  }
  res.json({ ok: true });
});

module.exports = router;
