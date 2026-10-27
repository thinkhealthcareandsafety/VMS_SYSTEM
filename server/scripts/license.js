// Issues a GateSmartX licence key for one site. Run by GateSmartX only, with the private key that never leaves us.
// Usage: node scripts/license.js <private-key.pem> "<Site name>" <last day YYYY-MM-DD> [gates]
// Example: node scripts/license.js C:/Users/USER/GateSmartX-license/private-key.pem "St. Regis & Marriott Marquis New Delhi" 2027-01-27 3
const crypto = require('node:crypto');
const fs = require('node:fs');

const [keyPath, site, until, gates] = process.argv.slice(2);
if (!keyPath || !site || !/^\d{4}-\d{2}-\d{2}$/.test(until || '')) {
  console.error('Usage: node scripts/license.js <private-key.pem> "<Site name>" <YYYY-MM-DD> [gates]');
  process.exit(1);
}
const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
const body = Buffer.from(JSON.stringify({ site, until, gates: gates ? Number(gates) : undefined, issued: new Date().toISOString().slice(0, 10) })).toString('base64url');
const sig = crypto.sign(null, Buffer.from(body), key).toString('base64url');
console.log(`${body}.${sig}`);
