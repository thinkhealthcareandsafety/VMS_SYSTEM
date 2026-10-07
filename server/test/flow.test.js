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

let mongod, server, base, fakeTelegram;
const telegramCalls = [];
const startFakeTelegram = () => new Promise((resolve) => {
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const payload = raw ? JSON.parse(raw) : {};
      telegramCalls.push({ method, payload });
      const result = method === 'getMe' ? { username: 'test_gate_bot' } : method === 'sendMessage' ? { message_id: 700 + telegramCalls.length } : true;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
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
  fakeTelegram = await startFakeTelegram();
  process.env.TELEGRAM_BOT_TOKEN = '123:test-token';
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fakeTelegram.address().port}`;
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
  fakeTelegram?.close();
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

// Each test visitor gets their own number: one person cannot be waiting or inside twice.
const MOBILES = { Ravi: '9876543210', Meera: '9876543211', Kiran: '9876543212' };
const checkIn = (first, hostId, mobile = MOBILES[first]) => call('POST', '/api/visits', {
  firstName: first, lastName: 'Sharma', gender: 'male', mobile, company: 'Acme Ltd', purpose: 'Demo',
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
  assert.match(names, /Visitor records up to \d{4}-\d{2}-\d{2}\/Visitors\.xlsx/);
  assert.match(names, /\/Report\.html/);
  assert.match(names, /\/\d{4}-\d{2}-\d{2}\/V-\d{6} Kiran Sharma\/photo\.jpg/, 'one folder per visit');
  assert.doesNotMatch(names, /Ravi Sharma/, 'filters apply to the ZIP too');
  assert.doesNotMatch(names, /aadhaar-masked/, 'Aadhaar only when asked for');

  // With Aadhaar: the masked image goes in the visitor's folder, and the download is audited as such.
  const withId = Buffer.from(await (await fetch(`${base}/api/admin/visits.zip?name=Kiran&aadhaar=1`, { headers: { Cookie: admin } })).arrayBuffer());
  assert.match(withId.toString('latin1'), /V-\d{6} Kiran Sharma\/aadhaar-masked\.jpg/);
  const { Audit } = require('../src/models');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await Audit.exists({ action: 'export.visits_zip', 'details.aadhaar': true }));

  // The Excel file reads back with clean columns: real dates, the mobile kept as text, people's names whole.
  const ExcelJS = require('exceljs');
  const xr = await fetch(`${base}/api/admin/visits.xlsx`, { headers: { Cookie: admin } });
  assert.equal(xr.status, 200);
  assert.match(xr.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await xr.arrayBuffer()));
  const ws = wb.getWorksheet('Visits');
  const header = ws.getRow(1).values.slice(1);
  assert.deepEqual(header.slice(0, 6), ['Visitor ID', 'Date', 'Pass no', 'Name', 'Gender', 'Mobile (+91)']);
  const ravi = ws.getSheetValues().find((r) => r && r[4] === 'Ravi Sharma');
  assert.ok(ravi, 'a row per visit');
  assert.equal(ravi[5], 'Male');
  assert.equal(ravi[6], '98765 43210');
  assert.ok(ravi[2] instanceof Date, 'Date is a real date, sortable in Excel');
  assert.ok(wb.getWorksheet('About this download'), 'says what the file contains');
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

// ---------------------------------------------------------------- Rules added for the client review
test('same person cannot be checked in twice while waiting or inside; cancelling frees them', async () => {
  const first = await checkIn('Anil', hostIds.asha, '9811111111');
  assert.equal(first.status, 201);
  const dup = await checkIn('Anil', hostIds.asha, '9811111111');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'already_active');
  assert.match(dup.body.error, /already waiting/);

  const look = await call('GET', '/api/visits/lookup?mobile=9811111111', null, guard);
  assert.equal(look.body.active.status, 'pending', 'the form can warn as soon as the number is typed');

  const queue = await call('GET', '/api/visits/queue', null, guard);
  assert.ok(queue.body.rows.some((r) => r.id === first.body.id && r.status === 'pending'));

  const raw = await tokenFor(first.body.id);
  const cancel = await call('POST', `/api/visits/${first.body.id}/cancel`, {}, guard);
  assert.equal(cancel.body.status, 'cancelled');
  const info = await call('GET', `/api/approvals/${raw}`);
  assert.equal(info.body.state, 'cancelled', 'host link explains instead of offering buttons');
  const late = await call('POST', `/api/approvals/${raw}/decision`, { decision: 'approve' });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /cancelled/);

  const again = await checkIn('Anil', hostIds.asha, '9811111111');
  assert.equal(again.status, 201);
});

test('resend is throttled, an old link says a newer one exists, and a decline is logged as visit.rejected', async () => {
  const { Outbox, Audit } = require('../src/models');
  const v = await checkIn('Sunita', hostIds.rahul, '9822222222');
  const oldRaw = await tokenFor(v.body.id);

  const tooSoon = await call('POST', `/api/visits/${v.body.id}/resend`, {}, guard);
  assert.equal(tooSoon.status, 429);
  await Outbox.collection.updateMany({ visit: new mongoose.Types.ObjectId(v.body.id) }, { $set: { createdAt: new Date(Date.now() - 60e3) } });
  const resent = await call('POST', `/api/visits/${v.body.id}/resend`, {}, guard);
  assert.equal(resent.status, 200);

  const stale = await call('POST', `/api/approvals/${oldRaw}/decision`, { decision: 'approve' });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /newer link/);

  const dec = await call('POST', `/api/approvals/${await tokenFor(v.body.id)}/decision`, { decision: 'reject' });
  assert.equal(dec.body.status, 'rejected');
  await new Promise((r) => setTimeout(r, 100)); // audit writes are fire-and-forget
  assert.ok(await Audit.exists({ action: 'visit.rejected', entityId: v.body.id }));
  assert.equal(await Audit.exists({ action: 'visit.rejectd' }), null);
});

test('mobiles must be real Indian mobiles; all-lowercase names are tidied', async () => {
  const bad = await checkIn('Test', hostIds.asha, '5123456789');
  assert.equal(bad.status, 400);
  const r = await call('POST', '/api/visits', {
    firstName: 'priya', lastName: "d'souza", gender: 'female', mobile: '09833333333', company: 'X Corp',
    hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), idMaskConfirmed: true,
  }, guard);
  assert.equal(r.status, 201);
  const { Visit } = require('../src/models');
  const v = await Visit.findById(r.body.id).lean();
  assert.equal(v.firstName, 'Priya');
  assert.equal(v.lastName, "D'Souza");
  assert.equal(v.mobile, '+919833333333');
});

test('gender is required; the on-device face match score is kept, clamped and shown to the admin only', async () => {
  const body = { firstName: 'Anil', lastName: 'Rao', company: 'Rao Co', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg() };
  const none = await call('POST', '/api/visits', { ...body, mobile: '9844400001' }, guard);
  assert.equal(none.status, 400);
  assert.match(none.body.error, /male, female or other/i);
  assert.equal((await call('POST', '/api/visits', { ...body, mobile: '9844400001', gender: 'robot' }, guard)).status, 400);

  const ok = await call('POST', '/api/visits', { ...body, mobile: '9844400002', gender: 'other', faceMatch: 'scored', faceMatchScore: 73.6 }, guard);
  assert.equal(ok.status, 201);
  const { Visit } = require('../src/models');
  const v = await Visit.findById(ok.body.id).lean();
  assert.equal(v.gender, 'other');
  assert.equal(v.faceMatchStatus, 'scored');
  assert.equal(v.faceMatchScore, 74);

  // A made-up or out-of-range score is ignored, and a score without the "scored" flag is not stored.
  for (const [i, extra] of [{ faceMatch: 'scored', faceMatchScore: 240 }, { faceMatch: 'scored', faceMatchScore: 'high' }, { faceMatchScore: 90 }].entries()) {
    const r = await call('POST', '/api/visits', { ...body, mobile: `984440001${i}`, gender: 'female', ...extra }, guard);
    assert.equal(r.status, 201);
    const d = await Visit.findById(r.body.id).lean();
    assert.equal(d.faceMatchScore, undefined);
    assert.equal(d.faceMatchStatus, undefined);
  }
  const noFace = await call('POST', '/api/visits', { ...body, mobile: '9844400020', gender: 'male', faceMatch: 'no_card_face' }, guard);
  assert.equal((await Visit.findById(noFace.body.id).lean()).faceMatchStatus, 'no_card_face');

  const asAdmin = await call('GET', `/api/visits/${ok.body.id}`, null, admin);
  assert.equal(asAdmin.body.gender, 'other');
  assert.equal(asAdmin.body.faceMatchScore, 74);
  const asGuard = await call('GET', `/api/visits/${ok.body.id}`, null, guard);
  assert.equal(asGuard.body.faceMatchScore, undefined, 'the guard sees the score at the desk, the stored value is admin-only');

  const hist = await call('GET', '/api/admin/visits?name=Anil', null, admin);
  assert.ok(hist.body.rows.some((r) => r.gender === 'other' && r.faceMatchScore === 74));
  const csv = await fetch(`${base}/api/admin/visits.csv?name=Anil`, { headers: { Cookie: admin } }).then((r) => r.text());
  assert.match(csv, /"Gender"/);
  assert.match(csv, /"Other"/);
  assert.match(csv, /"74"/);
  const lookup = await call('GET', '/api/visits/lookup?mobile=9844400002', null, guard);
  assert.equal(lookup.body.gender, 'other', 'a returning visitor comes back with their gender filled in');

  // Email is optional: empty is fine, a malformed one is refused, a good one is kept in lower case.
  assert.equal((await call('POST', '/api/visits', { ...body, mobile: '9844400030', gender: 'male', email: 'not-an-email' }, guard)).status, 400);
  const withMail = await call('POST', '/api/visits', { ...body, mobile: '9844400031', gender: 'male', email: ' Anil.Rao@Example.com ' }, guard);
  assert.equal(withMail.status, 201);
  assert.equal((await Visit.findById(withMail.body.id).lean()).email, 'anil.rao@example.com');
  assert.equal((await Visit.findById(ok.body.id).lean()).email, undefined);
});

test('mobile OTP: off by default, then optional and required modes, limits and expected visitors', async () => {
  const messaging = require('../src/services/messaging');
  const settings = require('../src/services/settings');
  const { Visit, Otp } = require('../src/models');
  const sent = [];
  const realSend = messaging.sendOtp;
  messaging.sendOtp = async (to, code) => { sent.push({ to, code }); return 'test'; };
  const body = (mobile, extra = {}) => ({ firstName: 'Omar', lastName: 'Khan', gender: 'male', company: 'Khan Co', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), mobile, ...extra });
  try {
    // Off by default: no codes, check-in works as before, nothing is recorded about verification.
    assert.equal((await call('POST', '/api/visits/otp/send', { mobile: '9855500001' }, guard)).status, 409);
    const plain = await call('POST', '/api/visits', body('9855500001'), guard);
    assert.equal(plain.status, 201);
    assert.equal((await Visit.findById(plain.body.id).lean()).mobileVerified, undefined);

    // Only admins can change the mode, and only to a known value.
    assert.equal((await call('PATCH', '/api/admin/settings', { otpMode: 'required' }, guard)).status, 403);
    assert.equal((await call('PATCH', '/api/admin/settings', { otpMode: 'sometimes' }, admin)).status, 400);
    assert.equal((await call('PATCH', '/api/admin/settings', { otpMode: 'required' }, admin)).status, 200);

    // Required: refused until the number is verified; the guard cannot skip.
    const mobile = '9855500002';
    assert.equal((await call('GET', `/api/visits/lookup?mobile=${mobile}`, null, guard)).body.otp.mode, 'required');
    const refused = await call('POST', '/api/visits', body(mobile), guard);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'verify_required');
    assert.equal((await call('POST', '/api/visits', body(mobile, { otpSkip: true }), guard)).status, 409);

    // Send, get it wrong, then right. Only a hash of the code is stored.
    assert.equal((await call('POST', '/api/visits/otp/send', { mobile }, guard)).status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].code, /^\d{6}$/);
    assert.equal((await Otp.findOne({ mobile: '+91' + mobile }).lean()).codeHash.includes(sent[0].code), false);
    assert.equal((await call('POST', '/api/visits/otp/send', { mobile }, guard)).status, 429, 'resend needs a short wait');
    const wrong = sent[0].code === '000000' ? '111111' : '000000';
    const bad = await call('POST', '/api/visits/otp/verify', { mobile, code: wrong }, guard);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.triesLeft, 2);
    assert.equal((await call('POST', '/api/visits', body(mobile), guard)).status, 409, 'a wrong try does not verify');
    const good = await call('POST', '/api/visits/otp/verify', { mobile, code: sent[0].code }, guard);
    assert.equal(good.body.verified, true);
    const ok = await call('POST', '/api/visits', body(mobile), guard);
    assert.equal(ok.status, 201);
    const saved = await Visit.findById(ok.body.id).lean();
    assert.equal(saved.mobileVerified, 'otp');
    assert.ok(saved.mobileVerifiedAt);

    // Three wrong tries lock that code.
    const m2 = '9855500003';
    await call('POST', '/api/visits/otp/send', { mobile: m2 }, guard);
    for (let i = 0; i < 3; i += 1) await call('POST', '/api/visits/otp/verify', { mobile: m2, code: '999999' }, guard);
    const locked = await call('POST', '/api/visits/otp/verify', { mobile: m2, code: sent[sent.length - 1].code }, guard);
    assert.equal(locked.status, 429);

    // An expired code is refused.
    const m3 = '9855500004';
    await call('POST', '/api/visits/otp/send', { mobile: m3 }, guard);
    await Otp.updateMany({ mobile: '+91' + m3 }, { expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await call('POST', '/api/visits/otp/verify', { mobile: m3, code: sent[sent.length - 1].code }, guard)).status, 400);

    // Optional: no code needed; an explicit skip is recorded; a failed SMS never blocks the visitor.
    assert.equal((await call('PATCH', '/api/admin/settings', { otpMode: 'optional' }, admin)).status, 200);
    const skipped = await call('POST', '/api/visits', body('9855500005', { otpSkip: true }), guard);
    assert.equal((await Visit.findById(skipped.body.id).lean()).mobileVerified, 'skipped');
    const silent = await call('POST', '/api/visits', body('9855500006'), guard);
    assert.equal(silent.status, 201);
    assert.equal((await Visit.findById(silent.body.id).lean()).mobileVerified, undefined);
    messaging.sendOtp = async () => { throw new Error('gateway down'); };
    assert.equal((await call('POST', '/api/visits/otp/send', { mobile: '9855500007' }, guard)).status, 502);

    // A number verified recently is not asked again; the lookup says so.
    assert.equal((await call('GET', `/api/visits/lookup?mobile=${mobile}`, null, guard)).body.otp.verified, 'otp', 'still fresh right after the code');
    await Otp.updateMany({ mobile: '+91' + mobile }, { verifiedAt: new Date(Date.now() - 3600e3) });
    const again = await call('GET', `/api/visits/lookup?mobile=${mobile}`, null, guard);
    assert.equal(again.body.otp.verified, 'returning');

    // Expected visitors come with a number the host gave us: no code.
    await call('PATCH', '/api/admin/settings', { otpMode: 'required' }, admin);
    const day = require('../src/services/core').siteDay();
    const inv = await call('POST', '/api/admin/invites', { firstName: 'Omar', lastName: 'Khan', mobile: '9855500008', company: 'Khan Co', hostId: hostIds.asha, day }, admin);
    assert.equal(inv.status, 201);
    const viaInvite = await call('POST', '/api/visits', body('9855500008', { inviteId: inv.body.id }), guard);
    assert.equal(viaInvite.status, 201);
    assert.equal((await Visit.findById(viaInvite.body.id).lean()).mobileVerified, 'expected');

    // Admins may skip even in required mode (and it is on the record).
    const adminSkip = await call('POST', '/api/visits', body('9855500009', { otpSkip: true }), admin);
    assert.equal(adminSkip.status, 201);
    assert.equal((await Visit.findById(adminSkip.body.id).lean()).mobileVerified, 'skipped');
  } finally {
    messaging.sendOtp = realSend;
    await settings.update({ otpMode: 'off' });
  }
});

test('admin manages staff: add a guard, reset signs them out everywhere, cannot lock themselves out', async () => {
  const created = await call('POST', '/api/admin/users', { username: 'gate2', fullName: 'Second Gate', role: 'guard' }, admin);
  assert.equal(created.status, 201);
  assert.ok(created.body.password.length >= 12, 'a strong password is generated and shown once');
  assert.equal((await call('POST', '/api/admin/users', { username: 'gate2', fullName: 'Someone Else', role: 'guard' }, admin)).status, 409);
  assert.equal((await call('GET', '/api/admin/users', null, guard)).status, 403);

  const gate2 = await login('gate2', created.body.password);
  assert.equal((await call('GET', '/api/visits/inside', null, gate2)).status, 200);

  const reset = await call('PATCH', `/api/admin/users/${created.body.id}`, { resetPassword: true }, admin);
  assert.ok(reset.body.password && reset.body.password !== created.body.password);
  const old = await call('GET', '/api/visits/inside', null, gate2);
  assert.equal(old.status, 401, 'the old session ends after a reset');
  assert.equal(old.body.code, 'session_expired');
  await login('gate2', reset.body.password);

  const off = await call('PATCH', `/api/admin/users/${created.body.id}`, { active: false }, admin);
  assert.equal(off.body.active, false);
  const blocked = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gate2', password: reset.body.password }) });
  assert.equal(blocked.status, 401);

  const me = (await call('GET', '/api/admin/users', null, admin)).body.rows.find((u) => u.username === 'admin');
  assert.equal((await call('PATCH', `/api/admin/users/${me.id}`, { active: false }, admin)).status, 400);
  assert.equal((await call('PATCH', `/api/admin/users/${me.id}`, { role: 'guard' }, admin)).status, 400);
});

test('admin can edit a host; bad mobiles and emails are refused with a clear reason', async () => {
  const edit = (body) => call('PATCH', `/api/admin/hosts/${hostIds.rahul}`, body, admin);
  assert.equal((await edit({ fullName: 'Rahul K Mehta', unit: 'B-303', mobile: '9123456789', email: 'rahul@example.com' })).status, 200);
  const { Host } = require('../src/models');
  const h = await Host.findById(hostIds.rahul).lean();
  assert.equal(h.fullName, 'Rahul K Mehta');
  assert.equal(h.unit, 'B-303');
  assert.equal(h.mobile, '+919123456789');
  assert.equal(h.email, 'rahul@example.com');
  assert.equal((await edit({ email: '' })).status, 200);
  assert.equal((await Host.findById(hostIds.rahul).lean()).email, undefined, 'clearing the email removes it');
  const badMobile = await edit({ mobile: '1234567890' });
  assert.equal(badMobile.status, 400);
  assert.match(badMobile.body.error, /6 to 9/);
  assert.equal((await edit({ email: 'not-an-email' })).status, 400);
});

test('sign-in tolerates a space or line break copied along with the password', async () => {
  for (const pw of ['guard-pass-123 ', ' guard-pass-123', 'guard-pass-123\n']) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: ' Guard1 ', password: pw }) });
    assert.equal(r.status, 200, JSON.stringify(pw));
  }
  const wrong = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'guard1', password: 'guard-pass-124 ' }) });
  assert.equal(wrong.status, 401);
});

test('printing a pass is recorded; only issued passes can be printed; the site name reaches the print layout', async () => {
  const { Audit } = require('../src/models');
  const v = await checkIn('Pooja', hostIds.asha, '9855555555');
  assert.equal((await call('POST', `/api/visits/${v.body.id}/printed`, {}, guard)).status, 409, 'no pass before the host approves');
  const dec = await call('POST', `/api/approvals/${await tokenFor(v.body.id)}/decision`, { decision: 'approve' });
  assert.equal(dec.status, 200);
  assert.equal((await call('POST', `/api/visits/${v.body.id}/printed`, {}, guard)).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await Audit.exists({ action: 'pass.printed', entityId: v.body.id }));
  assert.equal((await call('POST', `/api/visits/${v.body.id}/printed`)).status, 401, 'sign-in required');
  const me = await call('GET', '/api/auth/me', null, guard);
  assert.ok(me.body.siteName, 'the printed pass carries the site name');
});

test('Telegram: host connects once, gets the request with buttons, taps to decide; other chats cannot', async () => {
  const { Host, Outbox, Audit } = require('../src/models');
  const { processOutbox } = require('../src/services/worker');
  const telegram = require('../src/services/telegram');
  const hook = (body, secret = telegram.webhookSecret()) => fetch(base + '/api/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body),
  });
  const sent = (method, since = 0) => telegramCalls.slice(since).filter((c) => c.method === method);

  // Only Telegram (holding the secret) can call the webhook.
  assert.equal((await hook({ message: { chat: { id: 1, type: 'private' }, text: '/start' } }, 'wrong-secret')).status, 401);

  // 1. Admin makes a connect link; the host taps it in Telegram (/start <code>).
  const link = await call('POST', `/api/admin/hosts/${hostIds.asha}/telegram-link`, {}, admin);
  assert.equal(link.status, 200);
  assert.match(link.body.url, /^https:\/\/t\.me\/test_gate_bot\?start=[\w-]+$/);
  assert.equal((await call('POST', `/api/admin/hosts/${hostIds.asha}/telegram-link`, {}, guard)).status, 403);
  const code = link.body.url.split('start=')[1];
  let mark = telegramCalls.length;
  assert.equal((await hook({ message: { chat: { id: 5551, type: 'private' }, text: `/start ${code}` } })).status, 200);
  assert.match(sent('sendMessage', mark)[0].payload.text, /Connected/);
  assert.equal((await Host.findById(hostIds.asha).lean()).telegramChatId, '5551');
  assert.equal((await call('GET', '/api/admin/hosts', null, admin)).body.rows.find((h) => h.id === hostIds.asha).telegram, true);
  // The code works once.
  await hook({ message: { chat: { id: 6662, type: 'private' }, text: `/start ${code}` } });
  assert.equal((await Host.findById(hostIds.asha).lean()).telegramChatId, '5551', 'a used code cannot take over the connection');

  // 2. Check-in for this host goes to Telegram, with two buttons, not to SMS.
  const v = await checkIn('Zoya', hostIds.asha, '9866666666');
  assert.equal(v.status, 201);
  const job = await Outbox.findOne({ visit: v.body.id, kind: { $in: ['sms', 'telegram'] } }).lean();
  assert.equal(job.kind, 'telegram');
  assert.equal(job.to, '5551');
  mark = telegramCalls.length;
  await processOutbox();
  const req = sent('sendMessage', mark)[0].payload;
  assert.equal(req.chat_id, '5551');
  assert.match(req.text, /Zoya Sharma/);
  const [approveBtn, declineBtn] = req.reply_markup.inline_keyboard[0];
  assert.match(approveBtn.callback_data, /^a:[\w-]{20,}$/);
  assert.match(declineBtn.callback_data, /^r:/);
  assert.ok(telegramCalls.every((c) => c.method !== 'sendPhoto' && !('photo' in c.payload) && !('document' in c.payload)), 'no image is ever sent to Telegram');

  // 3. A tap from some other chat is refused and decides nothing.
  const tap = (data, chatId) => hook({ callback_query: { id: 'cb' + Math.random(), data, message: { message_id: 801, text: req.text, chat: { id: chatId, type: 'private' } } } });
  mark = telegramCalls.length;
  await tap(approveBtn.callback_data, 9999);
  assert.match(sent('answerCallbackQuery', mark)[0].payload.text, /not sent to you/);
  assert.equal((await call('GET', `/api/visits/${v.body.id}`, null, guard)).body.status, 'pending');

  // 4. The host's own tap approves: pass number issued, buttons retired, audited as via telegram.
  mark = telegramCalls.length;
  await tap(approveBtn.callback_data, 5551);
  const after = (await call('GET', `/api/visits/${v.body.id}`, null, guard)).body;
  assert.equal(after.status, 'approved');
  assert.ok(after.dailyNumber >= 1);
  assert.match(sent('editMessageText', mark)[0].payload.text, /You let Zoya Sharma in/);
  assert.deepEqual(sent('editMessageText', mark)[0].payload.reply_markup.inline_keyboard, []);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await Audit.exists({ action: 'visit.approved', entityId: v.body.id, 'details.via': 'telegram' }));

  // 5. A second tap (or the decline button) is told it is already decided.
  mark = telegramCalls.length;
  await tap(declineBtn.callback_data, 5551);
  assert.match(sent('answerCallbackQuery', mark)[0].payload.text, /already approved/);

  // 6. A host who has not connected still gets the SMS.
  const w = await checkIn('Yash', hostIds.rahul, '9877777777');
  assert.equal((await Outbox.findOne({ visit: w.body.id, kind: { $in: ['sms', 'telegram'] } }).lean()).kind, 'sms');

  // 7. Admin can disconnect.
  assert.equal((await call('PATCH', `/api/admin/hosts/${hostIds.asha}`, { disconnectTelegram: true }, admin)).status, 200);
  assert.equal((await Host.findById(hostIds.asha).lean()).telegramChatId, undefined);
  const stats = await call('GET', '/api/admin/stats', null, admin);
  assert.equal(stats.body.telegramOn, true);
});

test('expected visitor: admin registers them, the guard sees them on lookup, and they get a pass without waiting', async () => {
  const { Outbox, Invite } = require('../src/models');
  const { siteDay } = require('../src/services/core');
  const today = siteDay();
  const add = (body) => call('POST', '/api/admin/invites', { firstName: 'Neel', lastName: 'Joshi', mobile: '9811122233', company: 'Joshi & Co', purpose: 'Meeting', hostId: hostIds.rahul, day: today, ...body }, admin);

  assert.equal((await add({ day: '2001-01-01' })).status, 400, 'no dates in the past');
  assert.equal((await call('POST', '/api/admin/invites', {}, guard)).status, 403, 'admins only');
  const inv = await add({});
  assert.equal(inv.status, 201);
  assert.equal((await add({})).status, 409, 'not twice for the same day');

  const look = await call('GET', '/api/visits/lookup?mobile=9811122233', null, guard);
  assert.equal(look.body.found, false, 'first-time visitor');
  assert.equal(look.body.invite.id, inv.body.id, 'still shows as expected');
  assert.equal(look.body.invite.host.id, hostIds.rahul);

  // Expected for Rahul, but sent to Asha: the shortcut is refused rather than silently ignored.
  const wrongHost = await call('POST', '/api/visits', { firstName: 'Neel', lastName: 'Joshi', gender: 'male', mobile: '9811122233', company: 'Joshi & Co', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), inviteId: inv.body.id }, guard);
  assert.equal(wrongHost.status, 409);

  const v = await call('POST', '/api/visits', { firstName: 'Neel', lastName: 'Joshi', gender: 'male', mobile: '9811122233', company: 'Joshi & Co', hostId: hostIds.rahul, photo: jpeg(), idImage: jpeg(), inviteId: inv.body.id }, guard);
  assert.equal(v.status, 201);
  assert.equal(v.body.status, 'approved', 'let in on arrival');
  assert.ok(v.body.dailyNumber >= 1, 'pass number issued');
  assert.equal(await Outbox.countDocuments({ visit: v.body.id, kind: { $in: ['sms', 'telegram'] } }), 0, 'no message to the host');
  assert.equal((await Invite.findById(inv.body.id).lean()).status, 'arrived');
  assert.equal((await call('GET', '/api/visits/lookup?mobile=9811122233', null, guard)).body.invite, null, 'used once');

  const list = await call('GET', '/api/admin/invites', null, admin);
  assert.equal(list.body.rows.find((r) => r.id === inv.body.id).status, 'arrived');
  const later = await add({ mobile: '9811122244', day: siteDay(new Date(Date.now() + 86400e3)) });
  assert.equal((await call('PATCH', `/api/admin/invites/${later.body.id}`, { status: 'cancelled' }, admin)).status, 200);
});

test('blocked visitor: the guard is warned on lookup, check-in is refused and audited, removing the block lets them in', async () => {
  const { Audit, Invite } = require('../src/models');
  const { siteDay } = require('../src/services/core');
  const expected = await call('POST', '/api/admin/invites', { firstName: 'Bad', lastName: 'Actor', mobile: '9844455566', hostId: hostIds.rahul, day: siteDay() }, admin);
  assert.equal((await call('POST', '/api/admin/blocks', { mobile: '9844455566', name: 'Bad Actor', reason: 'x' }, admin)).status, 400, 'a reason is required');
  const blk = await call('POST', '/api/admin/blocks', { mobile: '98444 55566', name: 'Bad Actor', reason: 'Abusive to staff on 2 Oct' }, admin);
  assert.equal(blk.status, 201);
  assert.equal((await Invite.findById(expected.body.id).lean()).status, 'cancelled', 'blocking cancels their expected visits');

  const look = await call('GET', '/api/visits/lookup?mobile=9844455566', null, guard);
  assert.match(look.body.blocked.message, /Do not admit Bad Actor.*Abusive to staff/);
  const tryIn = await checkIn('Bad', hostIds.rahul, '9844455566');
  assert.equal(tryIn.status, 403);
  assert.equal(tryIn.body.code, 'blocked');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await Audit.exists({ action: 'visit.blocked_attempt' }));

  assert.equal((await call('PATCH', `/api/admin/blocks/${blk.body.id}`, { active: false }, admin)).status, 200);
  assert.equal((await checkIn('Bad', hostIds.rahul, '9844455566')).status, 201, 'unblocked');
});

test('settings: site and gate names reach sign-in and the approval page; Aadhaar retention drives the purge', async () => {
  const { Visit } = require('../src/models');
  const { purgeIdImages } = require('../src/services/worker');
  assert.equal((await call('PATCH', '/api/admin/settings', { siteName: 'Green Park Residency', gateName: 'North gate' }, guard)).status, 403);
  assert.equal((await call('PATCH', '/api/admin/settings', { idRetentionDays: 3 }, admin)).status, 400, 'only listed periods');
  const set = await call('PATCH', '/api/admin/settings', { siteName: 'Green Park Residency', gateName: 'North gate', idRetentionDays: 90 }, admin);
  assert.equal(set.status, 200);
  const me = await call('GET', '/api/auth/me', null, guard);
  assert.equal(me.body.siteName, 'Green Park Residency');
  assert.equal(me.body.gateName, 'North gate');

  const v = await checkIn('Ira', hostIds.asha, '9833344455');
  const page = await call('GET', `/api/approvals/${await tokenFor(v.body.id)}`);
  assert.equal(page.body.siteName, 'Green Park Residency');

  // 10 days old: kept under 90-day retention, deleted under 7-day retention.
  await Visit.collection.updateOne({ _id: new mongoose.Types.ObjectId(v.body.id) }, { $set: { createdAt: new Date(Date.now() - 10 * 86400e3) } });
  await purgeIdImages();
  assert.ok((await Visit.findById(v.body.id).lean()).idImagePath, 'kept for 90 days');
  await call('PATCH', '/api/admin/settings', { idRetentionDays: 7 }, admin);
  await purgeIdImages();
  const after = await Visit.findById(v.body.id).lean();
  assert.equal(after.idImagePath, undefined);
  assert.ok(after.idImagePurgedAt, 'deleted after 7 days');
});

test('Telegram buttons are retired when the guard cancels, and expiry is recorded in the timeline', async () => {
  const { Visit, ApprovalToken } = require('../src/models');
  const { processOutbox, expireStaleApprovals } = require('../src/services/worker');
  const telegram = require('../src/services/telegram');
  const hook = (body) => fetch(base + '/api/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': telegram.webhookSecret() }, body: JSON.stringify(body) });
  const link = await call('POST', `/api/admin/hosts/${hostIds.rahul}/telegram-link`, {}, admin);
  await hook({ message: { chat: { id: 7771, type: 'private' }, text: `/start ${link.body.url.split('start=')[1]}` } });

  const v = await checkIn('Omar', hostIds.rahul, '9822233344');
  await processOutbox();
  let mark = telegramCalls.length;
  await call('POST', `/api/visits/${v.body.id}/cancel`, {}, guard);
  const edit = telegramCalls.slice(mark).find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'the host message was updated');
  assert.match(edit.payload.text, /Omar Sharma: cancelled by the security desk/);
  assert.deepEqual(edit.payload.reply_markup.inline_keyboard, [], 'buttons removed');

  const w = await checkIn('Lina', hostIds.rahul, '9822233355');
  await processOutbox();
  await ApprovalToken.updateMany({ visit: w.body.id }, { expiresAt: new Date(Date.now() - 1000) });
  mark = telegramCalls.length;
  await expireStaleApprovals();
  assert.equal((await Visit.findById(w.body.id).lean()).status, 'expired');
  assert.match(telegramCalls.slice(mark).find((c) => c.method === 'editMessageText').payload.text, /no reply in time/);
  await new Promise((r) => setTimeout(r, 100));
  const tl = await call('GET', `/api/admin/visits/${w.body.id}/timeline`, null, admin);
  assert.ok(tl.body.rows.some((r) => r.action === 'visit.expired'), 'expiry shows in the visit timeline');
  await call('PATCH', `/api/admin/hosts/${hostIds.rahul}`, { disconnectTelegram: true }, admin);
});

// Runs last: it changes guard1's password, which ends the `guard` session used above.
test('anyone can change their own password; other devices are signed out, this one continues', async () => {
  const otherDevice = await login('guard1', 'guard-pass-123');
  const thisDevice = await login('guard1', 'guard-pass-123');
  assert.equal((await call('POST', '/api/auth/password', { current: 'wrong-wrong-wrong', next: 'new-guard-pass-456' }, thisDevice)).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { current: 'guard-pass-123', next: 'short' }, thisDevice)).status, 400);

  const res = await fetch(`${base}/api/auth/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: thisDevice },
    body: JSON.stringify({ current: 'guard-pass-123', next: 'new-guard-pass-456' }),
  });
  assert.equal(res.status, 200);
  const fresh = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/visits/inside', null, fresh)).status, 200);
  assert.equal((await call('GET', '/api/visits/inside', null, otherDevice)).status, 401);
});
