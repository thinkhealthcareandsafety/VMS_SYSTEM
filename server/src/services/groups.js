const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const config = require('../config');
const { Visit, Guest, Block } = require('../models');
const { siteDay, nextDailyNumber, nextVisitorRef, audit, normalizeMobile, cleanText, tidyName } = require('./core');
const passes = require('./passes');

const MAX_ROWS = 1000;    // per upload
const MAX_GUESTS = 2000;  // per group
const NAME_RE = /^[\p{L} .'-]{1,80}$/u;

// ---------- Pass codes ----------
// 8 characters without look-alikes (no 0/O, 1/I/L), shown as K7M2-9QXP: easy to read out and type.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8)).map((b) => ALPHABET[b % ALPHABET.length]).join('');
const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const passUrl = (code) => `${config.appBaseUrl}/g/${code}`;
// Whatever the scanner or the guard typed: the pass link, "k7m2-9qxp", "K7M2 9QXP"...
function readCode(input) {
  const s = String(input || '').trim();
  const fromUrl = /\/g\/([A-Za-z0-9-]{8,12})\b/.exec(s);
  const raw = (fromUrl ? fromUrl[1] : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 && [...raw].every((ch) => ALPHABET.includes(ch)) ? raw : null;
}

// ---------- Guest lists ----------
// Spreadsheets arrive with all sorts of headings; these are the ones we recognise.
const HEAD = {
  name: ['name', 'guestname', 'fullname', 'guest', 'visitorname', 'attendee', 'attendeename', 'participant'],
  first: ['firstname', 'first', 'givenname', 'fname'],
  last: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  mobile: ['mobile', 'phone', 'mobileno', 'mobilenumber', 'phonenumber', 'phoneno', 'contact', 'contactno', 'contactnumber', 'number', 'whatsapp', 'whatsappnumber', 'cell'],
  company: ['company', 'organisation', 'organization', 'org', 'firm', 'from', 'companyname', 'side', 'note', 'remarks', 'designation'],
};
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// RFC 4180 CSV (quoted fields, commas and line breaks inside quotes); tabs work too, for text pasted from Excel.
function parseDelimited(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells = [];
    for (let c = 1; c <= r.cellCount; c += 1) cells.push(String(r.getCell(c).text ?? '').trim());
    if (cells.some(Boolean)) rows.push(cells);
  });
  return rows;
}

// Rows of cells -> [{ line, firstName, lastName, mobileRaw, company }]. With no recognisable heading row,
// columns are taken as name, mobile, company.
function toGuests(rows) {
  if (!rows.length) return [];
  const head = rows[0].map(key);
  const find = (names) => head.findIndex((h) => names.includes(h));
  let col = { name: find(HEAD.name), first: find(HEAD.first), last: find(HEAD.last), mobile: find(HEAD.mobile), company: find(HEAD.company) };
  const hasHead = Object.values(col).some((i) => i >= 0);
  if (!hasHead) col = { name: 0, first: -1, last: -1, mobile: 1, company: 2 };
  const body = hasHead ? rows.slice(1) : rows;
  return body.map((r, i) => {
    const get = (c) => (c >= 0 ? cleanText(String(r[c] ?? ''), 120) : '');
    let full = get(col.name);
    if (!full && (col.first >= 0 || col.last >= 0)) full = `${get(col.first)} ${get(col.last)}`.trim();
    let mobileRaw = get(col.mobile);
    let company = get(col.company);
    // "Sonia Gill 98222 00004 Bride side" pasted into one cell: take the number (and what follows) out of the name.
    const inName = !mobileRaw && /^(.*?\p{L}.*?)[\s,;:|-]+(\+?\d[\d\s-]{8,14}\d)(?:[\s,;:|-]+(.*))?$/u.exec(full);
    if (inName) {
      full = inName[1].trim();
      mobileRaw = inName[2].trim();
      if (!company && inName[3]) company = inName[3].trim();
    }
    return { line: i + (hasHead ? 2 : 1), full, mobileRaw, company };
  });
}

async function readList({ text, file, filename }) {
  if (file) {
    const buf = Buffer.from(String(file), 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new Error('The file is larger than 5 MB');
    const isXlsx = /\.xlsx$/i.test(filename || '') || buf.subarray(0, 2).toString() === 'PK';
    return toGuests(isXlsx ? await parseXlsx(buf) : parseDelimited(buf.toString('utf8').replace(/^﻿/, '')));
  }
  return toGuests(parseDelimited(String(text || '')));
}

const splitName = (full) => {
  const parts = tidyName(full).split(' ').filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
};

// Adds guests to a group. Returns what was added and, line by line, what was not and why.
async function addGuests(group, entries, user) {
  if (entries.length > MAX_ROWS) throw new Error(`Upload at most ${MAX_ROWS} guests at a time`);
  const existing = await Guest.find({ group: group._id, removedAt: { $exists: false } }, 'mobile').lean();
  if (existing.length + entries.length > MAX_GUESTS) throw new Error(`A group can have at most ${MAX_GUESTS} guests`);
  const seen = new Set(existing.map((g) => g.mobile).filter(Boolean));
  const mobiles = entries.map((e) => normalizeMobile(e.mobileRaw)).filter(Boolean);
  const blocked = new Set((await Block.find({ mobile: { $in: mobiles }, active: true }, 'mobile').lean()).map((b) => b.mobile));

  const skipped = [];
  const warnings = [];
  const docs = [];
  for (const e of entries) {
    if (!e.full) { skipped.push({ line: e.line, name: '', reason: 'No name' }); continue; }
    if (!NAME_RE.test(e.full)) { skipped.push({ line: e.line, name: e.full, reason: 'The name has characters that are not letters' }); continue; }
    let mobile = e.mobileRaw ? normalizeMobile(e.mobileRaw) : null;
    if (e.mobileRaw && !mobile) { warnings.push({ line: e.line, name: e.full, reason: `Added without the mobile: "${e.mobileRaw}" is not a valid number` }); mobile = null; }
    if (mobile && blocked.has(mobile)) { skipped.push({ line: e.line, name: e.full, reason: 'On the blocked list' }); continue; }
    if (mobile && seen.has(mobile)) { skipped.push({ line: e.line, name: e.full, reason: 'Already on the list (same mobile)' }); continue; }
    if (mobile) seen.add(mobile);
    docs.push({ group: group._id, ...splitName(e.full), mobile: mobile || undefined, company: e.company, code: newCode(), createdBy: user.id });
  }
  // Codes are random; a clash is astronomically unlikely, and the unique index would catch it.
  const added = docs.length ? await Guest.insertMany(docs, { ordered: false }) : [];
  audit(user, 'group.guests_added', { entity: 'Group', entityId: group._id, details: { name: group.name, added: added.length, skipped: skipped.length } });
  return { added: added.length, skipped, warnings };
}

// ---------- At the gate ----------
const dayRange = (g) => (g.startDay === g.endDay ? fmtDay(g.startDay) : `${fmtDay(g.startDay)} to ${fmtDay(g.endDay)}`);
const fmtDay = (ymd) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));

// Lets one guest in at this guard's gate, or says plainly why not.
// result: let_in | reentered | inside | not_today | cancelled | removed | blocked | busy
async function admit(guest, group, user) {
  const name = `${guest.firstName} ${guest.lastName}`.trim();
  const today = siteDay();
  if (guest.removedAt) return { result: 'removed', message: `${name} was taken off the guest list. Check them in as a visitor instead.` };
  if (group.status === 'cancelled') return { result: 'cancelled', message: `${group.name} was cancelled. Do not let guests in on it.` };
  if (today < group.startDay || today > group.endDay) {
    return { result: 'not_today', message: `This pass is for ${dayRange(group)}, not today.` };
  }
  if (guest.mobile && (await Block.exists({ mobile: guest.mobile, active: true }))) {
    audit(user, 'visit.blocked_attempt', { entity: 'Group', entityId: group._id, details: { name, mobile: guest.mobile, via: 'group' } });
    return { result: 'blocked', message: `Do not admit ${name}. This number is on the blocked list. Call your supervisor.` };
  }

  const gate = await passes.gateOf(user.id);
  const now = new Date();
  const current = guest.visit ? await Visit.findById(guest.visit).lean() : null;
  if (current?.status === 'approved') {
    return { result: 'inside', message: `${name} is already inside (pass ${current.dailyNumber}).`, visit: current };
  }
  if (current?.status === 'away' && current.validUntil > now) {
    const v = await Visit.findOneAndUpdate(
      { _id: current._id, status: 'away' },
      { status: 'approved', $push: { movements: passes.movement('in', gate, user, now) } },
      { new: true },
    ).lean();
    if (!v) return { result: 'busy', message: 'Another gate is letting this guest in right now. Try again.' };
    audit(user, 'visit.reentered', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, gate: gate.name, group: group.name } });
    return { result: 'reentered', message: `${name} let in again (pass ${v.dailyNumber}).`, visit: v };
  }
  // Someone with the same number already inside as an ordinary visitor.
  if (guest.mobile && (await Visit.exists({ mobile: guest.mobile, status: 'approved', guest: { $ne: guest._id } }))) {
    return { result: 'inside', message: `${name} is already inside on another visit.` };
  }

  const { day, number } = await nextDailyNumber(now);
  const visit = await Visit.create({
    ref: await nextVisitorRef(),
    firstName: guest.firstName, lastName: guest.lastName, mobile: guest.mobile || undefined,
    company: guest.company || group.name, purpose: group.purpose || group.name,
    host: group.host, status: 'approved', visitDay: today, dailyDay: day, dailyNumber: number,
    decidedAt: now, checkedInAt: now,
    validity: `date:${group.endDay}`, validUntil: passes.endOfSiteDay(group.endDay),
    arrival: { gate: gate.id || undefined, gateName: gate.name, by: user.id, byName: user.fullName },
    movements: [passes.movement('in', gate, user, now)],
    group: group._id, guest: guest._id, createdBy: user.id,
  });
  // Two gates scanning the same pass at once: only the first keeps its visit.
  const claimed = await Guest.findOneAndUpdate(
    { _id: guest._id, visit: guest.visit ?? null },
    { visit: visit._id, ...(guest.arrivedAt ? {} : { arrivedAt: now }) },
    { new: true },
  );
  if (!claimed) {
    await Visit.deleteOne({ _id: visit._id });
    return { result: 'inside', message: `${name} was just let in at another gate.` };
  }
  audit(user, 'visit.approved', { entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, dailyNumber: number, via: 'group', group: group.name, gate: gate.name } });
  return { result: 'let_in', message: `${name} let in (pass ${number}).`, visit: visit.toObject() };
}

module.exports = { MAX_ROWS, MAX_GUESTS, NAME_RE, newCode, showCode, passUrl, readCode, readList, addGuests, splitName, admit, dayRange, parseDelimited, toGuests };
