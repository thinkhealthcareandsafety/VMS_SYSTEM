// Demo data: one guard, one admin, sample hosts. Passwords come from env, never hard-coded.
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const { User, Host } = require('../src/models');

(async () => {
  const pw = process.env.SEED_PASSWORD;
  if (!pw || pw.length < 10) throw new Error('Set SEED_PASSWORD (10+ chars) in .env');
  await mongoose.connect(config.mongoUri);
  const hash = await bcrypt.hash(pw, 12);
  await User.updateOne({ username: 'guard1' }, { username: 'guard1', fullName: 'Gate Guard', role: 'guard', passwordHash: hash }, { upsert: true });
  await User.updateOne({ username: 'admin' }, { username: 'admin', fullName: 'Site Admin', role: 'admin', passwordHash: hash }, { upsert: true });
  if ((await Host.countDocuments()) === 0) {
    await Host.insertMany([
      { fullName: 'Asha Verma', unit: 'A-101', mobile: '+919000000001' },
      { fullName: 'Rahul Mehta', unit: 'B-302', mobile: '+919000000002' },
      { fullName: 'Priya Nair', unit: 'HR Dept', mobile: '+919000000003' },
    ]);
  }
  console.log('Seeded guard1 / admin (password from SEED_PASSWORD) and sample hosts');
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
