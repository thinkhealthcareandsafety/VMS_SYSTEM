const config = require('../config');
const email = require('./email');
const health = require('./health');
const settings = require('./settings');

// GateSmartX support hears about trouble at the site without anyone at the hotel having to notice or call: the server
// restarting (a power cut, a crash), the backup failing, late or not on the backup drive, the disk running low.
// Each problem is emailed when it starts and at most once a day while it lasts. Needs SUPPORT_EMAIL and email set up.
const DAY = 24 * 3600e3;
const sentAt = new Map();

async function tell(key, subject, lines) {
  if (!config.supportEmail || !email.enabled()) return false;
  if (Date.now() - (sentAt.get(key) || 0) < DAY) return false;
  sentAt.set(key, Date.now());
  const { siteName } = await settings.get().catch(() => ({}));
  const site = siteName || config.siteName;
  const mail = email.noticeEmail({ headline: `${site}: ${subject}`, rows: lines, note: `Server: ${config.appBaseUrl}` });
  try {
    await email.send(config.supportEmail, `[GateSmartX] ${site}: ${subject}`, mail.html, mail.text);
    return true;
  } catch (err) {
    sentAt.delete(key); // try again on the next check
    console.error('[support alert]', err.message);
    return false;
  }
}

const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');

// Run by the worker. Checks once every 15 minutes.
let lastCheck = 0;
async function check({ force = false } = {}) {
  if (!force && Date.now() - lastCheck < 15 * 60e3) return;
  lastCheck = Date.now();
  const b = health.backup();
  if (b.state === 'failed') await tell('backup-failed', 'the backup failed', [['Reason', b.error], ['Last attempt', when(b.at)]]);
  else if (b.state === 'stale') await tell('backup-stale', 'no backup for over a day', [['Last backup', when(b.at)]]);
  else if (b.state === 'nodrive') await tell('backup-nodrive', 'no backup drive connected', [['Backups', 'Database only, on the server\'s own disk; photos are not copied']]);
  const d = health.disk();
  if (d?.low) await tell('disk-low', `only ${d.freeGb} GB of disk space left`, [['Free space', `${d.freeGb} GB`]]);
}

// Once at start: the server was down for a moment (power cut, restart, update). Says when it came back.
function started() {
  setTimeout(() => {
    tell('started', 'the server started', [['Started', when(new Date(Date.now() - process.uptime() * 1000))], ['Uptime of the PC', `${Math.round(require('node:os').uptime() / 60)} min`]]).catch(() => {});
  }, 60e3).unref();
}

module.exports = { check, started, tell };
