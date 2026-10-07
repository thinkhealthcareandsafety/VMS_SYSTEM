const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

// ---------- SMS ----------
// console: logs the message (dev). http: POSTs to your gateway (MSG91 / Textlocal / Twilio / etc.).
// India: SMS must use a TRAI DLT-registered template; the body must match the approved template text.
async function sendSms(to, body) {
  if (config.sms.driver === 'console') {
    console.log(`[SMS -> ${to}] ${body}`);
    return 'console';
  }
  if (config.sms.driver === 'http') {
    const res = await fetch(config.sms.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: config.sms.httpAuth },
      body: JSON.stringify({ to, message: body, sender: config.sms.senderId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`SMS gateway HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    return String(json.messageId || json.id || 'accepted');
  }
  throw new Error(`Unknown SMS driver: ${config.sms.driver}`);
}

// OTP for mobile verification. MSG91 sends our own code through the DLT-approved OTP template; with no
// auth key the code is written to the server log instead (test mode), and nothing is sent.
const otpLive = () => Boolean(config.otp.authKey && config.otp.templateId);
async function sendOtp(to, code) {
  if (!otpLive()) {
    console.log(`[OTP -> ${to}] ${code} (test mode: no MSG91 key set, nothing was sent)`);
    return 'console';
  }
  const q = new URLSearchParams({
    template_id: config.otp.templateId, mobile: to.replace(/^\+/, ''), otp: code,
    otp_expiry: String(config.otp.expiryMinutes), otp_length: '6',
  });
  const res = await fetch(`https://control.msg91.com/api/v5/otp?${q}`, {
    method: 'POST',
    headers: { authkey: config.otp.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.type === 'error') throw new Error(`MSG91: ${json.message || res.status}`);
  return String(json.request_id || json.message || 'accepted');
}

// ---------- Sticker printing ----------
// Builds ZPL (Zebra-compatible; most WiFi/LAN label printers accept it on TCP 9100).
const ascii = (s, max) => String(s || '').replace(/[^\x20-\x7E]/g, '').replace(/[\^~]/g, ' ').slice(0, max);

function buildStickerZpl(visit, hostUnit, hostName, timeStr, dateStr) {
  return [
    '^XA',
    '^PW400^LL600',
    '^CF0,30',
    '^FO20,20^A0N,30,30^FDVISITOR PASS^FS',
    '^FO20,60^GB360,2,2^FS',
    `^FO20,80^A0N,150,150^FD${visit.dailyNumber}^FS`,
    `^FO220,90^A0N,34,34^FD${ascii(visit.firstName + ' ' + visit.lastName, 16)}^FS`,
    `^FO220,135^A0N,26,26^FDTO: ${ascii(hostUnit, 14)}^FS`,
    `^FO220,170^A0N,24,24^FD${ascii(hostName, 18)}^FS`,
    `^FO220,205^A0N,22,22^FD${ascii(visit.company, 18)}^FS`,
    `^FO20,300^A0N,24,24^FD${dateStr}  ${timeStr}^FS`,
    `^FO20,340^BCN,110,Y,N,N^FD${ascii(visit.ref, 20)}^FS`,
    '^XZ',
  ].join('\n');
}

async function deliverZpl(zpl, label) {
  const { mode, host, port, timeoutMs } = config.printer;
  if (mode === 'off') return 'off';
  if (mode === 'file') {
    const dir = path.resolve(config.uploadDir, '..', 'print-out');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${label}.zpl`);
    await fs.writeFile(file, zpl);
    return file;
  }
  if (mode === 'tcp') {
    if (!host) throw new Error('PRINTER_HOST is not set');
    await new Promise((resolve, reject) => {
      const sock = net.connect({ host, port }, () => {
        sock.end(zpl, 'utf8');
      });
      sock.setTimeout(timeoutMs, () => sock.destroy(new Error('Printer timeout')));
      sock.on('error', reject);
      sock.on('close', (hadErr) => (hadErr ? reject(new Error('Printer connection failed')) : resolve()));
    });
    return `tcp://${host}:${port}`;
  }
  throw new Error(`Unknown PRINTER_MODE: ${mode}`);
}

module.exports = { sendSms, sendOtp, otpLive, buildStickerZpl, deliverZpl };
