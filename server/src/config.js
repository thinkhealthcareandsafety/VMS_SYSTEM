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
  // Proxies in front of the app, so req.ip is the visitor's address. Vercel -> Render = 2.
  trustProxy: Number(env.TRUST_PROXY || 1),
  sessionHours: Number(env.SESSION_HOURS || 12),
  approvalTtlMinutes: Number(env.APPROVAL_TTL_MINUTES || 10),
  maxInsideHours: Number(env.MAX_INSIDE_HOURS || 10),
  idImageRetentionHours: Number(env.ID_IMAGE_RETENTION_HOURS || 24),
  worker: { intervalMs: 3000, maxAttempts: 5 },
  printer: {
    mode: env.PRINTER_MODE || 'file',      // tcp | file | off
    host: env.PRINTER_HOST || '',
    port: Number(env.PRINTER_PORT || 9100),
    timeoutMs: 5000,
  },
  sms: {
    driver: env.SMS_DRIVER || 'console',   // console | http
    httpUrl: env.SMS_HTTP_URL || '',
    httpAuth: env.SMS_HTTP_AUTH || '',     // full Authorization header value
    senderId: env.SMS_SENDER_ID || 'VMSITE',
  },
};
