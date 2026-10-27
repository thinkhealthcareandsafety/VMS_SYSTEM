const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

// ---------- SMS ----------
// console: logs the message (dev). http: POSTs to your gateway (MSG91 / Textlocal / Twilio / etc.).
// India: SMS must use a TRAI DLT-registered template; the body must match the approved template text.
async function sendSms(to, body, vars = {}) {
  // An emergency through MSG91: the approved template for its type, whatever the everyday SMS driver is.
  if (vars.alert && config.sms.driver !== 'http') {
    const tpl = config.sms.msg91Alerts[vars.kind];
    if (!config.otp.authKey || !tpl) throw Object.assign(new Error(`No approved SMS template for the "${vars.kind}" emergency`), { permanent: true });
    const [v1, v2] = config.sms.msg91AlertVars;
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: config.otp.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ template_id: tpl, short_url: '0', recipients: [{ mobiles: to.replace(/^\+/, ''), [v1]: String(vars.site || '').slice(0, 30), [v2]: String(vars.assembly || '').slice(0, 30) }] }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.type === 'error') throw new Error(`MSG91: ${json.message || res.status}`);
    return String(json.message || json.request_id || 'accepted');
  }
  if (config.sms.driver === 'console') {
    console.log(`[SMS -> ${to}] ${body}`);
    return 'console';
  }
  if (config.sms.driver === 'msg91') {
    // MSG91 Flow API: the approval text is a DLT-approved template; only its variables travel.
    if (!config.otp.authKey || !config.sms.msg91TemplateId) throw new Error('MSG91 approval template is not set up');
    const [vName, vCompany, vLink] = config.sms.msg91Vars;
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: config.otp.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        template_id: config.sms.msg91TemplateId,
        short_url: '0',
        recipients: [{ mobiles: to.replace(/^\+/, ''), [vName]: vars.name || '', [vCompany]: vars.company || '', [vLink]: vars.link || '' }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.type === 'error') throw new Error(`MSG91: ${json.message || res.status}`);
    return String(json.message || json.request_id || 'accepted');
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

function buildStickerZpl(visit, hostUnit, hostName, timeStr, dateStr, validTill = '') {
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
    `^FO20,270^A0N,24,24^FD${dateStr}  ${timeStr}^FS`,
    ...(validTill ? [`^FO20,302^A0N,24,24^FDVALID TILL ${ascii(validTill, 24)}^FS`] : []),
    // The pass code as a QR: scanned at any gate to let the holder out, or back in on a multi-day pass.
    ...(visit.passCode ? [
      `^FO20,335^BQN,2,6^FDQA,${ascii(visit.passCode, 8)}^FS`,
      `^FO210,370^A0N,30,30^FD${ascii(`${visit.passCode.slice(0, 4)}-${visit.passCode.slice(4)}`, 9)}^FS`,
      `^FO210,410^A0N,22,22^FD${ascii(visit.ref, 20)}^FS`,
      '^FO210,445^A0N,20,20^FDSCAN AT ANY GATE^FS',
    ] : [`^FO20,340^BCN,110,Y,N,N^FD${ascii(visit.ref, 20)}^FS`]),
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

// Emergency SMS: a gateway that takes free text sends every type; MSG91 sends the types with an approved template.
const smsAlertKinds = () => (config.sms.driver === 'http' ? Object.keys(config.sms.msg91Alerts) : config.otp.authKey ? Object.keys(config.sms.msg91Alerts).filter((k) => config.sms.msg91Alerts[k]) : []);
const smsAlertsLive = (kind) => (kind ? smsAlertKinds().includes(kind) : smsAlertKinds().length > 0);

module.exports = { sendSms, sendOtp, otpLive, smsAlertsLive, smsAlertKinds, buildStickerZpl, deliverZpl };
