const config = require('../config');
const { Setting } = require('../models');

// Site settings with sensible defaults from the environment. Cached briefly: they are read on
// every pass print, approval page and purge run, and change rarely.
const defaults = () => ({
  siteName: config.siteName,
  gateName: 'Main gate',
  idRetentionDays: Math.max(1, Math.round(config.idImageRetentionHours / 24)),
});

let cache = null;
let cachedAt = 0;

async function get() {
  if (cache && Date.now() - cachedAt < 15000) return cache;
  const doc = await Setting.findById('site').lean();
  const merged = { ...defaults() };
  for (const k of Object.keys(merged)) if (doc && doc[k] != null && doc[k] !== '') merged[k] = doc[k];
  cache = merged;
  cachedAt = Date.now();
  return cache;
}

async function update(patch) {
  await Setting.updateOne({ _id: 'site' }, { $set: patch }, { upsert: true });
  cache = null;
  return get();
}

module.exports = { get, update, defaults };
