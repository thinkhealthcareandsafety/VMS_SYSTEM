// End-to-end: check-in -> SMS link -> host approve -> daily pass -> checkout / force checkout.
// Runs against an in-memory MongoDB, so no database install is needed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-test-'));
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.PRINTER_MODE = 'file';
process.env.SMS_DRIVER = 'console';
process.env.APPROVAL_TTL_MINUTES = '10';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

let mongod, server, base;
const jpeg = () => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(300, 7)]).toString('base64');

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function login(username, password) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, 'login should succeed');
  return res.headers.get('set-cookie').split(';')[0];
}

let guard, admin, hostIds = {};

before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  const { createApp } = require('../src/server');
  const config = require('../src/config');
  await mongoose.connect(config.mongoUri);
  const { User, Host } = require('../src/models');
  const hash = await bcrypt.hash('guard-pass-123', 10);
  await User.create({ username: 'guard1', fullName: 'Gate Guard', role: 'guard', passwordHash: hash });
  await User.create({ username: 'admin', fullName: 'Admin', role: 'admin', passwordHash: hash });
  const hosts = await Host.create([
    { fullName: 'Asha Verma', unit: 'A-101', mobile: '+919000000001' },
    { fullName: 'Rahul Mehta', unit: 'B-302', mobile: '+919000000002' },
  ]);
  hostIds = { asha: String(hosts[0]._id), rahul: String(hosts[1]._id) };
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  guard = await login('guard1', 'guard-pass-123');
  admin = await login('admin', 'guard-pass-123');
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongod?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Pull the raw approval token out of the SMS the worker would send.
async function tokenFor(visitId) {
  const { Outbox } = require('../src/models');
  const sms = await Outbox.findOne({ kind: 'sms', visit: visitId }).sort({ _id: -1 });
  return /approve\/([\w-]+)/.exec(sms.body)[1];
}

const checkIn = (first, hostId) => call('POST', '/api/visits', {
  firstName: first, lastName: 'Sharma', mobile: '9876543210', company: 'Acme Ltd', purpose: 'Demo',
  hostId, photo: jpeg(), idImage: jpeg(), idMaskConfirmed: true,
}, guard);

test('guard can check in, host approves, pass number is issued', async () => {
  const r = await checkIn('Ravi', hostIds.asha);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pending');
  assert.match(r.body.ref, /^V-\d{6}$/);

  const raw = await tokenFor(r.body.id);
  const info = await call('GET', `/api/approvals/${raw}`);
  assert.equal(info.body.state, 'pending');
  assert.equal(info.body.firstName, 'Ravi');

  const dec = await call('POST', `/api/approvals/${raw}/decision`, { decision: 'approve' });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.dailyNumber, 1);

  // Same link cannot be used twice
  const again = await call('POST', `/api/approvals/${raw}/decision`, { decision: 'reject' });
  assert.equal(again.status, 409);
});

test('daily pass numbers increment and rejection does not consume a number', async () => {
  const v2 = await checkIn('Meera', hostIds.rahul);
  const raw2 = await tokenFor(v2.body.id);
  const rej = await call('POST', `/api/approvals/${raw2}/decision`, { decision: 'reject' });
  assert.equal(rej.body.status, 'rejected');
  assert.equal(rej.body.dailyNumber, null);

  const v3 = await checkIn('Kiran', hostIds.rahul);
  const raw3 = await tokenFor(v3.body.id);
  const ok = await call('POST', `/api/approvals/${raw3}/decision`, { decision: 'approve' });
  assert.equal(ok.body.dailyNumber, 2);
});

test('inside list, checkout, and force checkout with reason', async () => {
  const inside = await call('GET', '/api/visits/inside', null, guard);
  assert.equal(inside.body.count, 2);

  const first = inside.body.visits.find((v) => v.firstName === 'Ravi');
  const out = await call('POST', `/api/visits/${first.id}/checkout`, {}, guard);
  assert.equal(out.body.status, 'checked_out');

  const second = inside.body.visits.find((v) => v.firstName === 'Kiran');
  const noReason = await call('POST', `/api/visits/${second.id}/force-checkout`, { reason: 'x' }, admin);
  assert.equal(noReason.status, 400);
  const force = await call('POST', `/api/visits/${second.id}/force-checkout`, { reason: 'Guard forgot to mark exit' }, admin);
  assert.equal(force.body.status, 'force_checked_out');

  const again = await call('POST', `/api/visits/${second.id}/checkout`, {}, guard);
  assert.equal(again.status, 409);
});

test('roles are enforced and history is searchable by admin', async () => {
  const denied = await call('GET', '/api/admin/visits', null, guard);
  assert.equal(denied.status, 403);
  const anon = await call('GET', '/api/visits/inside');
  assert.equal(anon.status, 401);

  const hist = await call('GET', '/api/admin/visits?name=Kiran', null, admin);
  assert.equal(hist.body.total, 1);
  assert.equal(hist.body.rows[0].status, 'force_checked_out');
});

test('admin can download visits as an Excel-safe sheet and as a ZIP with photos', async () => {
  const denied = await call('GET', '/api/admin/visits.zip', null, guard);
  assert.equal(denied.status, 403);

  const csv = await fetch(`${base}/api/admin/visits.csv`, { headers: { Cookie: admin } });
  assert.equal(csv.status, 200);
  const sheet = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...sheet.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads names correctly');
  const lines = sheet.toString('utf8').trim().split('\r\n');
  assert.equal(lines.length, 4, 'header + 3 visits');
  assert.match(lines[0], /"Visitor ID","Date","Pass no"/);
  assert.match(sheet.toString('utf8'), /"98765 43210"/, 'mobile written as text, not +91… (Excel would mangle it)');
  assert.match(sheet.toString('utf8'), /"Force checked out".*"Guard forgot to mark exit"/);

  const zip = await fetch(`${base}/api/admin/visits.zip?name=Kiran`, { headers: { Cookie: admin } });
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-type'), /application\/zip/);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  const names = bytes.toString('latin1');
  assert.match(names, /visitors\.csv/);
  assert.match(names, /photos\/V-\d{6} Kiran Sharma\.jpg/);
  assert.doesNotMatch(names, /Ravi Sharma\.jpg/, 'filters apply to the ZIP too');
});

test('worker delivers SMS and writes sticker files; print jobs are marked sent', async () => {
  const { processOutbox } = require('../src/services/worker');
  await processOutbox();
  const { Outbox } = require('../src/models');
  const pending = await Outbox.countDocuments({ status: 'queued' });
  assert.equal(pending, 0);
  const stickers = fs.readdirSync(path.join(tmp, 'print-out'));
  assert.equal(stickers.length, 2);
  const zpl = fs.readFileSync(path.join(tmp, 'print-out', stickers[0]), 'utf8');
  assert.match(zpl, /\^XA/);
});
