const env = process.env;

module.exports = {
  port: Number(env.PORT || 4000),
  mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/vms',
  appBaseUrl: env.APP_BASE_URL || 'http://localhost:5173',
  siteName: env.SITE_NAME || 'Visitor Management',
  timezone: env.SITE_TIMEZONE || 'Asia/Kolkata',
  defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '+91',
  uploadDir: env.UPLOAD_DIR || 'uploads',
  cookieSecure: env.COOKIE_SECURE === 'true',
  // On the hotel's own server: a GateSmartX licence is needed for new entries, and the internet tunnel
  // reaches only the pages hosts and guests open (the console and guard desk stay inside the hotel).
  licenseRequired: env.LICENSE_REQUIRED === 'true',
  lanOnly: env.LAN_ONLY === 'true',
  // Proxies in front of the app, so req.ip is the visitor's address. Vercel -> Render = 2.
  trustProxy: Number(env.TRUST_PROXY || 1),
  sessionHours: Number(env.SESSION_HOURS || 12),
  approvalTtlMinutes: Number(env.APPROVAL_TTL_MINUTES || 10),
  maxInsideHours: Number(env.MAX_INSIDE_HOURS || 10),
  idImageRetentionHours: Number(env.ID_IMAGE_RETENTION_HOURS || 24),
  worker: { intervalMs: 3000, maxAttempts: 10 }, // retries back off to once a minute: about 5 minutes of internet trouble before a message counts as failed
  printer: {
    mode: env.PRINTER_MODE || 'file',      // tcp | file | off
    host: env.PRINTER_HOST || '',
    port: Number(env.PRINTER_PORT || 9100),
    timeoutMs: 5000,
  },
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',            // from @BotFather; empty = Telegram off
    botUsername: env.TELEGRAM_BOT_USERNAME || '',   // optional; learned from Telegram when empty
    apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  },
  // Mobile-number verification by OTP (MSG91). Without an auth key the code is only written to the server log (test mode).
  otp: {
    authKey: env.MSG91_AUTHKEY || '',
    templateId: env.MSG91_OTP_TEMPLATE_ID || '',   // the DLT-approved OTP template, from MSG91 -> OTP
    expiryMinutes: Number(env.OTP_EXPIRY_MINUTES || 5),
    dailyLimit: Number(env.OTP_DAILY_LIMIT || 300), // SMS sent per day across the site: a cap on cost if someone keeps pressing "send"
    verifiedDays: Number(env.OTP_VERIFIED_DAYS || 0), // 0 = ask on every visit; N = a number verified within N days is not asked again
  },
  // How hosts get approval requests. auto = WhatsApp when it is set up, else Telegram when the host connected
  // it, else SMS; sms = always SMS.
  approvalChannel: env.APPROVAL_CHANNEL || 'auto',
  // WhatsApp Cloud API (Meta -> your app -> WhatsApp -> API Setup). Empty token = WhatsApp off.
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneId: env.WHATSAPP_PHONE_ID || '',          // the sending number's "Phone number ID", not the number itself
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',  // any phrase; type the same one in Meta when saving the webhook
    appSecret: env.WHATSAPP_APP_SECRET || '',      // optional: Meta app -> Settings -> Basic; checks each webhook call is from Meta
    apiBase: env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v25.0',
  },
  // on = the guard's waiting screen also offers "Send on WhatsApp": it opens WhatsApp on the gate device with the
  // host's number and the approval link filled in, and the guard presses send. No WhatsApp API or template needed.
  approvalWhatsapp: env.APPROVAL_WHATSAPP === 'on',
  // Email approvals, sent as well as WhatsApp / SMS to every host with an email address. Free.
  //   smtp:  any mail server (Gmail with an app password, Microsoft 365, Zoho, Brevo SMTP)
  //   brevo: Brevo's HTTP API (free 300 a day; works where SMTP ports are closed)
  //   off:   no email (default)
  email: {
    driver: env.EMAIL_DRIVER || 'off',
    from: env.EMAIL_FROM || env.SMTP_USER || '',          // the sending address
    fromName: env.EMAIL_FROM_NAME || 'Security desk',
    smtp: { host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '' },
    brevoKey: env.BREVO_API_KEY || '',
  },
  sms: {
    driver: env.SMS_DRIVER || 'console',   // console | http | msg91
    // msg91: approval text sent through a DLT-approved template. The template's variables, in order, receive
    // Two names (the DLT template): ["Ravi Kumar from Deloitte", the whole approval link for its {#url#} tag].
    // Three names (older templates): [visitor name, company, link code].
    msg91TemplateId: env.MSG91_APPROVAL_TEMPLATE_ID || '',
    msg91Vars: (env.MSG91_APPROVAL_VARS || 'var1,var2').split(',').map((s) => s.trim()),
    // msg91: one DLT template per emergency type (DLT allows no free text). Its two {#var#} receive the site's short
    // name and the assembly point, 30 characters each. A type without a template is not sent by SMS.
    msg91Alerts: {
      fire: env.MSG91_ALERT_FIRE_ID || '', evacuate: env.MSG91_ALERT_EVACUATE_ID || '', gas: env.MSG91_ALERT_GAS_ID || '',
      shelter: env.MSG91_ALERT_SHELTER_ID || '', drill: env.MSG91_ALERT_DRILL_ID || '', allclear: env.MSG91_ALERT_ALLCLEAR_ID || '',
    },
    msg91AlertVars: (env.MSG91_ALERT_VARS || 'var1,var2').split(',').map((s) => s.trim()),
    alertSiteShort: env.ALERT_SITE_SHORT || '',   // e.g. "St Regis Marriott Delhi" (30 characters at most)
    // msg91: "your visitor left" to the host; {#var#} 1 = the visitor, 2 = time and gate (30 characters each)
    msg91CheckoutTemplateId: env.MSG91_CHECKOUT_TEMPLATE_ID || '',
    // msg91: "thank you for visiting" to the visitor; {#var#} 1 = ALERT_SITE_SHORT, 2 = time and gate (30 characters each)
    msg91ThanksTemplateId: env.MSG91_THANKS_TEMPLATE_ID || '',
    httpUrl: env.SMS_HTTP_URL || '',
    httpAuth: env.SMS_HTTP_AUTH || '',     // full Authorization header value
    senderId: env.SMS_SENDER_ID || 'VMSITE',
  },
};
