const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const config = require('../config');

// WhatsApp Cloud API (Meta). The host gets the request with the visitor's photo and Let them in / Decline
// buttons; their tap comes back through the webhook (routes/whatsapp.js). Buttons and free text can only be
// sent within 24 hours of the host last messaging the business number, so each host says "Hi" to it once.
const enabled = () => Boolean(config.whatsapp.token && config.whatsapp.phoneId);
const digits = (mobile) => String(mobile || '').replace(/\D/g, '');

async function call(path, init) {
  const res = await fetch(`${config.whatsapp.apiBase}/${config.whatsapp.phoneId}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, ...init.headers },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(`WhatsApp ${path}: ${e.code ? `${e.code} ` : ''}${e.error_data?.details || e.message || res.status}`);
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429; // wrong number, not allowed, bad token: retrying won't help
    throw err;
  }
  return data;
}

const send = (to, message) => call('messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), ...message }),
});

async function uploadJpeg(file) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/jpeg');
  form.append('file', new Blob([await fs.readFile(file)], { type: 'image/jpeg' }), 'visitor.jpg');
  return (await call('media', { method: 'POST', body: form })).id;
}

// The approval request. `token` is the single-use approval token; it rides in the button ids.
async function sendApproval(to, text, token, photoPath) {
  let header;
  if (photoPath) {
    try { header = { type: 'image', image: { id: await uploadJpeg(photoPath) } }; } catch (err) { console.error('[whatsapp] photo upload failed:', err.message); }
  }
  const data = await send(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header } : {}),
      body: { text: text.slice(0, 1024) },
      footer: { text: `Valid for ${config.approvalTtlMinutes} min` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `a:${token}`, title: '✅ Let them in' } },
          { type: 'reply', reply: { id: `r:${token}`, title: '❌ Decline' } },
        ],
      },
    },
  });
  return String(data.messages?.[0]?.id || 'accepted');
}

const say = (to, body, replyTo) => send(to, { type: 'text', text: { body, preview_url: false }, ...(replyTo ? { context: { message_id: replyTo } } : {}) });

// Meta signs every webhook call with the app secret. Without a secret set, calls are accepted: the
// single-use token in the button and the sender's number are what decide anything.
function signatureOk(req) {
  if (!config.whatsapp.appSecret) return true;
  const given = Buffer.from(String(req.get('x-hub-signature-256') || ''));
  const want = Buffer.from(`sha256=${crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody || '').digest('hex')}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = { enabled, digits, sendApproval, say, signatureOk };
