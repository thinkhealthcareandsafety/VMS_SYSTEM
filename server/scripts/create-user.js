// Usage: npm run user:create -- <username> "<Full Name>" <guard|admin> <password>
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const { User } = require('../src/models');

(async () => {
  const [username, fullName, role, password] = process.argv.slice(2);
  if (!username || !fullName || !['guard', 'admin'].includes(role) || !password || password.length < 10) {
    console.error('Usage: user:create -- <username> "<Full Name>" <guard|admin> <password (10+ chars)>');
    process.exit(1);
  }
  await mongoose.connect(config.mongoUri);
  await User.create({ username, fullName, role, passwordHash: await bcrypt.hash(password, 12) });
  console.log(`Created ${role} user "${username}"`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
