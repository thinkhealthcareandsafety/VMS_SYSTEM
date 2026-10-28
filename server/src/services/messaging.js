const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

// ---------- SMS ----------
// console: logs the message (dev). http: POSTs to your gateway (MSG91 / Textlocal / Twilio / etc.).
// India: SMS must use a TRAI DLT-registered template; the body must match the approved template text.
async function sendSms(to, body, vars = {}) {
  // "Your visitor left" through MSG91: its own approved template, two short variables.
  if (vars.checkout && config.sms.driver !== 'http') {
    if (!config.otp.authKey || !config.sms.msg91CheckoutTemplateId) throw Object.assign(new Error('No approved SMS template for the checkout message'), { permanent: true });
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: config.otp.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ template_id: config.sms.msg91CheckoutTemplateId, short_url: '0', recipients: [{ mobiles: to.replace(/^\+/, ''), var1: String(vars.who || '').slice(0, 30), var2: String(vars.when || '').slice(0, 30) }] }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.type === 'error') throw new Error(`MSG91: ${json.message || res.status}`);
    return String(json.message || json.request_id || 'accepted');
  }
  // "Thank you for visiting" to the visitor through MSG91: its own approved template, two short variables.
  if (vars.thanks && config.sms.driver !== 'http') {
    if (!config.otp.authKey || !config.sms.msg91ThanksTemplateId) throw Object.assign(new Error('No approved SMS template for the thank-you message'), { permanent: true });
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: config.otp.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ template_id: config.sms.msg91ThanksTemplateId, short_url: '0', recipients: [{ mobiles: to.replace(/^\+/, ''), var1: String(vars.site || '').slice(0, 30), var2: String(vars.when || '').slice(0, 30) }] }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.type === 'error') throw new Error(`MSG91: ${json.message || res.status}`);
    return String(json.message || json.request_id || 'accepted');
  }
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
    // MSG91 Flow API: the approval text is a DLT-approved template; only its variables travel. A text variable holds up to
    // 30 characters; the link goes whole into the template's {#url#} tag (whitelisted as https://<site>/approve?).
    if (!config.otp.authKey || !config.sms.msg91TemplateId) throw new Error('MSG91 approval template is not set up');
    const [vName, vCompany, vLink] = config.sms.msg91Vars;
    const v30 = (s) => String(s || '').slice(0, 30);
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: config.otp.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        template_id: config.sms.msg91TemplateId,
        short_url: '0',
        recipients: [{ mobiles: to.replace(/^\+/, ''), ...(vLink
          ? { [vName]: v30(vars.name), [vCompany]: v30(vars.company), [vLink]: vars.token || v30(vars.link) }
          : { [vName]: v30(vars.company === 'Personal' ? vars.name : `${vars.name} from ${vars.company}`), [vCompany]: vars.link || '' }) }],
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

// The pass on the hotel's 1.5 x 2.5 inch label (305 x 508 dots at 203 dpi), for a network printer the site PC prints to.
function buildStickerZpl(visit, hostUnit, hostName, timeStr, dateStr, validTill = '') {
  const code = visit.passCode ? ascii(visit.passCode, 8) : '';
  return [
    '^XA',
    '^PW305^LL508^LH0,0',
    '^FO15,12^A0N,26,26^FDVISITOR PASS^FS',
    `^FO190,16^A0N,20,20^FD${ascii(dateStr, 10)}^FS`,
    '^FO15,44^GB275,3,3^FS',
    '^FO15,56^A0N,20,20^FDPASS^FS',
    `^FO15,78^A0N,96,96^FD${visit.dailyNumber}^FS`,
    `^FO15,182^A0N,30,30^FB275,2,0,L^FD${ascii(`${visit.firstName} ${visit.lastName}`, 40)}^FS`,
    `^FO15,248^A0N,22,22^FB275,1,0,L^FD${ascii(visit.company, 30)}^FS`,
    `^FO15,278^A0N,22,22^FB275,2,0,L^FDMeeting: ${ascii(hostName, 24)}, ${ascii(hostUnit, 14)}^FS`,
    `^FO15,330^A0N,22,22^FDIn: ${ascii(timeStr, 10)}^FS`,
    ...(validTill ? [`^FO15,356^A0N,24,24^FB275,1,0,L^FDVALID TILL ${ascii(validTill, 22)}^FS`] : []),
    // The pass code as a QR: scanned at any gate to let the holder out, or back in on a multi-day pass.
    ...(code ? [
      `^FO10,384^BQN,2,4^FDQA,${code}^FS`,
      `^FO130,402^A0N,28,28^FD${code.slice(0, 4)}-${code.slice(4)}^FS`,
      `^FO130,438^A0N,20,20^FD${ascii(visit.ref, 14)}^FS`,
      '^FO130,464^A0N,18,18^FDSCAN AT ANY GATE^FS',
    ] : [`^FO15,392^BCN,80,Y,N,N^FD${ascii(visit.ref, 20)}^FS`]),
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
