require('express-async-errors');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const config = require('./config');
const worker = require('./services/worker');
const { requireRole } = require('./middleware/auth');
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
  app.use(express.json({ limit: '6mb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
  app.get('/api/events', requireRole('guard', 'admin'), stream);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/visits', require('./routes/visits'));
  app.use('/api/hosts', require('./routes/hosts'));
  app.use('/api/approvals', require('./routes/approvals'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/telegram', require('./routes/telegram'));

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
  await mongoose.connect(config.mongoUri);
  console.log('MongoDB connected');
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
