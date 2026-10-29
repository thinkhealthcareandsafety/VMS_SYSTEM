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
  return /approve(?:\/|\?t=|\?)([\w-]+)/.exec(sms.body)[1];
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
  assert.match(sheet.toString('utf8'), /"Checked out by admin".*"Guard forgot to mark exit"/);

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
  assert.match(names, /\/READ ME FIRST\.txt/, 'how to open it (unzip, Enable Editing) comes with it');
  // The photo links are saved as Excel saves them, spaces as %20, relative to the sheet.
  const { PassThrough } = require('node:stream');
  const sheetOut = new PassThrough();
  const chunks = [];
  sheetOut.on('data', (c) => chunks.push(c));
  async function* one() { yield { day: '2026-10-29', ref: 'V-000001', firstName: 'Kiran', lastName: 'Sharma', folder: '2026-10-29/V-000001 Kiran Sharma', hasPhoto: true, hasIdImage: false }; }
  await require('../src/services/export').writeWorkbook(sheetOut, one(), { files: { aadhaar: false }, meta: {} });
  const linked = new (require('exceljs').Workbook)();
  await linked.xlsx.load(Buffer.concat(chunks));
  const photoCol = linked.getWorksheet(1).getRow(1).values.indexOf('Photo');
  assert.equal(linked.getWorksheet(1).getRow(2).getCell(photoCol).value.hyperlink, '2026-10-29/V-000001%20Kiran%20Sharma/photo.jpg');

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
  assert.deepEqual(header.slice(0, 7), ['Visitor ID', 'Date', 'Pass no', 'Lanyard card', 'Name', 'Gender', 'Mobile (+91)']);
  const ravi = ws.getSheetValues().find((r) => r && r[5] === 'Ravi Sharma');
  assert.ok(ravi, 'a row per visit');
  assert.equal(ravi[6], 'Male');
  assert.equal(ravi[7], '98765 43210');
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
    const soon = await call('POST', '/api/visits/otp/send', { mobile }, guard);
    assert.equal(soon.status, 429, 'resend needs a short wait');
    assert.equal(soon.body.code, 'otp_recent', 'the screen opens the code boxes for the code already sent');
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

    // The check-in used the code: the next visit asks again.
    assert.equal((await call('GET', `/api/visits/lookup?mobile=${mobile}`, null, guard)).body.otp.verified, null, 'asked again on the next visit');
    // A code verified an hour ago and not yet used still counts: the guard was slow to finish the form.
    await Otp.updateMany({ mobile: '+91' + mobile }, { verifiedAt: new Date(Date.now() - 3600e3), $unset: { usedAt: 1 } });
    assert.equal((await call('GET', `/api/visits/lookup?mobile=${mobile}`, null, guard)).body.otp.verified, 'otp', 'a slow form still goes through');
    await Otp.updateMany({ mobile: '+91' + mobile }, { verifiedAt: new Date(Date.now() - 4 * 3600e3) });
    assert.equal((await call('GET', `/api/visits/lookup?mobile=${mobile}`, null, guard)).body.otp.verified, null, 'too old');
    // A site that sets OTP_VERIFIED_DAYS trusts a number verified within that many days.
    const config = require('../src/config');
    config.otp.verifiedDays = 90;
    const again = await call('GET', `/api/visits/lookup?mobile=${mobile}`, null, guard);
    config.otp.verifiedDays = 0;
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
  await purgeIdImages({ force: true });
  assert.ok((await Visit.findById(v.body.id).lean()).idImagePath, 'kept for 90 days');
  await call('PATCH', '/api/admin/settings', { idRetentionDays: 7 }, admin);
  await purgeIdImages({ force: true });
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

test('WhatsApp: request with photo and buttons goes to the chosen host; only their tap decides; undeliverable falls back', async () => {
  const http = require('node:http');
  const config = require('../src/config');
  const { Host, Outbox, Audit } = require('../src/models');
  const { processOutbox } = require('../src/services/worker');
  const calls = [];
  const fake = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/media')) { calls.push({ path: 'media', auth: req.headers.authorization }); return res.end(JSON.stringify({ id: 'media-1' })); }
        const payload = JSON.parse(raw);
        calls.push({ path: 'messages', payload });
        if (payload.to === '919000000002') { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 131030, message: 'Recipient phone number not in allowed list' } })); }
        res.end(JSON.stringify({ messages: [{ id: `wamid.out${calls.length}` }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  guard = await login('guard1', 'new-guard-pass-456'); // the password test before this one signed other sessions out
  const saved = { ...config.whatsapp };
  Object.assign(config.whatsapp, { on: true, token: 'wa-token', phoneId: 'PH1', verifyToken: 'gate-verify', apiBase: `http://127.0.0.1:${fake.address().port}/v23.0` });
  const hook = (messages, statuses) => fetch(base + '/api/whatsapp/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { ...(messages ? { messages } : {}), ...(statuses ? { statuses } : {}) } }] }] }),
  });
  const tap = (from, id) => hook([{ from, id: `wamid.in${Math.random()}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } }]);
  const replies = (since) => calls.slice(since).filter((c) => c.path === 'messages' && c.payload.type === 'text').map((c) => c.payload.text.body);
  try {
    // Meta checks the webhook address with the verify phrase.
    assert.equal(await (await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=gate-verify&hub.challenge=42`)).text(), '42');
    assert.equal((await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status, 403);

    // The host's "Hi" is answered by name.
    let mark = calls.length;
    await hook([{ from: '919000000001', id: 'wamid.hi', type: 'text', text: { body: 'Hi' } }]);
    assert.match(replies(mark)[0], /Hi Asha/);

    // 1. Check-in goes to the chosen host's WhatsApp, with the visitor's photo and two buttons.
    const v = await checkIn('Tara', hostIds.asha, '9773330001');
    assert.equal(v.status, 201);
    assert.equal(v.body.whatsapp, null, 'no manual share button when the server sends it');
    const job = await Outbox.findOne({ visit: v.body.id }).lean();
    assert.equal(job.kind, 'whatsapp');
    assert.equal(job.to, '+919000000001');
    mark = calls.length;
    await processOutbox();
    assert.equal(calls[mark].path, 'media');
    assert.equal(calls[mark].auth, 'Bearer wa-token');
    const req = calls[mark + 1].payload;
    assert.equal(req.to, '919000000001');
    assert.equal(req.interactive.header.image.id, 'media-1');
    assert.match(req.interactive.body.text, /Tara Sharma\* from Acme Ltd is at the gate/);
    const [yes, no] = req.interactive.action.buttons.map((b) => b.reply.id);
    assert.match(yes, /^a:[\w-]{20,}$/);
    assert.match(no, /^r:/);

    // 2. A tap from another number decides nothing.
    mark = calls.length;
    await tap('919111111111', yes);
    assert.match(replies(mark)[0], /not sent to you/);
    assert.equal((await call('GET', `/api/visits/${v.body.id}`, null, guard)).body.status, 'pending');

    // 3. The host's tap approves, and they are told; a second tap is told it is done.
    mark = calls.length;
    await tap('919000000001', yes);
    const after = (await call('GET', `/api/visits/${v.body.id}`, null, guard)).body;
    assert.equal(after.status, 'approved');
    assert.ok(after.dailyNumber >= 1);
    assert.match(replies(mark)[0], /You let Tara Sharma in/);
    mark = calls.length;
    await tap('919000000001', no);
    assert.match(replies(mark)[0], /already approved/);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await Audit.exists({ action: 'visit.approved', entityId: v.body.id, 'details.via': 'whatsapp' }));

    // 4. A host WhatsApp can't reach falls back to Telegram straight away when they connected it.
    await Host.updateOne({ _id: hostIds.rahul }, { mobile: '+919000000002', telegramChatId: '7771' });
    const w = await checkIn('Uma', hostIds.rahul, '9773330002');
    await processOutbox();
    const failed = await Outbox.findOne({ visit: w.body.id, kind: 'whatsapp' }).lean();
    assert.equal(failed.status, 'failed');
    assert.match(failed.lastError, /131030/);
    assert.equal((await Outbox.findOne({ visit: w.body.id, kind: 'telegram' }).lean())?.to, '7771');

    // 5. A message Meta accepted but later could not deliver (host outside the 24-hour window) is shown as failed.
    await Host.updateOne({ _id: hostIds.rahul }, { $unset: { telegramChatId: 1 } });
    const x = await checkIn('Vik', hostIds.asha, '9773330003');
    await processOutbox();
    const sent = await Outbox.findOne({ visit: x.body.id, kind: 'whatsapp' }).lean();
    assert.equal(sent.status, 'sent');
    await hook(null, [{ id: sent.providerRef, status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }]);
    assert.equal((await call('GET', `/api/visits/${x.body.id}`, null, guard)).body.smsStatus, 'failed');
  } finally {
    Object.assign(config.whatsapp, saved);
    fake.close();
  }
});

test('gates: entry at one gate and exit at another are recorded with the guard; the admin manages gates', async () => {
  const { Gate } = require('../src/models');
  await require('../src/services/passes').ensureDefaultGate();

  // Admin adds gates; names are unique (any case); guards cannot manage gates.
  const g1 = await call('POST', '/api/admin/gates', { name: 'Main Entrance' }, admin);
  const g3 = await call('POST', '/api/admin/gates', { name: 'Receiving Gate' }, admin);
  assert.equal(g1.status, 201);
  assert.equal((await call('POST', '/api/admin/gates', { name: 'main entrance' }, admin)).status, 409);
  assert.equal((await call('POST', '/api/admin/gates', { name: 'X' }, admin)).status, 400);
  assert.equal((await call('GET', '/api/admin/gates', null, guard)).status, 403);

  // One guard per gate. A gate id that does not exist is refused.
  assert.equal((await call('POST', '/api/admin/users', { username: 'g-bad', fullName: 'Bad Gate', role: 'guard', gateId: '64b000000000000000000000' }, admin)).status, 400);
  const a = await call('POST', '/api/admin/users', { username: 'gate.one', fullName: 'Arjun Gate One', role: 'guard', gateId: g1.body.id }, admin);
  const c = await call('POST', '/api/admin/users', { username: 'gate.three', fullName: 'Chetan Gate Three', role: 'guard', gateId: g3.body.id }, admin);
  assert.equal(a.body.gate.name, 'Main Entrance');
  const guardA = await login('gate.one', a.body.password);
  const guardC = await login('gate.three', c.body.password);
  assert.equal((await call('GET', '/api/auth/me', null, guardA)).body.gateName, 'Main Entrance', 'the desk shows the guard their gate');

  // In at the Main Entrance, approved by the host, out at the Receiving Gate.
  const v = await call('POST', '/api/visits', {
    firstName: 'Gita', lastName: 'Rao', gender: 'female', mobile: '9811100001', company: 'Rao Events', purpose: 'Meeting',
    hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), validity: '4h',
  }, guardA);
  assert.equal(v.status, 201);
  await call('POST', `/api/approvals/${await tokenFor(v.body.id)}/decision`, { decision: 'approve' });
  const out = await call('POST', `/api/visits/${v.body.id}/checkout`, {}, guardC);
  assert.equal(out.body.status, 'checked_out', 'a 4-hour pass closes when the visitor leaves');

  const detail = (await call('GET', `/api/visits/${v.body.id}`, null, admin)).body;
  assert.deepEqual([detail.entry.gate, detail.entry.by], ['Main Entrance', 'Arjun Gate One']);
  assert.deepEqual([detail.exit.gate, detail.exit.by], ['Receiving Gate', 'Chetan Gate Three']);
  assert.equal(detail.movements.length, 2);
  assert.equal(detail.validity, '4 hours');

  // History can be filtered by gate, and the sheet names both gates and guards.
  const atG3 = await call('GET', `/api/admin/visits?gate=${g3.body.id}`, null, admin);
  assert.ok(atG3.body.rows.some((r) => r.id === v.body.id));
  assert.ok(atG3.body.rows.every((r) => r.exit?.gate === 'Receiving Gate' || r.entry?.gate === 'Receiving Gate'));
  const csv = await (await fetch(`${base}/api/admin/visits.csv?name=Gita`, { headers: { Cookie: admin } })).text();
  assert.match(csv, /"Main Entrance","Arjun Gate One","Receiving Gate","Chetan Gate Three","1","4 hours"/);

  // Renaming a gate does not rewrite history; the last open gate cannot be closed.
  await call('PATCH', `/api/admin/gates/${g1.body.id}`, { name: 'Lobby Entrance' }, admin);
  assert.equal((await call('GET', `/api/visits/${v.body.id}`, null, admin)).body.entry.gate, 'Main Entrance');
  for (const g of await Gate.find({ active: true, _id: { $ne: g3.body.id } }).lean()) {
    assert.equal((await call('PATCH', `/api/admin/gates/${g._id}`, { active: false }, admin)).status, 200);
  }
  assert.equal((await call('PATCH', `/api/admin/gates/${g3.body.id}`, { active: false }, admin)).body.error, 'Keep at least one gate open');
  // A guard whose gate was closed works at the first open gate until moved.
  assert.equal((await call('GET', '/api/auth/me', null, guardA)).body.gateName, 'Receiving Gate');
  await Gate.updateMany({}, { active: true });
});

test('pass validity: multi-day passes let the holder out and back in at any gate until they end', async () => {
  const { Visit } = require('../src/models');
  const { closeExpiredPasses } = require('../src/services/worker');
  const add = (body) => call('POST', '/api/visits', {
    firstName: 'Kabir', lastName: 'Contractor', gender: 'male', mobile: '9811100002', company: 'BuildCo', purpose: 'Renovation',
    hostId: hostIds.rahul, photo: jpeg(), idImage: jpeg(), ...body,
  }, guard);

  // Bad choices are refused with a clear reason; past dates and dates beyond 90 days are not allowed.
  assert.equal((await add({ validity: '5y' })).status, 400);
  assert.equal((await add({ validity: 'date', validUntilDay: '2001-01-01' })).status, 400);
  assert.equal((await add({ validity: 'date', validUntilDay: '2099-01-01' })).status, 400);

  // 10 days: the host is told, approves once.
  const v = await add({ validity: '10d' });
  assert.equal(v.status, 201);
  const raw = await tokenFor(v.body.id);
  assert.equal((await call('GET', `/api/approvals/${raw}`)).body.passFor, '10 days');
  await call('POST', `/api/approvals/${raw}/decision`, { decision: 'approve' });
  const issued = (await call('GET', `/api/visits/${v.body.id}`, null, guard)).body;
  const days = (new Date(issued.validUntil) - Date.now()) / 86400e3;
  assert.ok(days > 8.9 && days < 10.01, `valid until the end of the 10th day (${days.toFixed(2)} days)`);

  // Leaving keeps the pass open; the lookup offers "let in again" instead of a new check-in.
  const out = await call('POST', `/api/visits/${v.body.id}/checkout`, {}, guard);
  assert.equal(out.body.status, 'away');
  const inside = (await call('GET', '/api/visits/inside', null, guard)).body;
  assert.ok(inside.away.some((r) => r.id === v.body.id), 'listed as a pass holder who is out');
  assert.ok(!inside.visits.some((r) => r.id === v.body.id));
  const look = (await call('GET', '/api/visits/lookup?mobile=9811100002', null, guard)).body;
  assert.equal(look.active.status, 'away');
  assert.match(look.active.message, /valid pass/);
  assert.equal((await add({ validity: '10d' })).status, 409, 'no second pass while one is valid');

  // Back in, no approval; then out again: four movements.
  const back = await call('POST', `/api/visits/${v.body.id}/reenter`, {}, guard);
  assert.equal(back.body.status, 'approved');
  assert.equal((await call('POST', `/api/visits/${v.body.id}/reenter`, {}, guard)).status, 409, 'already inside');
  await call('POST', `/api/visits/${v.body.id}/checkout`, {}, guard);
  assert.equal((await call('GET', `/api/visits/${v.body.id}`, null, admin)).body.movements.length, 4);

  // A pass holder who gets blocked cannot come back in.
  await call('POST', '/api/admin/blocks', { mobile: '9811100002', reason: 'Contract terminated' }, admin);
  const refused = await call('POST', `/api/visits/${v.body.id}/reenter`, {}, guard);
  assert.equal(refused.status, 403);
  const blocks = (await call('GET', '/api/admin/blocks', null, admin)).body.rows;
  await call('PATCH', `/api/admin/blocks/${blocks.find((b) => b.mobile.endsWith('9811100002')).id}`, { active: false }, admin);

  // Ending the pass early closes it at the last exit.
  const ended = await call('POST', `/api/visits/${v.body.id}/end-pass`, {}, guard);
  assert.equal(ended.body.status, 'checked_out');
  assert.equal((await call('POST', `/api/visits/${v.body.id}/reenter`, {}, guard)).status, 409);

  // Expiry while out: the worker closes it. Expiry while inside: flagged, never checked out by the system.
  const w = await add({ validity: '3d' });
  await call('POST', `/api/approvals/${await tokenFor(w.body.id)}/decision`, { decision: 'approve' });
  await call('POST', `/api/visits/${w.body.id}/checkout`, {}, guard);
  await Visit.updateOne({ _id: w.body.id }, { validUntil: new Date(Date.now() - 60e3) });
  await closeExpiredPasses();
  assert.equal((await Visit.findById(w.body.id).lean()).status, 'checked_out');

  const x = await call('POST', '/api/visits', {
    firstName: 'Lata', lastName: 'Late', gender: 'female', mobile: '9811100003', company: 'Vendor', hostId: hostIds.rahul,
    photo: jpeg(), idImage: jpeg(), validity: '2h',
  }, guard);
  await call('POST', `/api/approvals/${await tokenFor(x.body.id)}/decision`, { decision: 'approve' });
  await Visit.updateOne({ _id: x.body.id }, { validUntil: new Date(Date.now() - 60e3) });
  await closeExpiredPasses();
  const row = (await call('GET', '/api/visits/inside', null, guard)).body.visits.find((r) => r.id === x.body.id);
  assert.equal(row.passExpired, true);
  assert.equal(row.status, 'approved');

  // Older screens that send no validity get the default 8-hour pass.
  const y = await call('POST', '/api/visits', {
    firstName: 'Old', lastName: 'Screen', gender: 'male', mobile: '9811100004', company: 'Legacy', hostId: hostIds.rahul, photo: jpeg(), idImage: jpeg(),
  }, guard);
  assert.equal((await call('GET', `/api/visits/${y.body.id}`, null, guard)).body.validity, '8 hours');
});

test('super admin: full Aadhaar is stored encrypted, shown only to a Super Admin, audited, and deleted at retention', async () => {
  const fsp = require('node:fs');
  const { Visit, Audit } = require('../src/models');
  const { purgeIdImages } = require('../src/services/worker');
  const settingsSvc = require('../src/services/settings');

  // The first Super Admin can be made by an admin, once; after that only a Super Admin can make one.
  const users = await call('GET', '/api/admin/users', null, admin);
  assert.equal(users.body.canAppointSuper, true);
  const sa = await call('POST', '/api/admin/users', { username: 'chief', fullName: 'Chief Security', role: 'superadmin' }, admin);
  assert.equal(sa.status, 201);
  assert.equal((await call('POST', '/api/admin/users', { username: 'chief2', fullName: 'Second Chief', role: 'superadmin' }, admin)).status, 403);
  assert.equal((await call('GET', '/api/admin/users', null, admin)).body.canAppointSuper, false);
  const chief = await login('chief', sa.body.password);
  // An admin cannot change, switch off or reset a Super Admin.
  assert.equal((await call('PATCH', `/api/admin/users/${sa.body.id}`, { active: false }, admin)).status, 403);
  assert.equal((await call('PATCH', `/api/admin/users/${sa.body.id}`, { resetPassword: true }, admin)).status, 403);
  // A Super Admin does everything an admin does.
  assert.equal((await call('GET', '/api/admin/stats', null, chief)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, guard)).body.fullId, true, 'the guard screen is told to send the full card');

  // Check-in with both images: the masked one as before, the full one kept encrypted.
  const full = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('FULL AADHAAR 1234 5678 9012'), Buffer.alloc(300, 9)]);
  const fullUrl = `data:image/jpeg;base64,${full.toString('base64')}`;
  const v = await call('POST', '/api/visits', {
    firstName: 'Nisha', lastName: 'Full', gender: 'female', mobile: '9811100005', company: 'Audit Co', hostId: hostIds.asha,
    photo: jpeg(), idImage: jpeg(), idImageFull: fullUrl,
  }, guard);
  assert.equal(v.status, 201);
  const doc = await Visit.findById(v.body.id).lean();
  assert.ok(doc.idFullPath);
  const onDisk = fsp.readFileSync(doc.idFullPath);
  assert.notEqual(onDisk[0], 0xff, 'not a readable JPEG on disk');
  assert.ok(!onDisk.includes(Buffer.from('1234 5678 9012')), 'the number is not in the file');

  // Only the Super Admin can open it; admins and guards cannot; each view is audited.
  assert.equal((await call('GET', `/api/visits/${v.body.id}`, null, admin)).body.hasFullId, true);
  assert.equal((await fetch(`${base}/api/visits/${v.body.id}/id-image-full`, { headers: { Cookie: admin } })).status, 403);
  assert.equal((await fetch(`${base}/api/visits/${v.body.id}/id-image-full`, { headers: { Cookie: guard } })).status, 403);
  const res = await fetch(`${base}/api/visits/${v.body.id}/id-image-full`, { headers: { Cookie: chief } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(full), 'the Super Admin sees exactly the card that was captured');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await Audit.exists({ action: 'id_image_full.viewed', entityId: v.body.id, actor: 'chief' }));

  // Only the Super Admin can switch capture off; then the full card is not kept.
  assert.equal((await call('PATCH', '/api/admin/settings', { fullIdCapture: false }, admin)).status, 403);
  assert.equal((await call('PATCH', '/api/admin/settings', { fullIdCapture: false }, chief)).status, 200);
  const w = await call('POST', '/api/visits', {
    firstName: 'Omkar', lastName: 'Off', gender: 'male', mobile: '9811100006', company: 'Audit Co', hostId: hostIds.asha,
    photo: jpeg(), idImage: jpeg(), idImageFull: fullUrl,
  }, guard);
  assert.equal((await Visit.findById(w.body.id).lean()).idFullPath, undefined);
  await call('PATCH', '/api/admin/settings', { fullIdCapture: true }, chief);

  // Retention deletes the full card with the masked one.
  await Visit.collection.updateOne({ _id: new mongoose.Types.ObjectId(v.body.id) }, { $set: { createdAt: new Date(Date.now() - 400 * 86400e3) } });
  await purgeIdImages({ force: true });
  assert.equal(fsp.existsSync(doc.idFullPath), false);
  assert.equal((await Visit.findById(v.body.id).lean()).idFullPath, undefined);
  assert.equal((await fetch(`${base}/api/visits/${v.body.id}/id-image-full`, { headers: { Cookie: chief } })).status, 404);
  assert.ok(settingsSvc);
});

test('groups: an Excel guest list, passes scanned at any gate, one tap per guest, walk-ins and check-out-all', async () => {
  const ExcelJS = require('exceljs');
  const { Visit, Guest } = require('../src/models');
  const { siteDay } = require('../src/services/core');
  const { addDays } = require('../src/services/passes');
  const today = siteDay();

  // Creating: a host is required, dates must make sense.
  const make = (body) => call('POST', '/api/groups', { name: 'Sharma Wedding, Grand Ballroom', hostId: hostIds.asha, startDay: today, endDay: today, purpose: 'Wedding', ...body }, admin);
  assert.equal((await make({ hostId: undefined })).status, 400);
  assert.equal((await make({ endDay: addDays(today, -1) })).status, 400);
  assert.equal((await make({ startDay: '2001-01-01', endDay: '2001-01-02' })).status, 400);
  assert.equal((await call('POST', '/api/groups', { name: 'x' }, guard)).status, 403);
  const grp = await make({});
  assert.equal(grp.status, 201);
  const gid = grp.body.id;

  // An Excel sheet with its own headings, a bad number, a duplicate, a blocked person and an empty row.
  await call('POST', '/api/admin/blocks', { mobile: '9822200009', reason: 'Banned' }, admin);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('List');
  ws.addRow(['Sr', 'Guest Name', 'Phone No', 'Side']);
  ws.addRow([1, 'ravi kumar', '98222 00001', 'Groom']);
  ws.addRow([2, 'Anita Desai', '+91 9822200002', 'Bride']);
  ws.addRow([3, 'Bad Number', '12345', 'Bride']);
  ws.addRow([4, 'Ravi Again', '9822200001', 'Groom']);
  ws.addRow([5, 'Banned Person', '9822200009', '']);
  ws.addRow([6, 'Meena', '', 'Family']);
  const file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  const up = await call('POST', `/api/groups/${gid}/guests`, { file, filename: 'guests.xlsx' }, admin);
  assert.equal(up.status, 200);
  assert.equal(up.body.added, 4, 'Ravi, Anita, Bad Number (without mobile), Meena');
  assert.deepEqual(up.body.skipped.map((s) => s.reason).sort(), ['Already on the list (same mobile)', 'On the blocked list']);
  assert.match(up.body.warnings[0].reason, /not a valid number/);
  // Text pasted from Excel (tabs) or CSV with quotes works too.
  const pasted = await call('POST', `/api/groups/${gid}/guests`, { text: 'Name,Mobile,Company\n"Raj Kapoor",9822200003,"Acme, Ltd"\nSonia Gill\t9822200004\tX' }, admin);
  assert.equal(pasted.body.added, 2);

  // The gate sees today's groups and counts; only the last 4 digits of numbers; no pass codes.
  const todays = (await call('GET', '/api/groups?scope=today', null, guard)).body.rows;
  assert.equal(todays.find((r) => r.id === gid).guests, 6);
  assert.equal((await call('GET', '/api/groups', null, guard)).status, 403, 'all groups is for admins');
  const found = (await call('GET', `/api/groups/${gid}/guests?q=0002`, null, guard)).body.rows;
  assert.equal(found.length, 1);
  assert.equal(found[0].firstName, 'Anita');
  assert.equal(found[0].mobileEnd, '0002');
  assert.equal(found[0].mobile, undefined);
  assert.equal(found[0].code, undefined);

  // Scanning a pass: the link from the QR, or the code typed any way.
  const list = (await call('GET', `/api/groups/${gid}/guests`, null, admin)).body.rows;
  const ravi = list.find((r) => r.firstName === 'Ravi');
  assert.equal(ravi.lastName, 'Kumar', 'lowercase names are tidied');
  const scan = (code, who = guard) => call('POST', '/api/groups/scan', { code }, who);
  const first = await scan(ravi.link);
  assert.equal(first.body.result, 'let_in');
  assert.ok(first.body.visit.dailyNumber >= 1);
  assert.equal((await scan(ravi.code.toLowerCase())).body.result, 'inside');
  assert.equal((await scan('NOT-A-PASS')).status, 400);
  assert.equal((await scan('ABCD-EFGH')).status, 404);
  const rv = await Visit.findById(first.body.visit.id).lean();
  assert.equal(rv.status, 'approved');
  assert.equal(String(rv.group), gid);
  assert.equal(rv.movements[0].kind, 'in');

  // Two gates scanning the same pass at the same moment: one visit, not two.
  const anita = list.find((r) => r.firstName === 'Anita');
  const both = await Promise.all([scan(anita.code), scan(anita.code)]);
  assert.deepEqual(both.map((r) => r.body.result).sort(), ['inside', 'let_in']);
  const anitaGuest = await Guest.findById(anita.id).lean();
  assert.equal(await Visit.countDocuments({ guest: anitaGuest._id }), 1);

  // Several at once by tapping their names.
  const rest = list.filter((r) => ['Meena', 'Raj'].includes(r.firstName)).map((r) => r.id);
  const many = await call('POST', `/api/groups/${gid}/admit-many`, { ids: rest }, guard);
  assert.equal(many.body.letIn, 2);

  // The gate's inside list sums group guests up; the admin's full list names everyone.
  const gateView = (await call('GET', '/api/visits/inside', null, guard)).body;
  assert.ok(!gateView.visits.some((v) => v.groupId === gid));
  assert.equal(gateView.groups.find((g) => g.id === gid).inside, 4);
  const adminView = (await call('GET', '/api/visits/inside?all=1', null, admin)).body;
  assert.equal(adminView.visits.filter((v) => v.groupId === gid).length, 4);

  // Walk-ins only when the admin allows them.
  assert.equal((await call('POST', `/api/groups/${gid}/walk-in`, { name: 'Uninvited Uncle' }, guard)).status, 403);
  await call('PATCH', `/api/groups/${gid}`, { allowWalkIns: true }, admin);
  const walk = await call('POST', `/api/groups/${gid}/walk-in`, { name: 'Invited Uncle', mobile: '9822200005' }, guard);
  assert.equal(walk.status, 201);
  assert.equal(walk.body.result, 'let_in');

  // The guest's own pass page, without a login.
  const page = await call('GET', `/api/passes/${ravi.code}`);
  assert.equal(page.body.name, 'Ravi Kumar');
  assert.equal(page.body.state, 'valid');
  assert.equal((await call('GET', '/api/passes/ABCDEFGH')).status, 404);

  // A guest taken off the list, a cancelled event, an event on another day: all refused, plainly.
  const sonia = list.find((r) => r.firstName === 'Sonia');
  await call('PATCH', `/api/groups/${gid}/guests/${sonia.id}`, { remove: true }, admin);
  assert.equal((await scan(sonia.code)).body.result, 'removed');
  const later = await make({ name: 'Conference next week', startDay: addDays(today, 7), endDay: addDays(today, 8) });
  await call('POST', `/api/groups/${later.body.id}/guests`, { text: 'Name,Mobile\nEarly Bird,9822200006' }, admin);
  const early = (await call('GET', `/api/groups/${later.body.id}/guests`, null, admin)).body.rows[0];
  const tooEarly = await scan(early.code);
  assert.equal(tooEarly.body.result, 'not_today');
  assert.equal(tooEarly.body.ok, false);
  await call('PATCH', `/api/groups/${later.body.id}`, { status: 'cancelled' }, admin);
  assert.equal((await scan(early.code)).body.result, 'cancelled');

  // A three-day conference: out and back in on the same pass.
  const conf = await make({ name: 'Tech Summit', startDay: today, endDay: addDays(today, 2) });
  await call('POST', `/api/groups/${conf.body.id}/guests`, { text: 'Name,Mobile\nDelegate One,9822200007' }, admin);
  const del = (await call('GET', `/api/groups/${conf.body.id}/guests`, null, admin)).body.rows[0];
  const inDel = await scan(del.code);
  assert.equal((await call('POST', `/api/visits/${inDel.body.visit.id}/checkout`, {}, guard)).body.status, 'away');
  assert.equal((await scan(del.code)).body.result, 'reentered');

  // The list with pass links, in Excel.
  const xl = await fetch(`${base}/api/groups/${gid}/guests.xlsx`, { headers: { Cookie: admin } });
  assert.equal(xl.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await xl.arrayBuffer()));
  const sheet = book.getWorksheet('Guests');
  assert.equal(sheet.getRow(1).getCell(5).text, 'Pass link');
  assert.match(sheet.getRow(2).getCell(5).text, /\/g\/[A-Z0-9]{8}$/);

  // End of the event: everyone still inside is checked out, with an exit recorded.
  const done = await call('POST', `/api/groups/${gid}/checkout-all`, {}, admin);
  assert.equal(done.body.checkedOut, 5);
  assert.equal(await Visit.countDocuments({ group: gid, status: 'approved' }), 0);
  const last = await Visit.findById(first.body.visit.id).lean();
  assert.equal(last.movements.at(-1).kind, 'out');
  const counts = (await call('GET', `/api/groups/${gid}`, null, admin)).body;
  assert.deepEqual([counts.guests, counts.arrived, counts.inside], [6, 5, 0]);
});

test('group link: guests add themselves up to a limit, safely; an ended event signs its guests out', async () => {
  const { Visit, Group } = require('../src/models');
  const { closeEndedGroups } = require('../src/services/worker');
  const { siteDay } = require('../src/services/core');
  const today = siteDay();
  const grp = await call('POST', '/api/groups', { name: 'Gupta Reception', hostId: hostIds.rahul, startDay: today, endDay: today }, admin);
  const gid = grp.body.id;

  // Opening the link needs a limit; the link is only shown to admins.
  assert.equal((await call('PATCH', `/api/groups/${gid}`, { joinOpen: true }, admin)).status, 400);
  const opened = await call('PATCH', `/api/groups/${gid}`, { joinOpen: true, joinLimit: 3 }, admin);
  assert.equal(opened.body.joinOpen, true);
  const code = opened.body.joinLink.split('/join/')[1];
  assert.match(code, /^[A-Z0-9]{10}$/);
  assert.equal((await call('GET', `/api/groups/${gid}`, null, guard)).body.joinLink, undefined);

  const join = (body) => call('POST', `/api/passes/join/${code}`, body);
  assert.equal((await call('GET', `/api/passes/join/${code}`)).body.state, 'open');
  assert.equal((await join({ name: 'X', mobile: '9833300001' })).status, 400, 'a real name');
  assert.equal((await join({ name: 'Neha Gupta', mobile: '123' })).status, 400, 'a real number');
  const neha = await join({ name: 'Neha Gupta', mobile: '9833300001' });
  assert.equal(neha.status, 201);
  // The pass works at the gate like any other.
  assert.equal((await call('POST', '/api/groups/scan', { code: neha.body.code }, guard)).body.result, 'let_in');
  // Someone else typing Neha's number does not get her pass.
  const copy = await join({ name: 'Imposter', mobile: '9833300001' });
  assert.equal(copy.status, 409);
  assert.equal(copy.body.code, undefined);
  // A blocked number is refused without saying why.
  await call('POST', '/api/admin/blocks', { mobile: '9833300009', reason: 'Trespass' }, admin);
  const refused = await join({ name: 'Blocked Person', mobile: '9833300009' });
  assert.equal(refused.status, 403);
  assert.doesNotMatch(refused.body.error, /block/i);

  // Many at once never go past the limit (2 places left, 6 people try together).
  const burst = await Promise.all([2, 3, 4, 5, 6, 7].map((n) => join({ name: `Cousin ${'ABCDEF'[n - 2]}`, mobile: `983330001${n}` })));
  assert.equal(burst.filter((r) => r.status === 201).length, 2);
  assert.equal((await call('GET', `/api/passes/join/${code}`)).body.state, 'full');
  assert.equal((await Group.findById(gid).lean()).joinCount, 3);
  const listed = (await call('GET', `/api/groups/${gid}`, null, admin)).body;
  assert.equal(listed.joined, 3);

  // A new link stops the old one at once.
  const fresh = await call('PATCH', `/api/groups/${gid}`, { newJoinLink: true }, admin);
  assert.notEqual(fresh.body.joinLink.split('/join/')[1], code);
  assert.equal((await call('GET', `/api/passes/join/${code}`)).status, 404);

  // The event ends with guests still inside: they are signed out automatically, with the reason recorded.
  await Visit.updateMany({ group: gid, status: 'approved' }, { validUntil: new Date(Date.now() - 60e3) });
  await closeEndedGroups();
  const v = await Visit.findOne({ group: gid }).lean();
  assert.equal(v.status, 'checked_out');
  assert.equal(v.movements.at(-1).gateName, 'Automatic: event ended');
  // Ordinary visitors are never signed out by the system.
  const lone = await Visit.findOne({ group: { $exists: false }, status: 'approved' }).lean();
  if (lone) {
    await Visit.updateOne({ _id: lone._id }, { validUntil: new Date(Date.now() - 60e3) });
    await closeEndedGroups();
    assert.equal((await Visit.findById(lone._id).lean()).status, 'approved');
  }
});

test('material: gate passes approved by the head (older API); the inward register with invoice photos and the vendor checkout', async () => {
  const ExcelJS = require('exceljs');
  const { Material, Outbox, Audit, ActionToken } = require('../src/models');
  const config = require('../src/config');
  const { siteDay } = require('../src/services/core');
  const { addDays } = require('../src/services/passes');
  const today = siteDay();
  const out = (body, who = guard) => call('POST', '/api/material', {
    direction: 'out', kind: 'returnable', approverId: hostIds.asha, returnBy: addDays(today, 7), department: 'Engineering', purpose: 'Repair',
    party: { name: 'Ramesh', company: 'Cool Air Services' }, vehicle: { number: 'mh 12 ab 1234', driver: 'Suresh' }, docs: { dc: 'DC-77' },
    items: [{ name: 'Split AC compressor', qty: 2, unit: 'nos', serial: 'CMP-1, CMP-2' }, { name: 'Copper pipe', qty: 10, unit: 'metre' }],
    ...body,
  }, who);

  // Clear reasons for bad requests.
  assert.equal((await out({ items: [] })).status, 400);
  assert.equal((await out({ items: [{ name: 'Thing', qty: 0 }] })).status, 400);
  assert.equal((await out({ approverId: undefined })).status, 400);
  assert.equal((await out({ returnBy: '2001-01-01' })).status, 400);
  assert.equal((await out({ party: {} })).status, 400);
  assert.equal((await out({ kind: 'delivery' })).status, 400);

  // A returnable pass waits for the head; the gate cannot let it out yet.
  const p = await out({});
  assert.equal(p.status, 201);
  assert.match(p.body.number, /^OUT-\d{6}$/);
  assert.equal(p.body.status, 'pending');
  assert.equal(p.body.vehicle.number, 'MH 12 AB 1234');
  assert.equal(p.body.approvalSentBy, null, 'no WhatsApp or Telegram in this test: an admin decides');
  assert.match((await call('POST', `/api/material/${p.body.id}/let-out`, {}, guard)).body.error, /waiting for approval/);

  // The head approves from the link (as WhatsApp or Telegram would send it).
  const raw = 'test-token-material-0001-abcdef';
  await ActionToken.create({ kind: 'material', ref: p.body.id, tokenHash: require('../src/services/core').sha256(raw), expiresAt: new Date(Date.now() + 3600e3) });
  const seen = await call('GET', `/api/material-approvals/${raw}`);
  assert.equal(seen.body.state, 'pending');
  assert.equal(seen.body.items.length, 2);
  assert.equal((await call('POST', `/api/material-approvals/${raw}/decision`, { decision: 'approve' })).status, 200);
  assert.equal((await call('POST', `/api/material-approvals/${raw}/decision`, { decision: 'reject' })).status, 409, 'decided once');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await Audit.exists({ action: 'material.approved', entityId: p.body.id }));

  // Out through the gate, recorded with gate and guard.
  const gone = await call('POST', `/api/material/${p.body.id}/let-out`, {}, guard);
  assert.equal(gone.body.status, 'out');
  assert.equal(gone.body.out.by, 'Gate Guard');
  assert.equal((await call('POST', `/api/material/${p.body.id}/let-out`, {}, guard)).status, 409, 'only once');

  // Comes back in parts; never more than went out.
  const [comp, pipe] = gone.body.items;
  assert.match((await call('POST', `/api/material/${p.body.id}/return`, { items: [{ item: comp.id, qty: 3 }] }, guard)).body.error, /only 2 nos still out/);
  assert.equal((await call('POST', `/api/material/${p.body.id}/return`, { items: [] }, guard)).status, 400);
  const part = await call('POST', `/api/material/${p.body.id}/return`, { items: [{ item: comp.id, qty: 1 }, { item: pipe.id, qty: 10 }] }, guard);
  assert.equal(part.body.status, 'partly_returned');
  assert.deepEqual(part.body.items.map((i) => i.returnedQty), [1, 10]);

  // Overdue once the date has passed: in the register and its count.
  await Material.updateOne({ _id: p.body.id }, { returnBy: addDays(today, -1) });
  const reg = (await call('GET', '/api/material?view=overdue', null, guard)).body;
  assert.ok(reg.rows.some((r) => r.id === p.body.id && r.overdue));
  assert.equal(reg.counts.overdue, 1);
  const done = await call('POST', `/api/material/${p.body.id}/return`, { items: [{ item: comp.id, qty: 1 }] }, guard);
  assert.equal(done.body.status, 'returned');
  assert.equal(done.body.overdue, false);
  assert.equal(done.body.movements.filter((m) => m.kind === 'in').length, 2);

  // Non-returnable: an admin may approve at once; nothing can be "returned" on it; a declined pass never leaves.
  const scrap = await out({ kind: 'non_returnable', returnBy: undefined, purpose: 'Scrap sale', items: [{ name: 'Old mattresses', qty: 12, unit: 'nos' }], approveNow: true }, admin);
  assert.equal(scrap.body.status, 'approved');
  assert.equal((await out({ kind: 'non_returnable', returnBy: undefined, approveNow: true }, guard)).body.status, 'pending', 'a guard cannot approve');
  await call('POST', `/api/material/${scrap.body.id}/let-out`, {}, guard);
  assert.match((await call('POST', `/api/material/${scrap.body.id}/return`, { items: [{ item: scrap.body.items[0].id, qty: 1 }] }, guard)).body.error, /Only a returnable/);
  const declined = await out({});
  assert.equal((await call('POST', `/api/material/${declined.body.id}/decision`, { decision: 'reject', note: 'Use the vendor pickup' }, admin)).status, 200);
  assert.match((await call('POST', `/api/material/${declined.body.id}/let-out`, {}, guard)).body.error, /declined/);
  assert.equal((await call('POST', `/api/material/${declined.body.id}/decision`, { decision: 'approve' }, guard)).status, 403);

  // The head taps Approve on WhatsApp: only from their own number.
  const saved = { ...config.whatsapp };
  Object.assign(config.whatsapp, { on: true, token: 'wa', phoneId: 'PH', apiBase: 'http://127.0.0.1:9/none' });
  try {
    const viaWa = await out({});
    assert.equal(viaWa.body.approvalSentBy, 'whatsapp');
    const job = await Outbox.findOne({ material: viaWa.body.id }).lean();
    assert.equal(job.vars.prefix, 'm');
    const tok = /approve-material\/([\w-]+)/.exec(job.body)[1];
    const tap = (from, id) => fetch(`${base}/api/whatsapp/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, id: `w${Math.random()}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id } } }] } }] }] }),
    });
    await tap('919111111111', `ma:${tok}`);
    assert.equal((await Material.findById(viaWa.body.id).lean()).status, 'pending', 'a stranger cannot approve');
    await tap('919000000001', `ma:${tok}`);
    assert.equal((await Material.findById(viaWa.body.id).lean()).status, 'approved');
  } finally { Object.assign(config.whatsapp, saved); }

  // Inward: a delivery comes in with its invoice photographed and the supplier's details.
  const inward = (body) => call('POST', '/api/material', {
    direction: 'in', party: { company: 'Fresh Farms', name: 'Ramu', address: 'Azadpur Mandi, Delhi 110033', mobile: '9811100011', gstin: '07aabcu 9603r1zm' },
    department: 'Kitchen', docs: { invoice: 'INV-9' }, vehicle: { number: 'dl 1l ab 1234' },
    items: [{ code: 'V-01', name: 'Vegetables', qty: 100, unit: 'kg' }, { name: 'Eggs', qty: 30, unit: 'nos' }], photos: [jpeg()], docPhotos: [jpeg(), jpeg()], personPhoto: jpeg(),
    ...body,
  }, guard);
  assert.match((await inward({ party: { company: 'X', gstin: 'NOT-A-GSTIN' } })).body.error, /GSTIN/);
  const dl = await inward({});
  assert.equal(dl.status, 201, JSON.stringify(dl.body));
  assert.match(dl.body.number, /^IN-\d{6}$/);
  assert.equal(dl.body.kind, 'delivery', 'inward is a delivery unless said otherwise');
  assert.equal(dl.body.status, 'received');
  assert.equal(dl.body.party.gstin, '07AABCU9603R1ZM');
  assert.equal(dl.body.party.address, 'Azadpur Mandi, Delhi 110033');
  assert.equal(dl.body.items[0].code, 'V-01');
  assert.equal(dl.body.photos.length, 1);
  assert.equal(dl.body.docPhotos.length, 2);
  assert.equal((await fetch(`${base}${dl.body.docPhotos[1]}`, { headers: { Cookie: guard } })).status, 200);
  assert.ok((await call('GET', '/api/material?view=atgate', null, guard)).body.rows.some((r) => r.id === dl.body.id), 'vendor inside until checked out');

  // The vendor leaves: who received it signs on the tablet, and what the hotel kept; the rest went back.
  const [veg] = dl.body.items;
  const checkout = (body) => call('POST', `/api/material/${dl.body.id}/checkout`, { receivedBy: { department: 'Kitchen', name: 'Chef Arjun' }, items: [{ item: veg.id, accepted: 50 }], signature: jpeg(), note: 'Half the vegetables not fresh', ...body }, guard);
  assert.match((await checkout({ receivedBy: {} })).body.error, /Who received/);
  assert.match((await checkout({ items: [{ item: veg.id, accepted: 101 }] })).body.error, /only 100 kg came in/);
  assert.match((await checkout({ signature: undefined })).body.error, /sign on the tablet/);
  const left = await checkout({});
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.status, 'checked_out');
  assert.equal(left.body.takenBack, true);
  assert.deepEqual(left.body.items.map((i) => i.acceptedQty), [50, 30], 'an item not listed was kept in full');
  assert.match(left.body.signature, /\/signature\/0$/);
  assert.equal((await fetch(base + left.body.signature, { headers: { Cookie: guard } })).status, 200, 'the signature can be seen');
  assert.equal(left.body.receivedBy.name, 'Chef Arjun');
  assert.equal(left.body.out.by, 'Gate Guard');
  assert.equal((await checkout({})).status, 409, 'only once');
  assert.ok((await call('GET', '/api/material?view=short', null, guard)).body.rows.some((r) => r.id === dl.body.id));

  // No invoice or challan: the supplier typed by hand, and listed apart for the admin.
  const manual = await inward({ party: { company: 'Local Carpenter', name: 'Mohan', address: 'Saket, Delhi', mobile: '9811100012' }, docs: {}, docPhotos: [] });
  assert.equal(manual.status, 201);
  const nodocs = (await call('GET', '/api/material?view=nodocs', null, admin)).body.rows;
  assert.ok(nodocs.some((r) => r.id === manual.body.id) && !nodocs.some((r) => r.id === dl.body.id));
  const tools = await call('POST', '/api/material', { direction: 'in', kind: 'returnable_in', party: { name: 'Vikas', company: 'BuildCo' }, items: [{ name: 'Drill machine', qty: 1, serial: 'DR-55' }] }, guard);
  assert.equal((await call('GET', '/api/material?view=inside', null, guard)).body.counts.inside, 1);
  assert.equal((await call('POST', `/api/material/${tools.body.id}/let-out`, {}, guard)).body.status, 'closed');

  // Search and the Excel register (one row per item).
  const found = (await call('GET', '/api/material?q=CMP-2', null, guard)).body.rows;
  assert.ok(found.some((r) => r.id === p.body.id), 'search finds a pass by serial number');
  assert.ok((await call('GET', '/api/material?q=07AABCU', null, guard)).body.rows.some((r) => r.id === dl.body.id), 'and an entry by GSTIN');
  const xl = await fetch(`${base}/api/material/export.xlsx`, { headers: { Cookie: admin } });
  assert.equal(xl.status, 200);
  assert.equal((await fetch(`${base}/api/material/export.xlsx`, { headers: { Cookie: guard } })).status, 403);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await xl.arrayBuffer()));
  const ws = book.getWorksheet('Material inward');
  const lines = [];
  ws.eachRow((r, i) => { if (i > 1) lines.push({ item: r.getCell(12).text, accepted: r.getCell(15).text, back: r.getCell(16).text }); });
  assert.ok(lines.some((l) => l.item === 'Vegetables' && l.accepted === '50' && l.back === '50'));
  assert.ok(!lines.some((l) => l.item === 'Split AC compressor'), 'the inward register only');
});

test('couriers: logged with photos, the recipient accepts or declines, handed over against name, number and photo; outgoing per the hotel register', async () => {
  const ExcelJS = require('exceljs');
  const { Parcel, Outbox, Audit } = require('../src/models');
  const config = require('../src/config');
  const { remind } = require('../src/services/parcels');
  const arrive = (body, who = guard) => call('POST', '/api/parcels', { direction: 'in', carrier: 'Blue Dart', pieces: 1, ...body }, who);
  const tokenOf = async (id) => /\/parcel\/([\w-]+)/.exec((await Outbox.findOne({ parcel: id, kind: 'whatsapp', 'vars.prefix': 'p' }).sort({ _id: -1 }).lean()).body)[1];
  const tap = (from, id) => fetch(`${base}/api/whatsapp/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, id: `w${Math.random()}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id } } }] } }] }] }),
  });
  const saved = { ...config.whatsapp };
  Object.assign(config.whatsapp, { on: true, token: 'wa', phoneId: 'PH', apiBase: 'http://127.0.0.1:9/none' });
  try {
    // Clear reasons.
    assert.equal((await arrive({ carrier: '', hostId: hostIds.asha })).status, 400, 'which courier');
    assert.equal((await arrive({})).status, 400, 'for whom');
    assert.equal((await arrive({ hostId: hostIds.asha, pieces: 0 })).status, 400);

    // For a host: logged with photos, gate and guard; the recipient gets the photo with Accept / Decline. No pickup code.
    const p = await arrive({ hostId: hostIds.asha, awb: 'bd 1234 5678', type: 'document', sender: { company: 'HDFC Bank' }, photos: [jpeg(), jpeg(), jpeg()] });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.match(p.body.number, /^PCL-\d{6}$/);
    assert.equal(p.body.awb, 'BD12345678');
    assert.equal(p.body.notifiedVia, 'whatsapp');
    assert.equal(p.body.photos.length, 3);
    assert.equal(p.body.response, null);
    assert.equal(p.body.hasCode, undefined);
    assert.equal(p.body.movements[0].by, 'Gate Guard');
    const job = await Outbox.findOne({ parcel: p.body.id }).lean();
    assert.equal(job.vars.prefix, 'p');
    assert.equal(job.to, '+919000000001');
    assert.doesNotMatch(job.body, /code/i);
    const tok = await tokenOf(p.body.id);

    // The recipient's page: the details and the photos the guard took, without a login.
    const page = await call('GET', `/api/parcel-responses/${tok}`);
    assert.equal(page.body.state, 'pending');
    assert.equal(page.body.photos.length, 3);
    assert.equal((await fetch(`${base}${page.body.photos[0]}`)).status, 200);
    assert.equal((await call('GET', '/api/parcel-responses/not-a-real-token-at-all-xyz')).status, 404);

    // Only the recipient's own number answers, once.
    await tap('919111111111', `pa:${tok}`);
    assert.equal((await Parcel.findById(p.body.id).lean()).response, undefined, 'a stranger cannot accept');
    await tap('919000000001', `pa:${tok}`);
    const accepted = (await call('GET', `/api/parcels/${p.body.id}`, null, guard)).body;
    assert.equal(accepted.response.kind, 'accepted');
    assert.equal(accepted.response.via, 'whatsapp');
    assert.equal((await call('POST', `/api/parcel-responses/${tok}/decision`, { decision: 'decline' })).body.state, 'accepted', 'answered once');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await Audit.exists({ action: 'parcel.accepted', entityId: p.body.id }));

    // The same AWB scanned again while it waits is caught.
    assert.equal((await arrive({ hostId: hostIds.asha, awb: 'BD12345678' })).body.code, 'duplicate_awb');

    // Handover: the collector's name, mobile and a photo; then the recipient is told who took it.
    const collect = (body) => call('POST', `/api/parcels/${p.body.id}/collect`, { collector: 'Ravi (assistant)', mobile: '9811122200', signature: jpeg(), ...body }, guard);
    assert.equal((await collect({ collector: '' })).status, 400, 'name needed');
    assert.match((await collect({ mobile: '' })).body.error, /mobile/);
    assert.match((await collect({ signature: undefined })).body.error, /sign/);
    const ok = await collect({});
    assert.equal(ok.body.status, 'collected');
    assert.equal(ok.body.handover.how, 'handover');
    assert.equal(ok.body.handover.mobile, '+919811122200');
    assert.equal(ok.body.handover.by, 'Gate Guard');
    assert.ok(ok.body.signature, 'the signature is kept');
    assert.equal(ok.body.acknowledgedVia, 'whatsapp');
    assert.ok(ok.body.ackSentAt);
    const ack = await Outbox.findOne({ parcel: p.body.id, 'vars.plain': true }).lean();
    assert.match(ack.body, /handed over to Ravi \(assistant\) \(\+919811122200\)/);
    assert.equal((await collect({})).status, 409);

    // Declined: listed for the gate, and returned to the courier with that as the reason.
    const d = await arrive({ hostId: hostIds.asha, awb: 'DLV-1', photos: [jpeg()] });
    assert.equal((await call('POST', `/api/parcel-responses/${await tokenOf(d.body.id)}/decision`, { decision: 'decline' })).status, 200);
    const declined = (await call('GET', '/api/parcels?view=declined', null, guard)).body;
    assert.ok(declined.rows.some((x) => x.id === d.body.id) && declined.counts.declined >= 1);
    const back = await call('POST', `/api/parcels/${d.body.id}/return`, {}, guard);
    assert.equal(back.body.status, 'returned');
    assert.match(back.body.handover.reason, /Declined by Asha Verma/);

    // Reminders at 24 h and 72 h (the request again while unanswered), then no more.
    const r = await arrive({ hostId: hostIds.asha, awb: 'REM-1' });
    await Parcel.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(r.body.id) }, { $set: { createdAt: new Date(Date.now() - 80 * 3600e3) } });
    await remind();
    await remind();
    await remind();
    assert.equal((await Parcel.findById(r.body.id).lean()).reminders, 2);
    assert.equal(await Outbox.countDocuments({ parcel: r.body.id }), 3, 'the request and two reminders');
    // Waiting three days: flagged as ageing.
    const aging = (await call('GET', '/api/parcels?view=aging', null, guard)).body;
    assert.ok(aging.rows.some((x) => x.id === r.body.id && x.aging));
    assert.ok(aging.counts.aging >= 1);
  } finally { Object.assign(config.whatsapp, saved); }

  // For a hotel guest (not a host): nobody to ask; handed to the front desk by name.
  const g = await arrive({ person: { name: 'Mr. J. Smith', room: '1204' }, carrier: 'DHL', awb: 'DHL998' });
  assert.equal(g.body.notifiedVia, null);
  assert.equal((await call('POST', `/api/parcels/${g.body.id}/forward`, { to: '' }, guard)).status, 400);
  assert.equal((await call('POST', `/api/parcels/${g.body.id}/forward`, { to: 'Front desk, Priya' }, guard)).body.status, 'forwarded');

  // Refused: back with the courier, with a reason.
  const ret = await arrive({ person: { name: 'Unknown Person' }, carrier: 'DTDC' });
  assert.equal((await call('POST', `/api/parcels/${ret.body.id}/return`, { reason: '' }, guard)).status, 400);
  assert.equal((await call('POST', `/api/parcels/${ret.body.id}/return`, { reason: 'No such person at the hotel' }, guard)).body.status, 'returned');

  // Outgoing, per the hotel's register: name on the courier, address, sender and department; the picker's name,
  // mobile, the AWB they issue and a photo when they take it.
  const send = (body) => call('POST', '/api/parcels', { direction: 'out', hostId: hostIds.rahul, department: 'Accounts', addressee: 'Mr. K. Mehta', address: 'Head Office, BKC, Mumbai', type: 'document', photos: [jpeg()], ...body }, guard);
  assert.match((await send({ addressee: '' })).body.error, /name on the courier/);
  const out = await send({});
  assert.equal(out.body.status, 'booked');
  assert.equal(out.body.addressee, 'Mr. K. Mehta');
  const dispatch = (body) => call('POST', `/api/parcels/${out.body.id}/dispatch`, { agent: 'Raju', mobile: '9811100022', carrier: 'Blue Dart', awb: 'bd 777', photos: [jpeg()], ...body }, guard);
  assert.equal((await dispatch({ agent: '' })).status, 400);
  assert.match((await dispatch({ awb: '' })).body.error, /tracking/);
  const sent = await dispatch({});
  assert.equal(sent.body.status, 'dispatched');
  assert.equal(sent.body.awb, 'BD777');
  assert.equal(sent.body.handover.mobile, '+919811100022');
  assert.equal(sent.body.handoverPhotos.length, 1);

  // Logged by mistake: only an admin voids it, with a reason; it stays on record.
  const oops = await arrive({ person: { name: 'Typo' }, carrier: 'Amazon' });
  assert.equal((await call('POST', `/api/parcels/${oops.body.id}/void`, { reason: 'Entered twice' }, guard)).status, 403);
  assert.equal((await call('POST', `/api/parcels/${oops.body.id}/void`, { reason: 'Entered twice' }, admin)).body.status, 'void');

  // Search by AWB or recipient, and the Excel register: incoming and outgoing on their own sheets.
  assert.ok((await call('GET', '/api/parcels?q=dhl998', null, guard)).body.rows.some((x) => x.id === g.body.id));
  assert.ok((await call('GET', '/api/parcels?q=Asha', null, guard)).body.rows.length >= 3, 'by host name');
  const xl = await fetch(`${base}/api/parcels/export.xlsx`, { headers: { Cookie: admin } });
  assert.equal(xl.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await xl.arrayBuffer()));
  const col = (sheet, n) => { const v = []; book.getWorksheet(sheet).eachRow((row, i) => { if (i > 1) v.push(row.getCell(n).text); }); return v; };
  assert.ok(col('Incoming', 8).includes('BD12345678'));
  assert.ok(col('Outgoing', 9).includes('BD777'));
  assert.ok(col('Outgoing', 4).includes('Mr. K. Mehta'));
});

test('ID type and the on-device ID check: stored cleanly, filterable, counted on the overview', async () => {
  const { Visit } = require('../src/models');
  const body = (mobile, extra) => ({ firstName: 'Kiran', lastName: 'Bedi', gender: 'female', company: 'KB Co', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), mobile, ...extra });
  const pan = await call('POST', '/api/visits', body('9733311111', { idType: 'pan', idMask: 'none', idCheck: { status: 'mismatch', source: 'ocr', nameScore: 12.4, gender: 'mismatch', tamper: true, extra: 'x' } }), guard);
  assert.equal(pan.status, 201, JSON.stringify(pan.body));
  const v = await Visit.findById(pan.body.id).lean();
  assert.equal(v.idType, 'pan');
  assert.equal(v.idMaskMethod, 'none');
  assert.deepEqual(v.idCheck, { status: 'mismatch', source: 'ocr', nameScore: 12, gender: 'mismatch', tamper: true });

  const other = await call('POST', '/api/visits', body('9733311112', { idType: 'other', idTypeOther: 'Company ID', idCheck: { status: 'bogus' } }), guard);
  const o = await Visit.findById(other.body.id).lean();
  assert.equal(o.idTypeOther, 'Company ID');
  assert.equal(o.idCheck, undefined, 'an unknown status is not stored');
  const junk = await call('POST', '/api/visits', body('9733311113', { idType: 'ration', idCheck: { status: 'match', nameScore: 900, gender: 'yes' } }), guard);
  const j = await Visit.findById(junk.body.id).lean();
  assert.equal(j.idType, 'aadhaar');
  assert.deepEqual(j.idCheck, { status: 'match' });

  const asAdmin = await call('GET', `/api/visits/${other.body.id}`, null, admin);
  assert.equal(asAdmin.body.idLabel, 'Company ID');
  assert.equal((await call('GET', `/api/visits/${pan.body.id}`, null, admin)).body.idCheck.status, 'mismatch');
  const flagged = await call('GET', '/api/admin/visits?idCheck=mismatch', null, admin);
  assert.ok(flagged.body.rows.every((r) => r.idCheck?.status === 'mismatch') && flagged.body.rows.some((r) => r.id === pan.body.id));
  const stats = await call('GET', '/api/admin/stats', null, admin);
  assert.ok(stats.body.idMismatchToday >= 1);
  for (const k of ['materialPending', 'materialOverdue', 'parcelsWaiting', 'parcelsOld', 'groupsToday']) assert.equal(typeof stats.body[k], 'number', k);
});

test('email approvals: sent as well as the main channel to hosts with an address, link only, no photo', async () => {
  const config = require('../src/config');
  const { Host, Outbox } = require('../src/models');
  const { processOutbox } = require('../src/services/worker');
  const saved = { ...config.email };
  Object.assign(config.email, { driver: 'brevo', brevoKey: 'test-key', from: 'desk@example.com', fromName: 'Security desk' });
  await Host.updateOne({ _id: hostIds.asha }, { email: 'asha@example.com' });
  const realFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.brevo.com/')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ messageId: '<m1@brevo>' }), { status: 201 }); }
    return realFetch(url, opts);
  };
  try {
    const r = await call('POST', '/api/visits', { firstName: 'Meera', lastName: 'Nair', gender: 'female', company: 'Nair & Co', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), mobile: '9733322221' }, guard);
    assert.equal(r.status, 201);
    const job = await Outbox.findOne({ visit: r.body.id, kind: 'email' }).lean();
    assert.ok(job, 'an email job is queued next to the SMS');
    assert.ok(await Outbox.findOne({ visit: r.body.id, kind: 'sms' }).lean(), 'the main channel still goes');
    await Outbox.updateMany({ _id: { $ne: job._id }, status: 'queued' }, { nextAttemptAt: new Date(Date.now() + 3600e3) }); // just this job
    await processOutbox();
    assert.equal((await Outbox.findById(job._id).lean()).lastError, undefined);
    const mail = sent.find((m) => m.to[0].email === 'asha@example.com');
    assert.ok(mail);
    assert.match(mail.subject, /Meera Nair/);
    assert.match(mail.htmlContent, /\/approve\/[\w-]+/);
    assert.equal(mail.attachment, undefined, 'no photo or ID in the mailbox');
    assert.equal((await Outbox.findById(job._id).lean()).status, 'sent');
    // The approve link in the email only opens the page; it never decides on its own.
    const token = /\/approve\/([\w-]+)/.exec(mail.htmlContent)[1];
    await fetch(`${base}/approve/${token}`);
    assert.equal((await require('../src/models').Visit.findById(r.body.id).lean()).status, 'pending');
  } finally {
    global.fetch = realFetch;
    Object.assign(config.email, saved);
    await Host.updateOne({ _id: hostIds.asha }, { $unset: { email: 1 } });
  }
});

test('host import: preview first, a second import updates people instead of adding them twice', async () => {
  const { Host } = require('../src/models');
  const sheet = 'Name,Flat,Phone,Email\nNina Rao,C-501,9700000101,nina@example.com\n"Omar Jr",C-502,9700000102,\nBad Line,,9700000103,\nNo Number,C-504,,\nDup Nina,C-505,9700000101,\nBad Mail,C-506,9700000106,not-an-email';
  const dry = await call('POST', '/api/admin/hosts/import', { text: sheet, dryRun: true }, admin);
  assert.equal(dry.status, 200);
  assert.equal(dry.body.add, 2);
  assert.deepEqual(dry.body.errors.map((e) => e.line), [4, 5, 6, 7]);
  assert.equal(await Host.countDocuments({ mobile: '+919700000101' }), 0, 'a preview saves nothing');

  const first = await call('POST', '/api/admin/hosts/import', { text: sheet }, admin);
  assert.equal(first.body.created, 2);
  assert.equal(first.body.errors.length, 4);
  // The same directory again, with one person moved: one update, nothing doubled.
  const again = await call('POST', '/api/admin/hosts/import', { text: 'Nina Rao,D-101,9700000101\nOmar Jr,C-502,9700000102' }, admin);
  assert.equal(again.body.created, 0);
  assert.equal(again.body.updated, 1);
  assert.equal(again.body.same, 1);
  assert.equal(await Host.countDocuments({ mobile: '+919700000101' }), 1);
  const nina = await Host.findOne({ mobile: '+919700000101' }).lean();
  assert.equal(nina.unit, 'D-101');
  assert.equal(nina.email, 'nina@example.com', 'an empty email cell keeps the address on file');
  // The old request shape (csv) still works.
  assert.equal((await call('POST', '/api/admin/hosts/import', { csv: 'Pia Sen,E-1,9700000107' }, admin)).body.created, 1);
  assert.equal((await call('POST', '/api/admin/hosts/import', { text: sheet }, guard)).status, 403);
});

test('expected visitors in bulk: preview, per-line reasons, own dates and hosts, then cancel several at once', async () => {
  const { Invite } = require('../src/models');
  const { siteDay } = require('../src/services/core');
  const { addDays } = require('../src/services/passes');
  const today = siteDay();
  const [y, m, d] = addDays(today, 2).split('-');
  await call('POST', '/api/admin/blocks', { mobile: '9700000209', reason: 'Not allowed on site' }, admin);
  const text = [
    'Name\tMobile\tCompany\tDate\tHost',
    'Kavya Iyer\t9700000201\tTCS\t\t',
    `Arjun Rao\t9700000202\tInfosys\t${d}/${m}/${y}\tB-303`,
    'Solo\t9700000203\t\t\t',
    'Lata Menon\t12345\t\t\t',
    'Ravi Bose\t9700000209\t\t\t',
    'Kavya Iyer\t9700000201\tTCS\t\t',
    'Neha Shah\t9700000206\t\t\tNobody Here',
    'Old Date\t9700000207\t\t01/01/2020\t',
  ].join('\n');
  const dry = await call('POST', '/api/admin/invites/import', { text, day: today, hostId: hostIds.asha, dryRun: true }, admin);
  assert.equal(dry.status, 200);
  assert.equal(dry.body.add, 2);
  const why = Object.fromEntries(dry.body.errors.map((e) => [e.line, e.error]));
  assert.match(why[4], /first and last name/);
  assert.match(why[5], /not a valid mobile/);
  assert.equal(why[6], 'On the blocked list');
  assert.equal(why[7], 'Already expected on one of those days');
  assert.match(why[8], /No host called/);
  assert.match(why[9], /90 days/);
  const arjun = dry.body.rows.find((r) => r.name === 'Arjun Rao');
  assert.equal(arjun.day, addDays(today, 2), 'day-first dates are read the Indian way');
  assert.equal(arjun.host.name, 'Rahul K Mehta', 'a flat in the Host column picks that host');
  assert.equal(await Invite.countDocuments({ mobile: '+919700000201' }), 0);

  const saved = await call('POST', '/api/admin/invites/import', { text, day: today, hostId: hostIds.asha }, admin);
  assert.equal(saved.body.created, 2);
  const lookup = await call('GET', '/api/visits/lookup?mobile=9700000201', null, guard);
  assert.equal(lookup.body.invite.host.name, 'Asha Verma', 'expected today, ready at the gate');
  // Importing the same list again adds nobody.
  assert.equal((await call('POST', '/api/admin/invites/import', { text, day: today, hostId: hostIds.asha }, admin)).body.created, 0);
  assert.equal((await call('POST', '/api/admin/invites/import', { text: 'A B,9700000299' }, admin)).body.errors[0].error, 'No day. Go back and pick the day, or add a Date column');

  const ids = (await Invite.find({ mobile: { $in: ['+919700000201', '+919700000202'] } }).lean()).map((i) => String(i._id));
  const off = await call('POST', '/api/admin/invites/cancel', { ids }, admin);
  assert.equal(off.body.cancelled, 2);
  assert.equal((await call('GET', '/api/visits/lookup?mobile=9700000201', null, guard)).body.invite, null);
});

test('end-of-day sweep: several visitors checked out together with one reason; overstay counts only passes that ended', async () => {
  const { Visit } = require('../src/models');
  const ids = [];
  for (const [first, mobile] of [['Sweep', '9700000301'], ['Sweepy', '9700000302']]) {
    const r = await checkIn(first, hostIds.asha, mobile);
    await call('POST', `/api/approvals/${await tokenFor(r.body.id)}/decision`, { decision: 'approve' });
    ids.push(r.body.id);
  }
  // A multi-day pass holder let in eleven hours ago is not overstaying; one whose pass ended is.
  await Visit.updateOne({ _id: ids[0] }, { decidedAt: new Date(Date.now() - 11 * 3600e3), validUntil: new Date(Date.now() + 5 * 86400e3) });
  await Visit.updateOne({ _id: ids[1] }, { validUntil: new Date(Date.now() - 60e3) });
  const stale = await call('GET', '/api/admin/stale', null, admin);
  assert.deepEqual(stale.body.rows.map((r) => r.id).filter((id) => ids.includes(id)), [ids[1]]);

  assert.equal((await call('POST', '/api/visits/force-checkout', { ids, reason: 'x' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/visits/force-checkout', { ids, reason: 'End of day sweep' }, guard)).status, 403);
  const swept = await call('POST', '/api/visits/force-checkout', { ids: [...ids, ids[0]], reason: 'End of day sweep' }, admin);
  assert.equal(swept.body.checkedOut, 2);
  const after = await Visit.find({ _id: { $in: ids } }).lean();
  assert.ok(after.every((v) => v.status === 'force_checked_out' && v.forceReason === 'End of day sweep'));
  const timeline = await call('GET', `/api/admin/visits/${ids[0]}/timeline`, null, admin);
  assert.ok(timeline.body.rows.some((t) => t.action === 'visit.force_checked_out'), 'each visit keeps its own audit entry');
});

test('admin search finds visitors, hosts and staff from one box; the audit log searches and pages', async () => {
  const r = await call('GET', '/api/admin/search?q=Sweepy', null, admin);
  assert.equal(r.body.visits[0].name, 'Sweepy Sharma');
  assert.equal((await call('GET', '/api/admin/search?q=Sweepy%20Sha', null, admin)).body.visits[0].name, 'Sweepy Sharma', 'first and last name together');
  assert.equal((await call('GET', '/api/admin/search?q=00302', null, admin)).body.visits[0].name, 'Sweepy Sharma', 'by the end of the mobile');
  assert.equal((await call('GET', '/api/admin/search?q=asha', null, admin)).body.hosts[0].name, 'Asha Verma');
  assert.equal((await call('GET', '/api/admin/search?q=gate%20guard', null, admin)).body.staff[0].username, 'guard1');
  assert.equal((await call('GET', '/api/admin/search?q=asha', null, guard)).status, 403);

  const page1 = await call('GET', '/api/admin/audit', null, admin);
  assert.equal(page1.body.rows.length, 100);
  assert.equal(page1.body.more, true);
  const page2 = await call('GET', `/api/admin/audit?before=${page1.body.rows.at(-1)._id}`, null, admin);
  assert.ok(page2.body.rows.length > 0);
  assert.ok(page2.body.rows[0]._id < page1.body.rows.at(-1)._id);
  const found = await call('GET', '/api/admin/audit?q=End%20of%20day', null, admin);
  assert.ok(found.body.rows.length >= 2 && found.body.rows.every((x) => x.details.reason === 'End of day sweep'));
});

test('event guests leave together: check out the selected guests at the gate', async () => {
  const { siteDay } = require('../src/services/core');
  const { addDays } = require('../src/services/passes');
  const today = siteDay();
  const grp = await call('POST', '/api/groups', { name: 'Team offsite', hostId: hostIds.asha, startDay: today, endDay: today }, admin);
  await call('POST', `/api/groups/${grp.body.id}/guests`, { text: 'Tara Das,9700000401\nVik Das,9700000402\nZed Das' }, admin);
  const list = (await call('GET', `/api/groups/${grp.body.id}/guests`, null, guard)).body.rows;
  const ids = list.map((g) => g.id);
  assert.equal((await call('POST', `/api/groups/${grp.body.id}/admit-many`, { ids: ids.slice(0, 2) }, guard)).body.letIn, 2);
  const out = await call('POST', `/api/groups/${grp.body.id}/checkout-many`, { ids }, guard);
  assert.equal(out.body.checkedOut, 2, 'the guest who never came in is left alone');
  const after = (await call('GET', `/api/groups/${grp.body.id}/guests`, null, guard)).body.rows;
  assert.deepEqual(after.map((g) => g.status).sort(), ['expected', 'left', 'left']);

  // A multi-day event: leaving keeps the pass, so they can come back tomorrow.
  const multi = await call('POST', '/api/groups', { name: 'Two-day summit', hostId: hostIds.asha, startDay: today, endDay: addDays(today, 1) }, admin);
  await call('POST', `/api/groups/${multi.body.id}/guests`, { text: 'Uma Pai,9700000411' }, admin);
  const uma = (await call('GET', `/api/groups/${multi.body.id}/guests`, null, guard)).body.rows[0];
  await call('POST', `/api/groups/${multi.body.id}/guests/${uma.id}/admit`, {}, guard);
  await call('POST', `/api/groups/${multi.body.id}/checkout-many`, { ids: [uma.id] }, guard);
  assert.equal((await call('GET', `/api/groups/${multi.body.id}/guests`, null, guard)).body.rows[0].status, 'out');
});

test('gate scan: one scan lets a visitor out, a double scan changes nothing, a mistake can be undone', async () => {
  const { Visit } = require('../src/models');
  const back = (id, ms = 2 * 60e3) => Visit.updateOne({ _id: id }, { $set: { 'movements.$[].at': new Date(Date.now() - ms) } });
  const r = await checkIn('Scan', hostIds.asha, '9700000501');
  await call('POST', `/api/approvals/${await tokenFor(r.body.id)}/decision`, { decision: 'approve' });
  const v = (await call('GET', `/api/visits/${r.body.id}`, null, guard)).body;
  assert.match(v.passCode, /^[A-HJ-NP-Z2-9]{8}$/, 'every pass carries a code for its QR');
  const scan = (code) => call('POST', '/api/visits/scan', { code }, guard);

  // Scanned again right after entering (a guard double-checking): nothing changes.
  const bounce = await scan(v.passCode);
  assert.equal(bounce.body.result, 'just_in');
  assert.equal((await Visit.findById(r.body.id).lean()).status, 'approved');

  await back(r.body.id);
  const typed = `${v.passCode.slice(0, 4).toLowerCase()}-${v.passCode.slice(4)}`;
  const out = await scan(typed);
  assert.equal(out.body.result, 'out', 'a typed code with a dash and small letters works too');
  assert.equal(out.body.visit.name, 'Scan Sharma');
  assert.equal(out.body.undo.action, 'out');
  assert.equal((await Visit.findById(r.body.id).lean()).status, 'checked_out', 'a same-day pass closes at exit');

  // Wrong person scanned: undo puts them back inside, with the exit taken off the record.
  const undo = await call('POST', `/api/visits/${r.body.id}/undo-scan`, { action: 'out' }, guard);
  assert.equal(undo.body.status, 'approved');
  const restored = await Visit.findById(r.body.id).lean();
  assert.equal(restored.checkedOutAt, undefined);
  assert.equal(restored.movements.at(-1).kind, 'in');
  assert.equal((await call('POST', `/api/visits/${r.body.id}/undo-scan`, { action: 'out' }, guard)).status, 409, 'nothing left to undo');

  const out2 = await scan(v.passCode);
  assert.equal(out2.body.result, 'out');
  assert.equal((await scan(v.passCode)).body.result, 'just_out');
  await back(r.body.id);
  const used = await scan(v.passCode);
  assert.equal(used.body.result, 'ended', 'a closed pass cannot be used to come back in');
  // Too late to undo.
  assert.equal((await call('POST', `/api/visits/${r.body.id}/undo-scan`, { action: 'out' }, guard)).status, 409);

  assert.equal((await scan('ZZZZ-ZZZZ')).body.result, 'unknown');
  assert.equal((await scan('hello')).body.result, 'unknown');
  assert.equal((await call('POST', '/api/visits/scan', { code: v.passCode })).status, 401, 'staff only');

  // Waiting for the host: the pass is not valid yet.
  const p = await checkIn('Waits', hostIds.asha, '9700000502');
  const pending = await Visit.findById(p.body.id).lean();
  assert.equal((await scan(pending.passCode)).body.result, 'waiting');
});

test('gate scan: a multi-day pass goes out and back in on scans; a blocked holder is stopped at the door', async () => {
  const { Visit } = require('../src/models');
  const back = (id) => Visit.updateOne({ _id: id }, { $set: { 'movements.$[].at': new Date(Date.now() - 2 * 60e3) } });
  const r = await call('POST', '/api/visits', {
    firstName: 'Multi', lastName: 'Day', gender: 'male', mobile: '9700000511', company: 'Contractor', hostId: hostIds.asha,
    photo: jpeg(), idImage: jpeg(), validity: '3d',
  }, guard);
  await call('POST', `/api/approvals/${await tokenFor(r.body.id)}/decision`, { decision: 'approve' });
  const { passCode } = await Visit.findById(r.body.id).lean();
  const scan = () => call('POST', '/api/visits/scan', { code: passCode }, guard);

  await back(r.body.id);
  const out = await scan();
  assert.equal(out.body.result, 'out');
  assert.match(out.body.message, /They keep the pass/);
  assert.equal((await Visit.findById(r.body.id).lean()).status, 'away');

  await back(r.body.id);
  const inAgain = await scan();
  assert.equal(inAgain.body.result, 'in');
  assert.equal((await Visit.findById(r.body.id).lean()).movements.length, 3);
  // Let back in by mistake: undo returns them to "outside, pass valid".
  assert.equal((await call('POST', `/api/visits/${r.body.id}/undo-scan`, { action: 'in' }, guard)).body.status, 'away');

  await call('POST', '/api/admin/blocks', { mobile: '9700000511', reason: 'Barred after incident' }, admin);
  await back(r.body.id);
  const stopped = await scan();
  assert.equal(stopped.body.result, 'blocked');
  assert.equal(stopped.body.ok, false);
  assert.equal((await Visit.findById(r.body.id).lean()).status, 'away', 'still outside');
});

test('gate scan: event passes too; old passes get a code at start-up', async () => {
  const { Visit, Guest } = require('../src/models');
  const { siteDay } = require('../src/services/core');
  const today = siteDay();
  const grp = await call('POST', '/api/groups', { name: 'Scan gala', hostId: hostIds.asha, startDay: today, endDay: today }, admin);
  await call('POST', `/api/groups/${grp.body.id}/guests`, { text: 'Gala Guest,9700000521' }, admin);
  const guest = await Guest.findOne({ group: grp.body.id }).lean();
  const scan = () => call('POST', '/api/visits/scan', { code: `http://localhost/g/${guest.code}` }, guard);

  const first = await scan();
  assert.equal(first.body.result, 'in');
  assert.match(first.body.message, /Scan gala/);
  const visitId = first.body.visit.id;
  assert.equal((await call('POST', `/api/visits/${visitId}/undo-scan`, { action: 'in' }, guard)).status, 409, 'a first entry is not undone');
  assert.equal((await scan()).body.result, 'just_in');
  await Visit.updateOne({ _id: visitId }, { $set: { 'movements.$[].at': new Date(Date.now() - 2 * 60e3) } });
  assert.equal((await scan()).body.result, 'out');
  assert.equal((await Visit.findById(visitId).lean()).status, 'checked_out');

  // A pass printed before codes existed.
  const old = await Visit.findOne({ status: 'approved' }).lean();
  await Visit.updateOne({ _id: old._id }, { $unset: { passCode: 1 } });
  await require('../src/services/gate').backfillPassCodes();
  assert.match((await Visit.findById(old._id).lean()).passCode, /^[A-HJ-NP-Z2-9]{8}$/);
});

test('overstay: listed for the gate, acknowledged by the guard, escalated an hour after the pass ended; extending clears it', async () => {
  const { Visit, Outbox, Audit } = require('../src/models');
  const { escalate } = require('../src/services/overstay');
  const config = require('../src/config');
  const r = await checkIn('Overstay', hostIds.asha, '9700000401');
  await call('POST', `/api/approvals/${await tokenFor(r.body.id)}/decision`, { decision: 'approve' });
  const id = r.body.id;
  const listed = async (who = guard) => (await call('GET', '/api/visits/overstays', null, who)).body.rows.find((x) => x.id === id);
  assert.equal(await listed(), undefined, 'not while the pass runs');

  // Escalation contacts: numbers and emails in one box, checked.
  assert.match((await call('PATCH', '/api/admin/settings', { escalateTo: '98111 00099, not-an-email@' }, admin)).body.error, /not a valid/);
  const set = await call('PATCH', '/api/admin/settings', { escalateTo: '9811100099, security@hotel.example' }, admin);
  assert.deepEqual(set.body.escalateTo, { mobiles: ['+919811100099'], emails: ['security@hotel.example'] });

  // The pass ended 20 minutes ago: on the list for the guard and the admin, not yet escalated.
  await Visit.updateOne({ _id: id }, { validUntil: new Date(Date.now() - 20 * 60e3) });
  const row = await listed();
  assert.ok(row && row.overMinutes >= 19 && !row.ack && !row.escalatedAt);
  assert.ok(await listed(admin));
  const saved = { ...config.whatsapp };
  Object.assign(config.whatsapp, { on: true, token: 'wa', phoneId: 'PH', apiBase: 'http://127.0.0.1:9/none' });
  try {
    await escalate();
    assert.equal((await listed()).escalatedAt, null, 'not before an hour');

    // The guard acknowledges, once.
    const ack = await call('POST', `/api/visits/${id}/overstay-ack`, { note: 'Calling the host' }, guard);
    assert.equal(ack.status, 200);
    assert.equal((await listed()).ack.by, 'Gate Guard');
    assert.equal((await call('POST', `/api/visits/${id}/overstay-ack`, {}, admin)).body.already, true);

    // An hour past the pass and still inside: escalated once, to the host and the escalation contacts.
    await Visit.updateOne({ _id: id }, { validUntil: new Date(Date.now() - 61 * 60e3) });
    await escalate();
    await escalate();
    assert.ok((await listed()).escalatedAt);
    const told = await Outbox.find({ visit: id, 'vars.plain': true }).lean();
    assert.deepEqual(told.map((o) => o.to).sort(), ['+919000000001', '+919811100099'], 'host and the security manager, once each');
    assert.match(told.find((o) => o.to === '+919811100099').body, /Gate Guard\) is aware: Calling the host/);
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(await Audit.exists({ action: 'visit.overstay_escalated', entityId: id }));
    assert.equal((await call('GET', '/api/admin/stats', null, admin)).body.overstayEscalated, 1);
  } finally { Object.assign(config.whatsapp, saved); }

  // Extending: a clear reason when the time is not longer; then the pass runs on and the alert is gone.
  assert.equal((await call('POST', `/api/visits/${id}/extend`, { by: 'forever' }, guard)).status, 400);
  const ext = await call('POST', `/api/visits/${id}/extend`, { by: '2h', note: 'Meeting ran long' }, guard);
  assert.equal(ext.status, 200, JSON.stringify(ext.body));
  assert.ok(new Date(ext.body.validUntil) > new Date(Date.now() + 119 * 60e3), 'two hours from now, as the pass had already ended');
  assert.equal(ext.body.extensions.length, 1);
  assert.equal(ext.body.extensions[0].by, 'Gate Guard');
  assert.equal(ext.body.overstay, null);
  assert.equal(await listed(), undefined);
  assert.match((await call('POST', `/api/visits/${id}/extend`, { by: 'date', day: '2001-01-01' }, guard)).body.error, /Pick a date/);
  // Extended to a later day: the pass stays open when they step out, like any multi-day pass.
  const { siteDay } = require('../src/services/core');
  const { addDays } = require('../src/services/passes');
  const later = await call('POST', `/api/visits/${id}/extend`, { by: 'date', day: addDays(siteDay(), 2) }, admin);
  assert.equal(later.body.extensions.length, 2);
  const out = await call('POST', `/api/visits/${id}/checkout`, {}, guard);
  assert.equal(out.body.status, 'away');
  await call('POST', `/api/visits/${id}/end-pass`, {}, guard);
  assert.equal((await call('POST', `/api/visits/${id}/extend`, { by: '1h' }, guard)).status, 409, 'a closed pass cannot be extended');
});

test('emergency: a template to visitors, hosts or both on every channel, roll call at the assembly point, all clear ends it', async () => {
  const { Outbox, Audit } = require('../src/models');
  const config = require('../src/config');
  const ids = [];
  for (const [first, host, mobile] of [['Fire', hostIds.asha, '9700000911'], ['Drill', hostIds.rahul, '9700000912']]) {
    const r = await checkIn(first, host, mobile);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await call('POST', `/api/approvals/${await tokenFor(r.body.id)}/decision`, { decision: 'approve' });
    ids.push(r.body.id);
  }
  await call('PATCH', '/api/admin/settings', { assemblyPoint: 'Main driveway, by the fountain' }, admin);
  const setup = (await call('GET', '/api/emergency/setup', null, guard)).body;
  assert.match(setup.templates.find((t) => t.id === 'fire').text, /assembly point: Main driveway, by the fountain/);
  assert.ok(setup.counts.visitors >= 2 && setup.counts.theirHosts >= 2);
  assert.equal(setup.active, null);

  const saved = { ...config.whatsapp };
  Object.assign(config.whatsapp, { on: true, token: 'wa', phoneId: 'PH', apiBase: 'http://127.0.0.1:9/none' });
  try {
    const send = (body, who = guard) => call('POST', '/api/emergency/send', { template: 'fire', audience: 'both', text: setup.templates[0].text, ...body }, who);
    assert.equal((await send({ text: 'short' })).status, 400);
    assert.equal((await send({ audience: 'nobody' })).status, 400);
    assert.match((await send({ template: 'allclear' })).body.error, /no emergency/);

    // Fire to visitors and hosts: an emergency starts with everyone inside on the roll call.
    const fire = await send({});
    assert.equal(fire.status, 201, JSON.stringify(fire.body));
    assert.equal(fire.body.status, 'active');
    assert.ok(fire.body.total >= 2 && fire.body.people.some((p) => p.visitId === ids[0]));
    assert.ok(fire.body.sent.visitors >= 2 && fire.body.sent.hosts >= 2);
    const jobs = await Outbox.find({ emergency: fire.body.id }).lean();
    assert.ok(jobs.some((j) => j.to === '+919700000911' && j.kind === 'whatsapp'), 'the visitor');
    const toAsha = jobs.find((j) => j.to === '+919000000001');
    assert.match(toAsha.body, /Your visitors inside: .*Fire Sharma/, 'the host is told which of their visitors are inside');

    // An update to visitors only joins the same emergency and leaves hosts out.
    const upd = await send({ template: 'custom', audience: 'visitors', text: 'Please use the north staircase, the south one is closed.' });
    assert.equal(upd.body.id, fire.body.id);
    assert.equal(upd.body.messages.length, 2);
    assert.equal(await Outbox.countDocuments({ emergency: fire.body.id, 'vars.n': 1, to: '+919000000001' }), 0);
    assert.ok(upd.body.messages[0].delivery.whatsapp.queued >= 4, 'delivery counted per message and channel');

    // Roll call: ticked safe, and back if it was a mistake.
    const safe = (visitId, ok = true) => call('POST', `/api/emergency/${fire.body.id}/safe`, { visitId, safe: ok }, guard);
    assert.equal((await safe(ids[0])).body.safe, 1);
    assert.equal((await safe(ids[0], false)).body.safe, 0);
    const roll = await safe(ids[0]);
    assert.equal(roll.body.people.find((p) => p.visitId === ids[0]).safeBy, 'Gate Guard');
    assert.equal((await call('GET', '/api/emergency/active', null, admin)).body.active.safe, 1, 'every screen sees the same roll call');

    // All clear ends it.
    const clear = await send({ template: 'allclear', text: '✅ ALL CLEAR. It is safe to return.' }, admin);
    assert.equal(clear.body.status, 'closed');
    assert.equal((await call('GET', '/api/emergency/active', null, guard)).body.active, null);
    assert.equal((await safe(ids[1])).status, 409, 'no roll call once it has ended');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await Audit.exists({ action: 'emergency.closed', entityId: fire.body.id }));
  } finally { Object.assign(config.whatsapp, saved); }

  assert.equal((await call('GET', '/api/emergency/history', null, guard)).status, 403);
  assert.equal((await call('GET', '/api/emergency/history', null, admin)).body.rows[0].safe, 1);
});

test('lanyard card: given at check-in, one person at a time, searchable, collected at exit, then free again', async () => {
  const visit = (first, mobile, extra) => call('POST', '/api/visits', {
    firstName: first, lastName: 'Card', gender: 'male', mobile, company: 'Card Co', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), cardNo: ' 7 ', cardType: 'visitor', ...extra,
  }, guard);
  assert.match((await visit('Badcard', '9700000920', { cardNo: '#!' })).body.error, /Card number/);
  const a = await visit('Lanyard', '9700000921');
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(a.body.card, { no: '07', type: 'visitor' }, 'a typed 7 is card 07');
  const taken = await visit('Second', '9700000922');
  assert.equal(taken.body.code, 'card_in_use');
  assert.match(taken.body.error, /Visitor card 07 is with Lanyard Card \(waiting for the host\)/);
  assert.equal((await visit('Vendorcard', '9700000923', { cardType: 'vendor' })).status, 201, 'vendor card 07 is a different card');

  await call('POST', `/api/approvals/${await tokenFor(a.body.id)}/decision`, { decision: 'approve' });
  assert.ok((await call('GET', '/api/admin/search?q=07', null, admin)).body.visits.some((v) => v.id === a.body.id), 'who has card 07 now');
  assert.equal((await call('GET', '/api/admin/visits?name=7', null, admin)).body.rows.find((r) => r.id === a.body.id).card.no, '07');
  const out = await call('POST', `/api/visits/${a.body.id}/checkout`, { final: true }, guard);
  assert.equal(out.body.card.no, '07', 'the guard is reminded to collect it');

  // Card 07 is free again: given to someone after check-in.
  const late = await visit('Later', '9700000924', { cardNo: '' });
  assert.equal(late.body.card, null);
  const given = await call('POST', `/api/visits/${late.body.id}/card`, { cardNo: '07', cardType: 'visitor' }, guard);
  assert.equal(given.status, 200, JSON.stringify(given.body));
  assert.equal(given.body.card.no, '07');
});

test('emergency: two gates pressing Send together join one emergency; a returning pass holder gets a fresh card', async () => {
  const { Emergency, Visit } = require('../src/models');
  await Emergency.syncIndexes();
  const body = { template: 'evacuate', audience: 'both', text: 'Please leave the building now by the nearest exit.' };
  const [a, b] = await Promise.all([call('POST', '/api/emergency/send', body, guard), call('POST', '/api/emergency/send', body, admin)]);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(a.body.id, b.body.id, 'one emergency');
  assert.equal(await Emergency.countDocuments({ status: 'active' }), 1);
  assert.equal((await Emergency.findById(a.body.id).lean()).messages.length, 2, 'both messages kept');
  await call('POST', `/api/emergency/${a.body.id}/close`, {}, admin);

  // Multi-day holder with card 08 goes out (card handed back) and comes in again: the card is cleared.
  const r = await call('POST', '/api/visits', { firstName: 'Multi', lastName: 'Day', gender: 'male', mobile: '9700000931', company: 'MD', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), cardNo: '8', validity: '3d' }, guard);
  await call('POST', `/api/approvals/${await tokenFor(r.body.id)}/decision`, { decision: 'approve' });
  assert.equal((await call('POST', `/api/visits/${r.body.id}/checkout`, {}, guard)).body.status, 'away');
  assert.equal((await call('POST', `/api/visits/${r.body.id}/reenter`, {}, guard)).body.card, null);
  assert.equal((await Visit.findById(r.body.id).lean()).card, undefined);
});

test('licence: without one new entries pause but check-outs and emergencies work; a key restores them; the tunnel reaches public pages only', async () => {
  const config = require('../src/config');
  const license = require('../src/services/license');
  const { Setting } = require('../src/models');
  const TEST_KEY = 'eyJzaXRlIjoiVGVzdCBzaXRlIiwidW50aWwiOiIyMDI3LTAxLTI3IiwiZ2F0ZXMiOjMsImlzc3VlZCI6IjIwMjYtMTAtMjcifQ.vNW2YYe7gUsO4Hd8KdIeJgr1BBgjCDDmRMhiMEUZTKNeyy8VGrvEohV6bZ88tkDtt_thjIvx2w4xDVADq47gBg';
  Object.assign(config, { licenseRequired: true, lanOnly: true });
  license.forget();
  try {
    assert.equal((await call('GET', '/api/license', null, guard)).body.state, 'missing');
    const blocked = await call('POST', '/api/visits', { firstName: 'Lic', lastName: 'Ence', gender: 'male', mobile: '9700000941', company: 'L', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg() }, guard);
    assert.equal(blocked.status, 402);
    assert.match(blocked.body.error, /Check-outs, emergency messages and all records still work/);
    assert.equal((await call('POST', '/api/material', { direction: 'in', party: { company: 'X', name: 'Ravi', mobile: '9811100099' }, items: [{ name: 'Y', qty: 1 }], personPhoto: jpeg() }, guard)).status, 402);
    assert.equal((await call('GET', '/api/emergency/setup', null, guard)).status, 200, 'emergency never blocked');

    assert.equal((await call('POST', '/api/admin/license', { key: 'not-a-key' }, admin)).status, 400);
    assert.equal((await call('POST', '/api/admin/license', { key: TEST_KEY.slice(0, -4) + 'AAAA' }, admin)).status, 400, 'a changed key fails the signature');
    assert.equal((await call('POST', '/api/admin/license', { key: TEST_KEY }, guard)).status, 403);
    const ok = await call('POST', '/api/admin/license', { key: TEST_KEY }, admin);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.until, '2027-01-27');
    assert.equal((await call('POST', '/api/material', { direction: 'in', party: { company: 'X', name: 'Ravi', mobile: '9811100099' }, items: [{ name: 'Y', qty: 1 }], personPhoto: jpeg() }, guard)).status, 201, 'entries work again');

    // After the last day: ended; a clock turned back is caught.
    license.forget();
    assert.equal((await license.status(new Date('2027-02-01T10:00:00Z'))).state, 'expired');
    license.forget();
    assert.equal((await license.status(new Date('2027-01-15T10:00:00Z'))).state, 'clock', 'the server had seen 1 Feb 2027');
    await Setting.updateOne({ _id: 'site' }, { $set: { licenseSeenAt: new Date() } });
    license.forget();
    assert.equal((await license.status()).state, 'ok');

    // Through the tunnel: approval pages yes, sign-in and the console no.
    const tunnel = (url) => fetch(base + url, { headers: { 'Cf-Connecting-Ip': '1.2.3.4' } });
    assert.equal((await tunnel('/api/auth/me')).status, 403);
    assert.equal((await tunnel('/api/admin/stats')).status, 403);
    assert.equal((await tunnel('/api/approvals/not-a-real-token-at-all-xyz')).status, 404, 'approval links still reachable');
    assert.equal((await tunnel('/api/health')).status, 200);
  } finally {
    Object.assign(config, { licenseRequired: false, lanOnly: false });
    license.forget();
  }
});

test('emergency SMS: a type with an approved template goes by SMS with the site and assembly point; your own words do not', async () => {
  const { Outbox, Emergency } = require('../src/models');
  const config = require('../src/config');
  const saved = { key: config.otp.authKey, alerts: { ...config.sms.msg91Alerts }, short: config.sms.alertSiteShort };
  Object.assign(config.otp, { authKey: 'msg91-test-key' });
  Object.assign(config.sms.msg91Alerts, { fire: 'TPL-FIRE' });
  config.sms.alertSiteShort = 'St Regis Marriott Delhi';
  try {
    const setup = (await call('GET', '/api/emergency/setup', null, guard)).body;
    assert.deepEqual(setup.channels.smsKinds, ['fire']);
    const fire = await call('POST', '/api/emergency/send', { template: 'fire', audience: 'both', text: 'FIRE ALARM. Leave the building now by the nearest exit.' }, guard);
    assert.equal(fire.status, 201, JSON.stringify(fire.body));
    const sms = await Outbox.find({ emergency: fire.body.id, kind: 'sms' }).lean();
    assert.ok(sms.length >= 2, 'visitors and hosts get the SMS');
    assert.equal(sms[0].vars.kind, 'fire');
    assert.equal(sms[0].vars.site, 'St Regis Marriott Delhi');
    assert.equal(sms[0].vars.assembly, 'Main driveway, by the fountain');
    const own = await call('POST', '/api/emergency/send', { template: 'custom', audience: 'both', text: 'Use the north staircase, the south one is closed.' }, guard);
    assert.equal(await Outbox.countDocuments({ emergency: own.body.id, kind: 'sms', 'vars.n': own.body.messages.length - 1 }), 0, 'no SMS for free text');
    await Emergency.updateMany({ status: 'active' }, { status: 'closed' });
  } finally {
    config.otp.authKey = saved.key;
    Object.assign(config.sms.msg91Alerts, saved.alerts);
    config.sms.alertSiteShort = saved.short;
  }
});

test('check-in options are set by the admin; the host is told when the visitor leaves, and not when a scan out is undone', async () => {
  const { Outbox } = require('../src/models');
  const config = require('../src/config');
  assert.match((await call('PATCH', '/api/admin/settings', { durations: '2h, 99h' }, admin)).body.error, /99h/);
  const set = await call('PATCH', '/api/admin/settings', { purposes: 'Meeting, Banquet, Vendor visit', durations: '1h, 6 hours, today, 15d', notifyCheckout: true }, admin);
  assert.deepEqual(set.body.durations, ['1h', '6h', 'today', '15d']);
  const me = (await call('GET', '/api/auth/me', null, guard)).body;
  assert.deepEqual(me.checkin.purposes, ['Meeting', 'Banquet', 'Vendor visit']);
  assert.deepEqual(me.checkin.durations.map((d) => d.label), ['1 hour', '6 hours', 'Today', '15 days']);
  assert.equal(me.checkin.lanyardCards, false, 'lanyard card off by default');

  const saved = { ...config.whatsapp };
  Object.assign(config.whatsapp, { on: true, token: 'wa', phoneId: 'PH', apiBase: 'http://127.0.0.1:9/none' });
  try {
    const r = await call('POST', '/api/visits', { firstName: 'Leaves', lastName: 'Soon', gender: 'male', mobile: '9700000951', company: 'LS', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), validity: '6h', purpose: 'Banquet' }, guard);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { Visit } = require('../src/models');
    await Visit.updateOne({ _id: r.body.id }, { status: 'approved', decidedAt: new Date(), validUntil: new Date(Date.now() + 6 * 3600e3), movements: [{ kind: 'in', at: new Date(Date.now() - 5 * 60e3), gateName: 'Main gate' }] });
    // A scan out, then undone: the held-back message to the host is dropped.
    const v = await Visit.findById(r.body.id).lean();
    const scan = await call('POST', '/api/visits/scan', { code: v.passCode }, guard);
    assert.equal(scan.body.result, 'out', JSON.stringify(scan.body));
    assert.equal(await Outbox.countDocuments({ visit: r.body.id, 'vars.departure': true }), 1);
    await call('POST', `/api/visits/${r.body.id}/undo-scan`, { action: 'out' }, guard);
    assert.equal(await Outbox.countDocuments({ visit: r.body.id, 'vars.departure': true }), 0, 'undone scan: host not told');
    // A real check-out: the host is told who left, when and where.
    await call('POST', `/api/visits/${r.body.id}/checkout`, { final: true }, guard);
    const msg = await Outbox.findOne({ visit: r.body.id, 'vars.departure': true }).lean();
    assert.equal(msg.to, '+919000000001');
    assert.match(msg.body, /Your visitor Leaves Soon \(LS\) has left: .*Main gate|Your visitor Leaves Soon \(LS\) has left/);
  } finally { Object.assign(config.whatsapp, saved); }
  await call('PATCH', '/api/admin/settings', { purposes: 'Delivery, Meeting, Interview, Service / repair, Guest', durations: '2h, 4h, 8h, today, 3d, 7d, 10d, 20d, 30d' }, admin);
});

test('admin can delete a host: refused while a visitor is here for them; kept for history once used, removed for good otherwise', async () => {
  const { Host, Visit } = require('../src/models');
  const add = async (fullName, mobile) => (await call('POST', '/api/admin/hosts', { fullName, unit: 'Z-1', mobile }, admin)).body.id;
  const fresh = await add('Typo Host', '9700000201');
  assert.equal((await call('DELETE', `/api/admin/hosts/${fresh}`, null, guard)).status, 403);
  assert.equal((await call('DELETE', `/api/admin/hosts/${fresh}`, null, admin)).status, 200);
  assert.equal(await Host.findById(fresh).lean(), null, 'never used: removed for good');

  const used = await add('Busy Host', '9700000202');
  const visit = await Visit.collection.insertOne({ host: new (require('mongoose').Types.ObjectId)(used), status: 'approved', firstName: 'X', lastName: 'Y' });
  const refused = await call('DELETE', `/api/admin/hosts/${used}`, null, admin);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /1 visitor is here to meet Busy Host/);
  await Visit.collection.updateOne({ _id: visit.insertedId }, { $set: { status: 'checked_out' } });
  assert.equal((await call('DELETE', `/api/admin/hosts/${used}`, null, admin)).status, 200);
  const kept = await Host.findById(used).lean();
  assert.ok(kept.removedAt, 'named in a visit: hidden, kept');
  assert.equal(kept.active, false);
  const list = (await call('GET', '/api/admin/hosts', null, admin)).body.rows;
  assert.ok(!list.some((h) => h.id === used), 'gone from the list');
  assert.ok(!(await call('GET', '/api/hosts?q=Busy', null, guard)).body.rows.length, 'gone from the guard picker');
  assert.equal((await call('PATCH', `/api/admin/hosts/${used}`, { active: true }, admin)).status, 404, 'cannot be switched back on');
  assert.equal((await call('DELETE', `/api/admin/hosts/${used}`, null, admin)).status, 404);
  await Visit.collection.deleteOne({ _id: visit.insertedId });
});

test('daily report: the day\'s material received, parcels in and parcels out, for admins only', async () => {
  const r = await call('GET', '/api/reports/daily', null, admin);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.material) && Array.isArray(r.body.parcelsIn) && Array.isArray(r.body.parcelsOut));
  assert.match(r.body.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(r.body.material.every((m) => m.direction === 'in'));
  assert.ok(r.body.parcelsIn.every((p) => p.direction === 'in' && p.status !== 'void'));
  assert.ok(r.body.parcelsOut.every((p) => p.direction === 'out'));
  assert.equal((await call('GET', '/api/reports/daily', null, guard)).status, 403);
  assert.equal((await call('GET', '/api/reports/daily?day=2999-01-01', null, admin)).status, 400);
  assert.deepEqual((await call('GET', '/api/reports/daily?day=2020-01-01', null, admin)).body.material, []);
});

test('a double tap on Send for approval makes one visit, not two', async () => {
  const { Visit } = require('../src/models');
  const mobile = '9700000391';
  const rs = await Promise.all([1, 2, 3].map(() => checkIn('rahul', hostIds.asha, mobile)));
  const made = rs.filter((r) => r.status === 201).length;
  assert.equal(made, 1, `statuses ${rs.map((r) => r.status).join(',')}`);
  assert.equal(await Visit.countDocuments({ mobile: '+919700000391' }), 1);
});

test('two gates logging the same AWB at once make one parcel', async () => {
  const body = { direction: 'in', carrier: 'Blue Dart', awb: 'RACE12345', pieces: 1, type: 'parcel', hostId: hostIds.asha, photos: [jpeg()] };
  const rs = await Promise.all([1, 2].map(() => call('POST', '/api/parcels', body, guard)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
});

test('the console warns when last night\'s backup failed or is missing, and says nothing when it ran', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(require('node:os').tmpdir(), `vms-backup-status-${process.pid}.json`);
  const stats = async () => (await call('GET', '/api/admin/stats', null, admin)).body;
  try {
    assert.equal((await stats()).backup.state, 'off', 'no backup service: nothing to say');
    assert.equal((await stats()).disk, null, 'not the hotel PC (cloud demo): no disk warning');
    process.env.BACKUP_STATUS_FILE = file;
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ok: true, error: '' }));
    assert.equal((await stats()).backup.state, 'ok');
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ok: false, error: 'The backup drive is not connected' }));
    const failed = (await stats()).backup;
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /not connected/);
    fs.writeFileSync(file, JSON.stringify({ at: new Date(Date.now() - 40 * 3600e3).toISOString(), ok: true, error: '' }));
    assert.equal((await stats()).backup.state, 'stale');
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ok: true, error: '', drive: false }));
    assert.equal((await stats()).backup.state, 'nodrive', 'copied onto the PC\'s own disk: said so, not "ok"');
    assert.equal(typeof (await stats()).disk.freeGb, 'number', 'on the hotel PC the free space is checked');
  } finally { delete process.env.BACKUP_STATUS_FILE; fs.rmSync(file, { force: true }); }
});

test('no reply from the host: the guard lets the visitor in after the host said yes on the phone, and it is recorded', async () => {
  const r = await checkIn('Phoney', hostIds.asha, '9700000392');
  assert.equal(r.status, 201);
  assert.equal((await call('POST', `/api/visits/${r.body.id}/approve-by-phone`, { note: '' }, guard)).status, 400, 'must say who said yes');
  const ok = await call('POST', `/api/visits/${r.body.id}/approve-by-phone`, { note: 'Asha Verma, on her mobile' }, guard);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.dailyNumber > 0, 'a pass number is issued');
  const { Visit, Audit } = require('../src/models');
  const v = await Visit.findById(r.body.id).lean();
  assert.equal(v.status, 'approved');
  assert.equal(v.phoneApproval.note, 'Asha Verma, on her mobile');
  assert.ok(await Audit.exists({ action: 'visit.approved_by_phone', entityId: v._id }));
  assert.equal((await call('POST', `/api/visits/${r.body.id}/approve-by-phone`, { note: 'again' }, guard)).status, 409, 'once only');
});

test('a counter behind the records (data moved or partly restored) catches up instead of failing every new entry', async () => {
  const { Counter } = require('../src/models');
  await Counter.updateOne({ _id: 'visitor' }, { $set: { seq: 0 } });
  await Counter.updateOne({ _id: 'parcel' }, { $set: { seq: 0 } });
  const v = await checkIn('Behind', hostIds.asha, '9700000393');
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const p = await call('POST', '/api/parcels', { direction: 'in', carrier: 'DTDC', awb: 'BEHIND1', pieces: 1, type: 'parcel', hostId: hostIds.asha, photos: [jpeg()] }, guard);
  assert.equal(p.status, 201, JSON.stringify(p.body));
});

test('on leaving: the host is emailed (also when security checks them out) and the visitor gets a thank-you email', async () => {
  const config = require('../src/config');
  const { Outbox, Host, Visit } = require('../src/models');
  const saved = { ...config.email };
  Object.assign(config.email, { driver: 'smtp', from: 'desk@example.com', smtp: { ...saved.smtp, host: '127.0.0.1', port: 9, user: 'u', pass: 'p' } });
  try {
    assert.ok(require('../src/services/email').enabled());
    await Host.updateOne({ _id: hostIds.asha }, { email: 'asha@example.com' });
    const r = await call('POST', '/api/visits', { firstName: 'Thanks', lastName: 'Visitor', gender: 'male', mobile: '9700000394', email: 'guest@example.com', company: 'Acme', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg() }, guard);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await call('POST', `/api/visits/${r.body.id}/approve-by-phone`, { note: 'Asha on the phone' }, guard);
    assert.equal((await call('POST', `/api/visits/${r.body.id}/force-checkout`, { reason: 'Left without scanning' }, admin)).status, 200);
    const mails = await Outbox.find({ visit: r.body.id, kind: 'email', 'vars.departure': true }).lean();
    assert.ok(mails.some((m) => m.to === 'asha@example.com' && /has left/.test(m.vars.subject)), 'host told even when security checks them out');
    assert.ok(mails.some((m) => m.to === 'guest@example.com' && /Thank you for visiting/.test(m.vars.subject)), 'visitor thanked');
    await call('PATCH', '/api/admin/settings', { thankVisitor: false }, admin);
    const r2 = await call('POST', '/api/visits', { firstName: 'Nothanks', lastName: 'Visitor', gender: 'male', mobile: '9700000395', email: 'guest2@example.com', company: 'Acme', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg() }, guard);
    await call('POST', `/api/visits/${r2.body.id}/approve-by-phone`, { note: 'Asha on the phone' }, guard);
    await call('POST', `/api/visits/${r2.body.id}/checkout`, { final: true }, guard);
    assert.ok(!(await Outbox.exists({ visit: r2.body.id, to: 'guest2@example.com' })), 'switch off: no thank-you');
    await call('PATCH', '/api/admin/settings', { thankVisitor: true }, admin);
    await Visit.deleteMany({ mobile: { $in: ['+919700000394', '+919700000395'] } });
  } finally { Object.assign(config.email, saved); }
});

test('a delivery records the person who brings it: name, mobile and photo required; their ID card when shown', async () => {
  const body0 = { direction: 'in', party: { company: 'Courier Co', name: 'Sunil', mobile: '9811100055' }, items: [{ name: 'Linen', qty: 10 }] };
  assert.match((await call('POST', '/api/material', { ...body0, party: { company: 'Courier Co' }, personPhoto: jpeg() }, guard)).body.error, /name of the person/);
  assert.match((await call('POST', '/api/material', body0, guard)).body.error, /photo of the person/);
  const r = await call('POST', '/api/material', { ...body0, personPhoto: jpeg(), personIdImage: jpeg(), personIdType: 'pan' }, guard);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.personPhoto, /\/person\/0$/);
  assert.match(r.body.personIdImage, /\/person-id\/0$/);
  assert.equal(r.body.personIdType, 'pan');
  assert.equal((await fetch(base + r.body.personPhoto, { headers: { Cookie: guard } })).status, 200);
});

test('ID or face did not match: the reason the guard gave is kept on the visit', async () => {
  const r = await call('POST', '/api/visits', { firstName: 'Odd', lastName: 'Card', gender: 'male', mobile: '9700000396', company: 'Acme', hostId: hostIds.asha, photo: jpeg(), idImage: jpeg(), idOverride: 'Old photo on the ID (the face matches the ID photo only 31%)' }, guard);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = (await call('GET', `/api/visits/${r.body.id}`, null, admin)).body;
  assert.match(v.idOverride.reason, /Old photo/);
  assert.equal(v.idOverride.byName, 'Gate Guard');
});

test('daily report by email: a PDF to the security manager once a night, and on "Email it now"', async () => {
  const config = require('../src/config');
  const dailyReport = require('../src/services/dailyReport');
  const settings = require('../src/services/settings');
  const { siteDay } = require('../src/services/core');
  const passes = require('../src/services/passes');
  const saved = { ...config.email };
  const realFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.brevo.com/')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ messageId: '<r1@brevo>' }), { status: 201 }); }
    return realFetch(url, opts);
  };
  try {
    assert.equal((await call('POST', '/api/reports/daily/email', {}, admin)).status, 409, 'email not set up: says so');
    Object.assign(config.email, { driver: 'brevo', brevoKey: 'test-key', from: 'desk@example.com', fromName: 'Security desk' });
    assert.equal((await call('POST', '/api/reports/daily/email', {}, admin)).status, 400, 'no address yet: says where to add one');
    assert.equal((await call('PATCH', '/api/admin/settings', { dailyReportTo: 'not-an-email' }, admin)).status, 400);
    const set = await call('PATCH', '/api/admin/settings', { dailyReportTo: 'Security@Hotel.example, gm@hotel.example' }, admin);
    assert.deepEqual(set.body.dailyReportTo, ['security@hotel.example', 'gm@hotel.example']);
    assert.equal((await call('POST', '/api/reports/daily/email', {}, guard)).status, 403);

    const now = await call('POST', '/api/reports/daily/email', {}, admin);
    assert.equal(now.status, 200, JSON.stringify(now.body));
    const mail = sent.pop();
    assert.deepEqual(mail.to.map((t) => t.email), ['security@hotel.example', 'gm@hotel.example'], 'one email to everyone');
    assert.match(mail.subject, /Daily gate report/);
    const pdf = Buffer.from(mail.attachment[0].content, 'base64');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(mail.attachment[0].name, /\.pdf$/);

    // The night job: not in the first five minutes after midnight, then yesterday's report once.
    await settings.update({ dailyReportSentFor: '' });
    dailyReport.nightly.reset();
    const at = (hhmm) => new Date(`${siteDay()}T${hhmm}:00+05:30`);
    await dailyReport.nightly(at('00:02'));
    assert.equal(sent.length, 0, 'waits until 00:05');
    await dailyReport.nightly(at('00:06'));
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Daily gate report/);
    assert.equal((await settings.get()).dailyReportSentFor, passes.addDays(siteDay(at('00:06')), -1));
    dailyReport.nightly.reset();
    await dailyReport.nightly(at('09:00'));
    assert.equal(sent.length, 1, 'never twice for the same day');
  } finally {
    global.fetch = realFetch;
    Object.assign(config.email, saved);
    await settings.update({ dailyReportTo: [], dailyReportSentFor: '' });
  }
});

test('expected visitors: a date range and a gate, listed on every gate tablet, the host told on arrival, closed after', async () => {
  const config = require('../src/config');
  const { Invite, Outbox, Host } = require('../src/models');
  const invites = require('../src/services/invites');
  const { siteDay } = require('../src/services/core');
  const passes = require('../src/services/passes');
  const today = siteDay();
  const tower = await call('POST', '/api/admin/gates', { name: 'Tower Test Gate' }, admin);
  assert.equal(tower.status, 201, JSON.stringify(tower.body));
  const add = (body) => call('POST', '/api/admin/invites', { firstName: 'Kabir', lastName: 'Contractor', mobile: '9700000501', company: 'BuildCo', hostId: hostIds.rahul, day: today, ...body }, admin);

  assert.equal((await add({ dayTo: passes.addDays(today, -1) })).status, 400, 'last day before the first');
  assert.equal((await add({ dayTo: passes.addDays(today, 40) })).status, 400, 'at most a month');
  assert.equal((await add({ gateId: '000000000000000000000000' })).status, 400, 'unknown gate');
  const inv = await add({ dayTo: passes.addDays(today, 2), gateId: tower.body.id, note: 'Fixing the lobby lights' });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.dayTo, passes.addDays(today, 2));
  assert.equal(inv.body.gate.name, 'Tower Test Gate');
  assert.equal((await add({ day: passes.addDays(today, 1) })).status, 409, 'overlapping days refused');

  // Every gate lists them, with the day of the range and the gate they should use.
  const list = await call('GET', '/api/visits/expected', null, guard);
  assert.equal(list.status, 200);
  const row = list.body.rows.find((r) => r.id === inv.body.id);
  assert.ok(row, 'on the guard\'s list');
  assert.equal(row.gate, 'Tower Test Gate');
  assert.equal(row.dayOf, 'Day 1 of 3');
  assert.equal(row.mobile, '+919700000501');
  assert.equal((await call('GET', '/api/visits/lookup?mobile=9700000501', null, guard)).body.invite.gate, 'Tower Test Gate');

  // Let in: pass at once, the host emailed, and the list moves them to "arrived".
  const saved = { ...config.email };
  Object.assign(config.email, { driver: 'smtp', from: 'desk@example.com', smtp: { ...saved.smtp, host: '127.0.0.1', port: 9, user: 'u', pass: 'p' } });
  await Host.updateOne({ _id: hostIds.rahul }, { email: 'rahul@example.com' });
  try {
    const v = await call('POST', '/api/visits', { firstName: 'Kabir', lastName: 'Contractor', gender: 'male', mobile: '9700000501', company: 'BuildCo', hostId: hostIds.rahul, photo: jpeg(), idImage: jpeg(), inviteId: inv.body.id }, guard);
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal(v.body.status, 'approved');
    const mail = await Outbox.findOne({ visit: v.body.id, kind: 'email', to: 'rahul@example.com' }).lean();
    assert.ok(mail && /has arrived/.test(mail.vars.subject), 'host told their guest arrived');
    const after = await call('GET', '/api/visits/expected', null, guard);
    assert.ok(!after.body.rows.some((r) => r.id === inv.body.id), 'off the to-come list for today');
    const came = after.body.arrived.find((r) => r.id === inv.body.id);
    assert.ok(came && came.dailyNumber === v.body.dailyNumber, 'shown as arrived with the pass number');
    assert.equal((await call('GET', '/api/visits/lookup?mobile=9700000501', null, guard)).body.invite, null, 'once a day');
    const doc = await Invite.findById(inv.body.id).lean();
    assert.equal(doc.status, 'expected', 'still expected on the coming days');
    const adminRow = (await call('GET', '/api/admin/invites', null, admin)).body.rows.find((r) => r.id === inv.body.id);
    assert.equal(adminRow.arrivedToday, true);
  } finally {
    Object.assign(config.email, saved);
    await Host.updateOne({ _id: hostIds.rahul }, { $unset: { email: 1 } });
  }

  // The coming days: open again tomorrow, closed for good on the last day.
  const doc = await Invite.findById(inv.body.id).lean();
  assert.ok(await Invite.exists({ _id: doc._id, ...invites.openOn(passes.addDays(today, 1)) }), 'open again tomorrow');
  assert.ok(await invites.claim(doc, doc.visit, passes.addDays(today, 1)));
  assert.equal(await invites.claim(doc, doc.visit, passes.addDays(today, 1)), null, 'not twice the same day');
  assert.ok(await invites.claim(doc, doc.visit, passes.addDays(today, 2)));
  assert.equal((await Invite.findById(doc._id).lean()).status, 'arrived', 'the last day closes it');

  // Never came: closed as missed once the days are over.
  const no = await add({ mobile: '9700000502', firstName: 'Nobody' });
  await Invite.updateOne({ _id: no.body.id }, { day: passes.addDays(today, -2), dayTo: passes.addDays(today, -1) });
  await invites.closePast(today);
  assert.equal((await Invite.findById(no.body.id).lean()).status, 'missed');
  await Invite.deleteMany({ mobile: { $in: ['+919700000501', '+919700000502'] } });
});
