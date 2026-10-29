const fs = require('node:fs');
const config = require('../config');

// What the admin must hear about the site PC itself: the nightly backup and the free disk space.
const STALE_HOURS = 30; // backups run at 02:00; a day and a few hours without one means a night was missed

// { state: off | ok | none | stale | failed, at, error }. off: not the hotel install (no backup service).
function backup(now = Date.now()) {
  const file = process.env.BACKUP_STATUS_FILE;
  if (!file) return { state: 'off' };
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    return { state: process.uptime() > STALE_HOURS * 3600 ? 'stale' : 'none' };
  }
  const at = s.at ? new Date(s.at) : null;
  if (!s.ok) return { state: 'failed', at, error: s.error || 'The backup failed' };
  if (!at || now - at.getTime() > STALE_HOURS * 3600e3) return { state: 'stale', at };
  // Copied, but onto the PC's own disk: lost with it if that disk fails.
  if (s.drive === false) return { state: 'nodrive', at };
  return { state: 'ok', at };
}

// Free space where the photos are kept. Low: under 10 GB or under 10 per cent. Only on the hotel's own PC (the install
// sets BACKUP_STATUS_FILE): a cloud demo's small disk is not the hotel's concern.
function disk() {
  if (!process.env.BACKUP_STATUS_FILE) return null;
  try {
    const s = fs.statfsSync(config.uploadDir);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    return { freeGb: Math.round(free / 1e9 * 10) / 10, low: free < 10e9 || free / total < 0.1 };
  } catch { return null; }
}

module.exports = { backup, disk, STALE_HOURS };
