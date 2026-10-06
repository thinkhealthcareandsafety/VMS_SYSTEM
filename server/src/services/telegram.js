const crypto = require('node:crypto');
const config = require('../config');

// Telegram Bot API: free, no registration, instant. The bot sends hosts an approval request with
// Let them in / Decline buttons; their tap comes back through the webhook (routes/telegram.js).
// Visitor photos and ID images are NOT sent to Telegram: the host opens the link to see the face.
const enabled = () => Boolean(config.telegram.token);

// Telegram echoes this secret on every webhook call, so only Telegram can reach the endpoint.
const webhookSecret = () => crypto.createHash('sha256').update(`telegram:${process.env.JWT_SECRET}`).digest('hex').slice(0, 48);

async function call(method, payload) {
  const res = await fetch(`${config.telegram.apiBase}/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

let username = config.telegram.botUsername || null;
async function botUsername() {
  if (!username) username = (await call('getMe')).username;
  return username;
}

// Called once at startup: learn the bot's name and point Telegram's webhook at this app.
async function init() {
  if (!enabled()) return;
  try {
    await botUsername();
    await call('setWebhook', {
      url: `${config.appBaseUrl}/api/telegram/webhook`,
      secret_token: webhookSecret(),
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`Telegram bot @${username} connected`);
  } catch (err) {
    console.error('[telegram] setup failed:', err.message);
  }
}

const say = (chatId, text, extra) => call('sendMessage', { chat_id: chatId, text, ...extra });

// The approval request. `token` is the single-use approval token; it rides in the button data.
async function sendApproval(chatId, text, token) {
  const msg = await say(chatId, text, {
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Let them in', callback_data: `a:${token}` },
        { text: '❌ Decline', callback_data: `r:${token}` },
      ]],
    },
  });
  return String(msg.message_id);
}

const answer = (id, text, alert = false) => call('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }).catch(() => {});
const finish = (chatId, messageId, text) => call('editMessageText', {
  chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, reply_markup: { inline_keyboard: [] },
}).catch(() => {});

module.exports = { enabled, init, botUsername, webhookSecret, say, sendApproval, answer, finish };
