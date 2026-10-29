require('express-async-errors');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const config = require('./config');
const worker = require('./services/worker');
const jwt = require('jsonwebtoken');
const { requireRole, COOKIE } = require('./middleware/auth');
const { stream } = require('./services/events');
const telegram = require('./services/telegram');

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  // 'wasm-unsafe-eval' lets the on-device engines (Aadhaar reader, face match) run WebAssembly; no other script source is allowed.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'", "'wasm-unsafe-eval'"], imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'mediastream:'], connectSrc: ["'self'"], workerSrc: ["'self'"],
      },
    },
  }));
  // WhatsApp webhook calls are signed over the exact bytes Meta sent, so keep them.
  app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/whatsapp')) req.rawBody = buf; } }));
  app.use(cookieParser());
  // Signed-in staff are limited per session, not per IP: every gate device in a hotel usually shares one public IP,
  // and a busy event (hundreds of scans plus live updates on several desks) must never trip a shared limit.
  // Anyone without a valid session is limited per IP, and public pages add their own stricter limits.
  const sessionKey = (req) => {
    const token = req.cookies?.[COOKIE];
    if (!token) return null;
    try { return `s:${jwt.verify(token, process.env.JWT_SECRET).sub}`; } catch { return null; }
  };
  app.use('/api', rateLimit({
    windowMs: 60e3,
    limit: (req) => (sessionKey(req) ? 1500 : 300),
    keyGenerator: (req) => sessionKey(req) || req.ip,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // Public privacy policy, linked from the WhatsApp (Meta) app settings.
  app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
  app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
  // On the hotel's server, the internet tunnel reaches only what hosts and guests open; the console, the guard
  // desk and sign-in answer inside the hotel only. Cloudflare marks every tunnelled request with Cf-Connecting-Ip.
  const PUBLIC_API = /^\/api\/(approvals|parcel-responses|material-approvals|passes|whatsapp|telegram|health)(\/|$)/;
  app.use((req, res, next) => {
    if (!config.lanOnly || !req.get('cf-connecting-ip') || !req.path.startsWith('/api/') || PUBLIC_API.test(req.path)) return next();
    return res.status(403).json({ error: 'This is available only inside the hotel.' });
  });
  app.get('/api/license', requireRole('guard', 'admin'), async (req, res) => res.json(await require('./services/license').status()));
  app.get('/api/events', requireRole('guard', 'admin'), stream);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/visits', require('./routes/visits'));
  app.use('/api/hosts', require('./routes/hosts'));
  app.use('/api/approvals', require('./routes/approvals'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/telegram', require('./routes/telegram'));
  app.use('/api/whatsapp', require('./routes/whatsapp'));
  app.use('/api/groups', require('./routes/groups').router);
  app.use('/api/passes', require('./routes/groups').publicRouter);
  app.use('/api/material', require('./routes/material').router);
  app.use('/api/material-approvals', require('./routes/material').publicRouter);
  app.use('/api/parcels', require('./routes/parcels').router);
  app.use('/api/parcel-responses', require('./routes/parcels').publicRouter);
  app.use('/api/emergency', require('./routes/emergency'));
  app.use('/api/reports', require('./routes/reports'));

  // Production: serve the built React app. Development: Vite serves it on :5173.
  const dist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html'), (err) => err && res.status(404).end()));

  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' });
  });
  return app;
}

async function main() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Set JWT_SECRET (32+ random characters) in .env');
  }
  // Every save waits until it is in the database's journal on disk (j: true). Without it a save is confirmed up to
  // 100 ms before that, and a power cut in that moment loses a visit the guard was told went through.
  await mongoose.connect(config.mongoUri, { writeConcern: { w: 1, j: true } });
  console.log('MongoDB connected');
  await require('./services/passes').ensureDefaultGate();
  // Swaps the first, non-unique emergency index for the one that allows a single active emergency.
  await require('./models').Emergency.syncIndexes().catch((err) => console.error('[emergency] index sync failed:', err.message));
  await require('./services/gate').backfillPassCodes(); // passes printed before pass codes existed
  worker.start();
  telegram.init(); // registers the webhook when a bot token is set
  createApp().listen(config.port, () => console.log(`${config.siteName} API on :${config.port}`));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, main };
