const { EventEmitter } = require('node:events');

// In-process change feed. Routes call publish(); /api/events streams it to open screens (SSE).
const bus = new EventEmitter();
// End each stream before proxies cut it (Vercel drops proxied requests at 120 s); the browser reconnects in 3 s.
const STREAM_MS = 90000;
bus.setMaxListeners(500);

const publish = (type, data = {}) => bus.emit('change', { type, ...data, at: Date.now() });

function stream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  const end = setTimeout(() => res.end(), STREAM_MS);
  bus.on('change', send);
  req.on('close', () => {
    clearInterval(ping);
    clearTimeout(end);
    bus.off('change', send);
  });
}

module.exports = { publish, stream };
