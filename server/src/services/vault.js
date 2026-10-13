const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

// Full (unmasked) ID images, encrypted at rest with AES-256-GCM. A file on disk or in a backup is unreadable
// without the key; only the Super Admin's request decrypts one, in memory, for that response.
// Key: ID_ENCRYPTION_KEY when set (keep it as safe as the database password); otherwise one derived from
// JWT_SECRET. Changing either makes images stored before unreadable, so set it once and leave it.
const MAGIC = Buffer.from('VMSID1');

let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;
  const own = process.env.ID_ENCRYPTION_KEY;
  cachedKey = own
    ? crypto.createHash('sha256').update(own).digest()
    : Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET || '', 'vms-full-id', 'id-image-v1', 32));
  return cachedKey;
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function open(sealed) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted ID image');
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = sealed.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + 28)), decipher.final()]);
}

async function store(buf) {
  const dir = path.resolve(config.uploadDir, 'id-full');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.bin`);
  await fs.writeFile(file, seal(buf), { mode: 0o600 });
  return file;
}

const read = async (file) => open(await fs.readFile(file));

module.exports = { store, read, seal, open };
