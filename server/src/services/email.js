const config = require('../config');

// Email: a free extra channel for approval requests. The email carries no photo or ID, only the visitor's
// name and a button to the same one-time approval page WhatsApp and SMS link to; the host sees the photo there.
// The button opens the page rather than approving from the email itself: mail scanners (Outlook Safe Links,
// Gmail) open every link in a message, and a link that approved on opening would let visitors in unseen.
const c = config.email;
const enabled = () => (c.driver === 'smtp' && Boolean(c.smtp.user && c.smtp.pass)) || (c.driver === 'brevo' && Boolean(c.brevoKey && c.from));

let transport;
async function viaSmtp(to, subject, html, text) {
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: c.smtp.host, port: c.smtp.port, secure: c.smtp.port === 465,
      auth: { user: c.smtp.user, pass: c.smtp.pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
  }
  const info = await transport.sendMail({ from: { name: c.fromName, address: c.from }, to, subject, html, text });
  return info.messageId || 'accepted';
}

async function viaBrevo(to, subject, html, text) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': c.brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: c.fromName, email: c.from }, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Brevo: ${data.message || res.status}`);
    err.permanent = res.status === 400 || res.status === 401;
    throw err;
  }
  return data.messageId || 'accepted';
}

async function send(to, subject, html, text) {
  if (!enabled()) throw Object.assign(new Error('Email is not set up'), { permanent: true });
  return c.driver === 'brevo' ? viaBrevo(to, subject, html, text) : viaSmtp(to, subject, html, text);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// The approval request. rows: [label, value] pairs shown under the headline.
function approvalEmail({ headline, rows, link, button, valid, note = 'You will see their photo and can let them in or decline.' }) {
  const list = rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#6b6b6b;font-size:14px;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#151515;font-size:14px;font-weight:600">${esc(v)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f3f1;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f3f1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e2de;border-radius:14px">
<tr><td style="padding:24px 28px 0"><span style="display:inline-block;border:1.5px solid #9c1c2e;color:#9c1c2e;font-size:11px;font-weight:700;letter-spacing:.14em;padding:4px 9px">${esc(c.fromName.toUpperCase())}</span></td></tr>
<tr><td style="padding:18px 28px 6px;color:#151515;font-size:20px;line-height:1.35;font-weight:700">${esc(headline)}</td></tr>
<tr><td style="padding:6px 28px 4px"><table role="presentation" cellpadding="0" cellspacing="0">${list}</table></td></tr>
<tr><td style="padding:20px 28px 8px"><a href="${esc(link)}" style="display:inline-block;background:#151515;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 26px;border-radius:10px">${esc(button)}</a></td></tr>
<tr><td style="padding:4px 28px 26px;color:#6b6b6b;font-size:13px;line-height:1.5">${esc(note)} The link is valid for ${esc(valid)}.</td></tr>
</table>
<p style="color:#8a8a8a;font-size:12px;margin:14px 0 0">Sent by the security desk. If you were not expecting this, decline it or ignore it.</p>
</td></tr></table></body></html>`;
  const text = `${headline}\n\n${rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${button}: ${link}\nThe link is valid for ${valid}.`;
  return { html, text };
}

module.exports = { enabled, send, approvalEmail };
