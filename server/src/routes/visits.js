const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const mongoose = require('mongoose');
const config = require('../config');
const { requireRole, isAdmin } = require('../middleware/auth');
const { Visit, Host, ApprovalToken, Outbox, Invite, Block, Otp, Group } = require('../models');
const settings = require('../services/settings');
const messaging = require('../services/messaging');
const { retireTelegram } = require('../services/notify');
const telegram = require('../services/telegram');
const whatsapp = require('../services/whatsapp');
const email = require('../services/email');
const passes = require('../services/passes');
const gate = require('../services/gate');
const vault = require('../services/vault');
const overstay = require('../services/overstay');
const departure = require('../services/departure');
const invites = require('../services/invites');
const { requireLicense } = require('../services/license');
const { approveByPhone } = require('../services/decision');
const { writeDurable, oneAtATime, siteDay, nextVisitorRef, nextDailyNumber, audit, sha256, normalizeMobile, cleanText, tidyName, decodeJpeg } = require('../services/core');

const router = express.Router();
const NAME_RE = /^[\p{L} .'-]{1,60}$/u;
const MAX_PHOTO = 2 * 1024 * 1024;
const MAX_ID = 3 * 1024 * 1024;
const GENDERS = ['male', 'female', 'other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isId = (v) => mongoose.isValidObjectId(v);

// The face comparison is made on the guard's device; the server only keeps the score (0-100) and why there is none.
function faceMatchFrom(b) {
  const score = Number(b.faceMatchScore);
  if (b.faceMatch === 'scored' && Number.isFinite(score) && score >= 0 && score <= 100) return { faceMatchStatus: 'scored', faceMatchScore: Math.round(score) };
  if (['no_card_face', 'no_photo_face', 'unavailable'].includes(b.faceMatch)) return { faceMatchStatus: b.faceMatch };
  return {};
}
const ID_TYPES = ['aadhaar', 'pan', 'dl', 'passport', 'voter', 'other'];
const ID_TYPE_LABEL = { aadhaar: 'Aadhaar', pan: 'PAN card', dl: 'Driving licence', passport: 'Passport', voter: 'Voter ID', other: 'Other ID' };
// The ID check is made on the guard's device too; only the outcome is kept.
function idCheckFrom(c) {
  if (!c || typeof c !== 'object' || !['match', 'partial', 'mismatch', 'unread'].includes(c.status)) return undefined;
  const score = Number(c.nameScore);
  return {
    status: c.status,
    ...(['qr', 'ocr'].includes(c.source) ? { source: c.source } : {}),
    ...(c.nameScore != null && Number.isFinite(score) && score >= 0 && score <= 100 ? { nameScore: Math.round(score) } : {}),
    ...(['match', 'mismatch'].includes(c.gender) ? { gender: c.gender } : {}),
    ...(c.tamper === true ? { tamper: true } : {}),
  };
}
const idLabelOf = (v) => (v.idType === 'other' && v.idTypeOther ? v.idTypeOther : ID_TYPE_LABEL[v.idType || 'aadhaar']);
const publicVisit = (v, host, withMobile = false) => ({
  id: String(v._id),
  ref: v.ref,
  firstName: v.firstName,
  lastName: v.lastName,
  company: v.company,
  purpose: v.purpose,
  gender: v.gender ?? null,
  status: v.status,
  dailyNumber: v.dailyNumber ?? null,
  dailyDay: v.dailyDay ?? null,
  host: host ? { id: String(host._id), name: host.fullName, unit: host.unit, ...(withMobile ? { mobile: host.mobile } : {}) } : null,
  ...(withMobile ? { mobile: v.mobile, email: v.email ?? null, visitDay: v.visitDay, createdAt: v.createdAt, checkedOutAt: v.checkedOutAt, forceReason: v.forceReason, hasIdImage: Boolean(v.idImagePath), hasFullId: Boolean(v.idFullPath), idMaskMethod: v.idMaskMethod, idType: v.idType || 'aadhaar', idLabel: idLabelOf(v), idCheck: v.idCheck?.status ? v.idCheck : null, idOverride: v.idOverride?.reason ? v.idOverride : null, faceMatchScore: v.faceMatchScore ?? null, faceMatchStatus: v.faceMatchStatus ?? null, mobileVerified: v.mobileVerified ?? null } : {}),
  decidedAt: v.decidedAt,
  phoneApproval: v.phoneApproval ? { byName: v.phoneApproval.byName, note: v.phoneApproval.note } : null,
  checkedOutAt: v.checkedOutAt,
  validity: passes.validityLabel(v.validity),
  validUntil: v.validUntil ?? null,
  card: v.card?.no ? { no: v.card.no, type: v.card.type || 'visitor' } : null,
  extensions: (v.extensions || []).map((x) => ({ at: x.at, from: x.from, to: x.to, by: x.byName, note: x.note || '' })),
  overstay: v.overstay?.ackAt || v.overstay?.escalatedAt ? { ackAt: v.overstay.ackAt || null, ackBy: v.overstay.ackByName || '', ackNote: v.overstay.ackNote || '', escalatedAt: v.overstay.escalatedAt || null } : null,
  groupId: v.group ? String(v.group) : null,
  passCode: ['approved', 'away'].includes(v.status) ? v.passCode ?? null : null,
  ...passes.entryExit(v),
  ...(withMobile ? { movements: (v.movements || []).map((m) => ({ kind: m.kind, at: m.at, gate: m.gateName, by: m.byName })) } : {}),
});

// The lanyard card from the request: null when none was given, { error } when the number is not a card number.
function readCard(b) {
  const no = passes.cardNo(b.cardNo);
  if (!no) return null;
  if (!passes.CARD_RE.test(no)) return { error: 'Card number: letters and digits only, as printed on the card' };
  return { no, type: b.cardType === 'vendor' ? 'vendor' : 'visitor' };
}
// Who has this card now (waiting or inside), as a sentence for the guard; null when it is free.
async function cardHolder(card, exceptId) {
  const v = await Visit.findOne({ 'card.no': card.no, 'card.type': card.type, status: { $in: ['pending', 'approved'] }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }, 'firstName lastName status').lean();
  return v ? `${passes.CARD_LABEL[card.type]} card ${card.no} is with ${v.firstName} ${v.lastName} (${v.status === 'pending' ? 'waiting for the host' : 'inside'}). Give another card, or check them out first.` : null;
}

// Creates a fresh single-use approval link and queues the SMS to the host.
async function issueApprovalLink(visit, host, visitorName, company) {
  await ApprovalToken.updateMany({ visit: visit._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  const raw = crypto.randomBytes(18).toString('base64url'); // 24 characters: short enough for an SMS link variable
  const expiresAt = new Date(Date.now() + config.approvalTtlMinutes * 60e3);
  await ApprovalToken.create({ visit: visit._id, tokenHash: sha256(raw), expiresAt });
  const link = `${config.appBaseUrl}/approve/${raw}`;           // Telegram
  const smsLink = `${config.appBaseUrl}/approve?${raw}`;        // SMS: operators need the changing part right after a "?"
  const from = /^(personal|self|none|na|n\/a|-)$/i.test(company) ? '' : ` from ${company}`;
  const body = `${visitorName}${from} is at the gate to meet you. Approve or reject: ${smsLink} Link valid ${config.approvalTtlMinutes} min. -${config.sms.senderId}`;
  const tg = config.approvalChannel !== 'sms' && telegram.enabled() && host.telegramChatId
    ? { kind: 'telegram', to: String(host.telegramChatId), body: `🚪 ${visitorName}${from} is at the gate to meet you.\nPass asked for: ${passes.validityLabel(visit.validity)}\n\nSee their photo and details: ${link}\nValid for ${config.approvalTtlMinutes} min.` }
    : null;
  const sms = { kind: 'sms', to: host.mobile, body, vars: { name: visitorName, company: /^(personal|self|none|na|n\/a|-)$/i.test(company) ? 'Personal' : company, link: smsLink, token: raw, minutes: config.approvalTtlMinutes } };
  // Email goes as well as the main channel, to every host with an address: free, and reaches people away from their phone.
  if (email.enabled() && host.email) {
    const mail = email.approvalEmail({
      headline: `${visitorName}${from} is at the gate to meet you.`,
      rows: [['Purpose', visit.purpose], ['Pass asked for', passes.validityLabel(visit.validity)]],
      link, button: 'See them and approve', valid: `${config.approvalTtlMinutes} minutes`,
    });
    await Outbox.create({ kind: 'email', visit: visit._id, to: host.email, body: mail.text, vars: { subject: `Visitor at the gate: ${visitorName}`, html: mail.html } });
  }
  if (config.approvalChannel !== 'sms' && whatsapp.enabled() && host.mobile) {
    // If WhatsApp can't deliver, the request goes by Telegram, or by SMS once a real SMS gateway is on.
    const fallback = tg || (config.sms.driver !== 'console' ? sms : null);
    const purpose = visit.purpose ? `\nPurpose: ${visit.purpose}` : '';
    const text = `🚪 *${visitorName}*${from} is at the gate to meet you.${purpose}\nPass asked for: *${passes.validityLabel(visit.validity)}*\n\nTap a button below, or see their details: ${link}`;
    await Outbox.create({ kind: 'whatsapp', visit: visit._id, to: host.mobile, body: text, vars: { fallback } });
    return null;
  }
  await Outbox.create({ ...(tg || sms), visit: visit._id });
  return whatsappShare(host, `${visitorName}${from}`, link);
}

// A wa.me link that opens WhatsApp on the gate device with the host's number and the request already typed.
function whatsappShare(host, who, link) {
  if (!config.approvalWhatsapp || !host.mobile) return null;
  const text = `🚪 *Visitor at the gate*\n\n${who} is at the gate to meet you.\n\nSee their photo and approve or decline:\n${link}\n\nValid for ${config.approvalTtlMinutes} min.`;
  return `https://wa.me/${host.mobile.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

async function saveFile(folder, buf) {
  const file = path.join(path.resolve(config.uploadDir, folder), `${crypto.randomUUID()}.jpg`);
  await writeDurable(file, buf);
  return file;
}

const activeVisitFor = (mobile) => Visit.findOne({
  mobile, $or: [{ status: { $in: ['pending', 'approved'] } }, { status: 'away', validUntil: { $gt: new Date() } }],
}).sort({ createdAt: -1 }).populate('host').lean();
const fmtUntil = (d) => new Intl.DateTimeFormat('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
const activeSummary = (v) => ({
  id: String(v._id), ref: v.ref, status: v.status, name: `${v.firstName} ${v.lastName}`,
  dailyNumber: v.dailyNumber ?? null, host: v.host ? { name: v.host.fullName, unit: v.host.unit } : null, validUntil: v.validUntil ?? null,
});
const activeMessage = (v) => {
  const name = `${v.firstName} ${v.lastName}`;
  if (v.status === 'away') return `${name} has a valid pass (no. ${v.dailyNumber}) until ${fmtUntil(v.validUntil)}. Let them in again; no new approval is needed.`;
  if (v.status === 'approved') return `${name} is already inside with pass ${v.dailyNumber} (meeting ${v.host?.fullName}). Check them out before registering a new visit.`;
  return `${name} is already waiting for ${v.host?.fullName} to approve. Resend or cancel that request instead.`;
};

// Someone the admin blocked. Checked on lookup (red warning) and again on check-in (refused).
const blockFor = (mobile) => Block.findOne({ mobile, active: true }).lean();
const blockMessage = (b) => `Do not admit${b.name ? ` ${b.name}` : ''}. This number is on the blocked list: ${b.reason}. Call your supervisor.`;
// An expected visitor for today: let in without waiting for the host.
const inviteFor = (mobile) => invites.forMobile(mobile);

// Message status per visit, in one query: the latest phone message (SMS, Telegram or WhatsApp),
// except that a failed one whose email went through reads 'email', so the guard is not told nobody was reached.
async function smsStatusFor(visitIds) {
  if (!visitIds.length) return new Map();
  const rows = await Outbox.aggregate([
    { $match: { kind: { $in: ['sms', 'telegram', 'whatsapp', 'email'] }, visit: { $in: visitIds } } },
    { $sort: { _id: -1 } },
    { $group: { _id: { visit: '$visit', mail: { $eq: ['$kind', 'email'] } }, status: { $first: '$status' } } },
  ]);
  const phone = new Map(), mail = new Map();
  for (const r of rows) (r._id.mail ? mail : phone).set(String(r._id.visit), r.status);
  const out = new Map();
  for (const [id, status] of phone) out.set(id, { status: status === 'failed' && mail.get(id) === 'sent' ? 'email' : status });
  for (const [id, status] of mail) if (!phone.has(id)) out.set(id, { status: status === 'sent' ? 'email' : status });
  return out;
}

// ---------- Mobile verification by OTP ----------
const OTP_RESEND_GAP = 30e3;     // seconds between two codes to the same number
const OTP_PER_HOUR = 5;          // codes per number per hour
const OTP_MAX_TRIES = 3;
const OTP_FRESH_MS = 3 * 3600e3; // a verification holds until a check-in uses it, at most this long, so a slow form still goes through
const otpHash = (mobile, code) => sha256(`otp:${mobile}:${code}:${process.env.JWT_SECRET}`);

// Was this number already proven recently? Returns how, or null. `invite`: an expected visitor the admin entered.
async function verifiedVia(mobile, invite) {
  if (invite) return 'expected'; // the host gave us this number
  if (await Otp.exists({ mobile, verifiedAt: { $gte: new Date(Date.now() - OTP_FRESH_MS) }, usedAt: { $exists: false } })) return 'otp';
  if (config.otp.verifiedDays > 0) {
    const since = new Date(Date.now() - config.otp.verifiedDays * 86400e3);
    if (await Visit.exists({ mobile, mobileVerified: 'otp', mobileVerifiedAt: { $gte: since } })) return 'returning';
  }
  return null;
}

router.post('/otp/send', requireRole('guard', 'admin'), async (req, res) => {
  const { otpMode } = await settings.get();
  if (otpMode === 'off') return res.status(409).json({ error: 'Number verification is switched off in Settings' });
  const mobile = normalizeMobile(req.body?.mobile);
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number' });

  const last = await Otp.findOne({ mobile }).sort({ createdAt: -1 }).lean();
  if (last && Date.now() - new Date(last.createdAt).getTime() < OTP_RESEND_GAP) {
    return res.status(429).json({ code: 'otp_recent', error: 'A code was just sent. Wait a few seconds before sending another.' });
  }
  if (await Otp.countDocuments({ mobile, createdAt: { $gte: new Date(Date.now() - 3600e3) } }) >= OTP_PER_HOUR) {
    return res.status(429).json({ code: 'otp_recent', error: 'Too many codes for this number. Try again in an hour, or skip verification.' });
  }
  if (await Otp.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400e3) } }) >= config.otp.dailyLimit) {
    return res.status(429).json({ error: 'The daily SMS limit was reached. Skip verification for now and tell your admin.' });
  }

  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const doc = await Otp.create({ mobile, codeHash: otpHash(mobile, code), expiresAt: new Date(Date.now() + config.otp.expiryMinutes * 60e3), createdBy: req.user.id });
  try {
    await messaging.sendOtp(mobile, code);
  } catch (err) {
    await Otp.deleteOne({ _id: doc._id });
    console.error('[otp] send failed:', err.message);
    audit(req.user, 'otp.failed', { details: { mobile, error: err.message }, ip: req.ip });
    return res.status(502).json({ error: 'The SMS could not be sent. Try again, or skip verification.' });
  }
  audit(req.user, 'otp.sent', { details: { mobile }, ip: req.ip });
  res.json({ ok: true, expiresInSeconds: config.otp.expiryMinutes * 60, live: messaging.otpLive() });
});

router.post('/otp/verify', requireRole('guard', 'admin'), async (req, res) => {
  const mobile = normalizeMobile(req.body?.mobile);
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!mobile || code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit code' });
  const open = await Otp.findOne({ mobile, verifiedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!open) return res.status(400).json({ error: 'That code has expired. Send a new one.' });
  const tried = await Otp.findOneAndUpdate({ _id: open._id, attempts: { $lt: OTP_MAX_TRIES } }, { $inc: { attempts: 1 } }, { new: true });
  if (!tried) return res.status(429).json({ error: 'Too many wrong tries. Send a new code.' });
  const a = Buffer.from(otpHash(mobile, code));
  const b = Buffer.from(tried.codeHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    audit(req.user, 'otp.wrong', { details: { mobile }, ip: req.ip });
    return res.status(400).json({ error: 'Wrong code', triesLeft: OTP_MAX_TRIES - tried.attempts });
  }
  tried.verifiedAt = new Date();
  await tried.save();
  audit(req.user, 'otp.verified', { details: { mobile }, ip: req.ip });
  res.json({ verified: true });
});

// Guard check-in: captures visitor, masked Aadhaar, host, and sends approval SMS.
router.post('/', requireRole('guard', 'admin'), requireLicense, (req, res) => oneAtATime(`visit:${normalizeMobile(req.body?.mobile) || ''}`, () => checkIn(req, res)));
async function checkIn(req, res) {
  const b = req.body || {};
  const firstName = tidyName(cleanText(b.firstName, 60));
  const lastName = tidyName(cleanText(b.lastName, 60));
  const company = cleanText(b.company, 100);
  const purpose = cleanText(b.purpose, 100);
  const mobile = normalizeMobile(b.mobile);
  const gender = GENDERS.includes(b.gender) ? b.gender : '';
  const email = cleanText(b.email, 120).toLowerCase();

  if (!NAME_RE.test(firstName) || !NAME_RE.test(lastName)) return res.status(400).json({ error: 'Enter a valid first and last name' });
  if (!gender) return res.status(400).json({ error: 'Choose male, female or other' });
  if (!mobile) return res.status(400).json({ error: 'Enter a valid mobile number' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email address does not look right. Fix it or leave it empty.' });
  if (!company) return res.status(400).json({ error: 'Company / source is required' });
  if (!isId(b.hostId)) return res.status(400).json({ error: 'Select whom to meet' });
  const pass = passes.parseValidity(b);
  if (pass.error) return res.status(400).json({ error: pass.error });
  const card = readCard(b);
  if (card?.error) return res.status(400).json({ error: card.error });

  const host = await Host.findOne({ _id: b.hostId, active: true }).lean();
  if (!host) return res.status(400).json({ error: 'Selected host is not active' });

  const blocked = await blockFor(mobile);
  if (blocked) {
    audit(req.user, 'visit.blocked_attempt', { details: { mobile, name: `${firstName} ${lastName}`, reason: blocked.reason }, ip: req.ip });
    return res.status(403).json({ code: 'blocked', error: blockMessage(blocked) });
  }

  // One person cannot be inside, or waiting at the gate, twice.
  const active = await activeVisitFor(mobile);
  if (active) return res.status(409).json({ code: 'already_active', error: activeMessage(active), visit: activeSummary(active) });
  const holder = card && await cardHolder(card);
  if (holder) return res.status(409).json({ code: 'card_in_use', error: holder });

  // Expected visitor: only honoured for the same person, today, meeting the same host.
  let invite = null;
  if (b.inviteId) {
    invite = isId(b.inviteId) ? await Invite.findOne({ _id: b.inviteId, ...invites.openOn(siteDay()) }).lean() : null;
    if (!invite || invite.mobile !== mobile || String(invite.host) !== String(host._id)) {
      return res.status(409).json({ error: 'That expected-visitor entry no longer matches. Send the request to the host instead.' });
    }
  }

  // Mobile verification: off, optional (the guard may verify or skip) or required (only an admin may skip).
  const { otpMode } = await settings.get();
  let mobileCheck = {};
  if (otpMode !== 'off') {
    const via = await verifiedVia(mobile, invite);
    if (via) mobileCheck = { mobileVerified: via, mobileVerifiedAt: new Date() };
    else if (b.otpSkip === true && (otpMode === 'optional' || isAdmin(req.user))) mobileCheck = { mobileVerified: 'skipped', mobileVerifiedAt: new Date() };
    else if (otpMode === 'required') return res.status(409).json({ code: 'verify_required', error: 'Verify the visitor’s mobile number with the code first.' });
  }

  const photo = decodeJpeg(b.photo, MAX_PHOTO);
  if (!photo) return res.status(400).json({ error: 'A live photo is required' });
  const idImage = decodeJpeg(b.idImage, MAX_ID);
  if (!idImage) return res.status(400).json({ error: 'A photo of the ID card is required' });
  const idType = ID_TYPES.includes(b.idType) ? b.idType : 'aadhaar';
  const idTypeOther = idType === 'other' ? cleanText(b.idTypeOther, 40) || undefined : undefined;
  const idMaskMethod = ['auto', 'already', 'guide', 'none'].some((m) => b.idMask === m || b.idMask === `${m}+manual`) ? b.idMask : undefined;
  // The full card, for the Super Admin only. Optional: older screens do not send it, and it never blocks a visitor.
  const idFull = (await settings.get()).fullIdCapture && idType === 'aadhaar' && b.idImageFull ? decodeJpeg(b.idImageFull, MAX_ID) : null;

  let photoPath, idPath, idFullPath;
  try {
    photoPath = await saveFile('photos', photo);
    idPath = await saveFile('id-masked', idImage);
    if (idFull) idFullPath = await vault.store(idFull);
    const visitorName = `${firstName} ${lastName}`;
    const gate = await passes.gateOf(req.user.id);
    const visit = await Visit.create({
      ref: await nextVisitorRef(),
      firstName, lastName, mobile, email: email || undefined, gender, company, purpose,
      host: host._id,
      status: 'pending',
      visitDay: siteDay(),
      photoPath, idImagePath: idPath, idFullPath, idMaskMethod, idType, idTypeOther, idCheck: idCheckFrom(b.idCheck),
      ...(cleanText(b.idOverride, 200) ? { idOverride: { reason: cleanText(b.idOverride, 200), byName: req.user.fullName } } : {}),
      ...faceMatchFrom(b), ...mobileCheck,
      validity: pass.validity,
      ...(card ? { card } : {}),
      arrival: { gate: gate.id || undefined, gateName: gate.name, by: req.user.id, byName: req.user.fullName },
      createdBy: req.user.id,
    });
    audit(req.user, 'visit.created', { entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, host: host.fullName, ...(visit.idOverride ? { idOverride: visit.idOverride.reason } : {}), ...(card ? { card: `${passes.CARD_LABEL[card.type]} ${card.no}` } : {}) }, ip: req.ip });
    if (mobileCheck.mobileVerified === 'otp') await Otp.updateMany({ mobile, verifiedAt: { $exists: true }, usedAt: { $exists: false } }, { usedAt: new Date() });

    if (invite) {
      // Claim the invite first, so two guards cannot both use it.
      const claimed = await invites.claim(invite, visit._id);
      if (claimed) {
        const { day, number } = await nextDailyNumber();
        const now = new Date();
        Object.assign(visit, {
          status: 'approved', decidedAt: now, checkedInAt: now, dailyDay: day, dailyNumber: number,
          validUntil: passes.validUntil(visit.validity, now), movements: [passes.movement('in', gate, req.user, now)],
        });
        await visit.save();
        if (config.printer.mode !== 'off') await Outbox.create({ kind: 'print', visit: visit._id });
        audit(req.user, 'visit.approved', { entity: 'Visit', entityId: visit._id, details: { ref: visit.ref, dailyNumber: number, via: 'expected' }, ip: req.ip });
        await invites.tellHostArrived(visit, host, gate?.name).catch((err) => console.error('[expected arrival]', err.message));
        return res.status(201).json({ id: String(visit._id), ref: visit.ref, status: visit.status, dailyNumber: number, validUntil: visit.validUntil, passCode: visit.passCode, card: card || null });
      }
    }
    const share = await issueApprovalLink(visit, host, visitorName, company);
    res.status(201).json({ id: String(visit._id), ref: visit.ref, status: visit.status, whatsapp: share, card: card || null });
  } catch (err) {
    // The files go only when the visit was surely not saved: after a database restart the save can land even though
    // the reply was lost, and that visit must keep its photo and ID.
    const saved = photoPath ? await Visit.exists({ photoPath }).catch(() => true) : false;
    if (!saved) await Promise.all([photoPath, idPath, idFullPath].filter(Boolean).map((p) => fs.rm(p, { force: true })));
    console.error('check-in failed', err);
    res.status(500).json({ error: 'Could not register visitor. Please retry.' });
  }
}

// One scan at any gate: in, out, or a plain reason why not. See services/gate.js.
router.post('/scan', requireRole('guard', 'admin'), async (req, res) => {
  const out = await gate.scan(req.body?.code, req.user, req.ip);
  res.status(out.result === 'unknown' ? 404 : 200).json(out);
});

// A scan made by mistake, taken back within 30 seconds.
router.post('/:id/undo-scan', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id) || !['in', 'out'].includes(req.body?.action)) return res.status(400).json({ error: 'Nothing to undo' });
  const { status, body } = await gate.undo(req.params.id, req.body.action, req.user, req.ip);
  res.status(status).json(body);
});

// Status poll used by the guard screen while waiting for the host.
router.get('/inside', requireRole('guard', 'admin'), async (req, res) => {
  const now = Date.now();
  const [visits, away] = await Promise.all([
    Visit.find({ status: 'approved' }).sort({ decidedAt: 1 }).populate('host').lean(),
    Visit.find({ status: 'away', validUntil: { $gt: new Date(now) } }).sort({ validUntil: 1 }).limit(500).populate('host').lean(),
  ]);
  const admin = isAdmin(req.user);
  const everyone = req.query.all === '1';
  const groupsInside = new Map();
  for (const v of visits) if (v.group) groupsInside.set(String(v.group), (groupsInside.get(String(v.group)) || 0) + 1);
  const groupNames = groupsInside.size ? await Group.find({ _id: { $in: [...groupsInside.keys()] } }, 'name').lean() : [];
  const rows = visits.filter((v) => everyone || !v.group).map((v) => {
    const since = passes.entryExit(v).lastIn?.at || v.decidedAt;
    return {
      ...publicVisit(v, v.host, admin),
      insideMinutes: Math.round((now - new Date(since).getTime()) / 60000),
      passExpired: Boolean(v.validUntil) && new Date(v.validUntil).getTime() < now,
    };
  });
  res.json({
    count: visits.length, visits: rows, staleAfterHours: config.maxInsideHours,
    away: away.filter((v) => everyone || !v.group).map((v) => publicVisit(v, v.host, admin)),
    groups: groupNames.map((g) => ({ id: String(g._id), name: g.name, inside: groupsInside.get(String(g._id)) })),
  });
});

// Returning visitor: last known name/company for a mobile number, to prefill check-in.
router.get('/lookup', requireRole('guard', 'admin'), async (req, res) => {
  const mobile = normalizeMobile(req.query.mobile);
  if (!mobile) return res.json({ found: false });
  const { otpMode } = await settings.get();
  const [last, blocked, invite] = await Promise.all([
    Visit.findOne({ mobile }, 'firstName lastName gender email company createdAt').sort({ createdAt: -1 }).lean(),
    blockFor(mobile),
    inviteFor(mobile),
  ]);
  const visits = last ? await Visit.countDocuments({ mobile }) : 0;
  const active = last ? await activeVisitFor(mobile) : null;
  const otpVia = otpMode === 'off' ? null : await verifiedVia(mobile, invite && invite.host?.active ? invite : null);
  res.json({
    otp: { mode: otpMode, verified: otpVia },
    found: Boolean(last),
    ...(last ? { firstName: last.firstName, lastName: last.lastName, gender: last.gender || null, email: last.email || '', company: last.company, lastVisit: last.createdAt, visits } : {}),
    active: active ? { ...activeSummary(active), message: activeMessage(active) } : null,
    blocked: blocked ? { message: blockMessage(blocked) } : null,
    invite: invite && invite.host?.active ? {
      id: String(invite._id), firstName: invite.firstName, lastName: invite.lastName, company: invite.company, purpose: invite.purpose, note: invite.note,
      host: { id: String(invite.host._id), name: invite.host.fullName, unit: invite.host.unit },
      gate: invite.gate?.name || null, dayOf: invites.dayOf(invite),
      elsewhere: Boolean(invite.gate && String(invite.gate._id) !== String((await passes.gateOf(req.user.id)).id)),
    } : null,
  });
});

// Expected today, for every gate tablet: still to come (the guard's own gate first), and who already came today.
router.get('/expected', requireRole('guard', 'admin'), async (req, res) => {
  const today = siteDay();
  const [mine, open, came] = await Promise.all([
    passes.gateOf(req.user.id),
    Invite.find(invites.openOn(today)).populate('host').populate('gate', 'name').lean(),
    Invite.find({ 'arrivals.day': today }).populate('host').populate('arrivals.visit', 'dailyNumber movements').lean(),
  ]);
  const hostOf = (i) => ({ id: String(i.host._id), name: i.host.fullName, unit: i.host.unit });
  const here = (i) => Boolean(i.gate && mine.id && String(i.gate._id) === String(mine.id));
  const rows = open.filter((i) => i.host?.active !== false && i.host)
    .map((i) => ({
      id: String(i._id), firstName: i.firstName, lastName: i.lastName, mobile: i.mobile, company: i.company, purpose: i.purpose, note: i.note,
      host: hostOf(i), gate: i.gate?.name || null, here: here(i), dayOf: invites.dayOf(i, today),
    }))
    .sort((a, b) => (b.here - a.here) || `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
  const arrived = came.filter((i) => i.host).map((i) => {
    const a = i.arrivals.find((x) => x.day === today);
    const v = a?.visit;
    return {
      id: String(i._id), firstName: i.firstName, lastName: i.lastName, host: hostOf(i), at: a?.at || null,
      visitId: v?._id ? String(v._id) : null, dailyNumber: v?.dailyNumber ?? null, gate: v?.movements?.find((m) => m.kind === 'in')?.gateName || '',
    };
  }).sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ today, gate: mine.name, rows, arrived });
});

// The guard's "waiting for host" tray: everything still undecided, no-replies from the last 30 minutes, and decisions from the last 20,
// so the guard sees each approval or decline land even after moving on to the next visitor.
router.get('/queue', requireRole('guard', 'admin'), async (req, res) => {
  const now = Date.now();
  const visits = await Visit.find({
    $or: [
      { status: 'pending', createdAt: { $gte: new Date(now - 12 * 3600e3) } },
      { status: 'expired', decidedAt: { $gte: new Date(now - 30 * 60e3) } },
      { status: { $in: ['approved', 'rejected'] }, decidedAt: { $gte: new Date(now - 20 * 60e3) } },
    ],
  }).sort({ createdAt: -1 }).limit(40).populate('host').lean();
  const sms = await smsStatusFor(visits.map((v) => v._id));
  res.json({
    rows: visits.map((v) => ({ ...publicVisit(v, v.host), createdAt: v.createdAt, smsStatus: sms.get(String(v._id))?.status || null })),
  });
});

// The lanyard card given at the gate, set or changed after check-in (the guard handed it over once the host said yes).
router.post('/:id/card', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const card = readCard(req.body || {});
  if (card?.error) return res.status(400).json({ error: card.error });
  const holder = card && await cardHolder(card, req.params.id);
  if (holder) return res.status(409).json({ code: 'card_in_use', error: holder });
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['pending', 'approved'] } },
    card ? { $set: { card } } : { $unset: { card: 1 } },
    { new: true },
  ).populate('host').lean();
  if (!v) return res.status(409).json({ error: 'A card can be given only to someone waiting or inside' });
  audit(req.user, 'visit.card_set', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, card: card ? `${passes.CARD_LABEL[card.type]} ${card.no}` : 'none' }, ip: req.ip });
  res.json(publicVisit(v, v.host));
});

// Still inside after the pass ended: the pop-up on the guard desk and the admin console.
router.get('/overstays', requireRole('guard', 'admin'), async (req, res) => {
  res.json({ rows: await overstay.list(), escalateAfterMinutes: overstay.ESCALATE_AFTER_MIN });
});

// The guard has seen it and is on it (calling the host, going to look). Recorded once, with their name.
router.post('/:id/overstay-ack', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const now = new Date();
  const note = cleanText(req.body?.note, 120);
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, ...overstay.query(now), 'overstay.ackAt': { $exists: false } },
    { $set: { 'overstay.ackAt': now, 'overstay.ackBy': req.user.id, 'overstay.ackByName': req.user.fullName, 'overstay.ackNote': note } },
    { new: true },
  ).populate('host').lean();
  if (!v) {
    const cur = await Visit.findById(req.params.id, 'status validUntil overstay').lean();
    if (cur?.overstay?.ackAt && cur.status === 'approved') return res.json({ ok: true, already: true, by: cur.overstay.ackByName });
    return res.status(409).json({ error: 'This visitor is no longer past their pass (checked out or extended).' });
  }
  audit(req.user, 'visit.overstay_acknowledged', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, ...(note ? { note } : {}) }, ip: req.ip });
  res.json({ ok: true, row: overstay.rowOf(v) });
});

// More time on the pass, for someone inside or a pass holder who is out. Anyone past their pass is no longer
// flagged once it is extended. A pass extended to a later day stays open at exit, like any multi-day pass.
router.post('/:id/extend', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const cur = await Visit.findById(req.params.id, 'status validity validUntil ref group').lean();
  if (!cur || !['approved', 'away'].includes(cur.status)) return res.status(409).json({ error: 'Only a visitor inside, or holding a pass, can have it extended' });
  if (cur.group) return res.status(409).json({ error: 'Event passes run for the event’s dates. Change the event instead.' });
  const now = new Date();
  if (cur.status === 'away' && (!cur.validUntil || new Date(cur.validUntil) <= now)) return res.status(409).json({ error: 'This pass has ended. Check the visitor in again for a new pass.' });
  const { until, error } = passes.extendedUntil(cur.validUntil, req.body, now);
  if (error) return res.status(400).json({ error });
  const note = cleanText(req.body?.note, 120);
  const lastDay = siteDay(until);
  const validity = lastDay > siteDay(now) && !passes.staysOpen(cur.validity, until, now) ? `date:${lastDay}` : cur.validity;
  const v = await Visit.findOneAndUpdate(
    { _id: cur._id, status: cur.status, validUntil: cur.validUntil },
    {
      $set: { validUntil: until, validity }, $unset: { overstay: 1 },
      $push: { extensions: { at: now, from: cur.validUntil, to: until, by: req.user.id, byName: req.user.fullName, ...(note ? { note } : {}) } },
    },
    { new: true },
  ).populate('host').lean();
  if (!v) return res.status(409).json({ error: 'This pass just changed. Open it again.' });
  audit(req.user, 'visit.pass_extended', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, from: cur.validUntil, to: until, ...(note ? { note } : {}) }, ip: req.ip });
  res.json(publicVisit(v, v.host));
});

router.get('/:id', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findById(req.params.id).populate('host').lean();
  if (!v) return res.status(404).json({ error: 'Not found' });
  const print = await Outbox.findOne({ kind: 'print', visit: v._id }).sort({ _id: -1 }).lean();
  const sms = (await smsStatusFor([v._id])).get(String(v._id));
  res.json({
    ...publicVisit(v, v.host, isAdmin(req.user)),
    createdAt: v.createdAt,
    printStatus: config.printer.mode === 'off' ? 'off' : print ? print.status : null,
    printError: print?.status === 'failed' ? print.lastError : undefined,
    smsStatus: sms?.status || null,
  });
});

router.get('/:id/photo', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const v = await Visit.findById(req.params.id, 'photoPath').lean();
  if (!v?.photoPath) return res.status(404).end();
  res.type('jpeg').sendFile(path.resolve(v.photoPath));
});

// Admin-only, every view is audited (DPDP accountability).
router.get('/:id/id-image', requireRole('admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const v = await Visit.findById(req.params.id, 'idImagePath ref').lean();
  if (!v?.idImagePath) return res.status(404).json({ error: 'ID image not available (purged or never captured)' });
  audit(req.user, 'id_image.viewed', { entity: 'Visit', entityId: req.params.id, details: { ref: v.ref }, ip: req.ip });
  res.type('jpeg').sendFile(path.resolve(v.idImagePath));
});

// The full Aadhaar: Super Admin only, decrypted for this response alone, never cached; every view is audited.
router.get('/:id/id-image-full', requireRole('superadmin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).end();
  const v = await Visit.findById(req.params.id, 'idFullPath ref').lean();
  if (!v?.idFullPath) return res.status(404).json({ error: 'No full Aadhaar kept for this visit (not captured, or deleted after retention)' });
  let img;
  try { img = await vault.read(v.idFullPath); } catch { return res.status(410).json({ error: 'The full Aadhaar could not be opened' }); }
  audit(req.user, 'id_image_full.viewed', { entity: 'Visit', entityId: req.params.id, details: { ref: v.ref }, ip: req.ip });
  res.set('Cache-Control', 'no-store').type('jpeg').send(img);
});

// Re-sends the approval SMS (host missed it, or link expired).
// No reply to the message, but the host said yes on the phone: the guard lets the visitor in and notes who said so.
router.post('/:id/approve-by-phone', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { status, body } = await approveByPhone(req.params.id, req.user, req.body?.note, req.ip);
  res.status(status).json(body);
});

router.post('/:id/resend', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findById(req.params.id).populate('host');
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (!['pending', 'expired'].includes(v.status)) {
    const why = { approved: 'This visitor is already approved', rejected: 'The host declined this visit', cancelled: 'This visit was cancelled' }[v.status] || 'This visit is already closed';
    return res.status(409).json({ error: why });
  }
  const last = await Outbox.findOne({ kind: { $in: ['sms', 'telegram', 'whatsapp'] }, visit: v._id }).sort({ _id: -1 }).lean();
  if (last && Date.now() - new Date(last.createdAt).getTime() < 30e3) {
    return res.status(429).json({ error: 'A request was just sent. Give the host a few seconds before sending another.' });
  }
  await retireTelegram(v._id, `↻ ${v.firstName} ${v.lastName}: a newer request was sent below.`);
  v.status = 'pending';
  v.decidedAt = undefined;
  await v.save();
  const share = await issueApprovalLink(v, v.host, `${v.firstName} ${v.lastName}`, v.company);
  audit(req.user, 'visit.resent', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.json({ ok: true, status: v.status, whatsapp: share });
});

// The guard printed the pass (browser print, any printer). Recorded for the audit trail; it is also the handover.
router.post('/:id/printed', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findOne({ _id: req.params.id, status: { $in: ['approved', 'away', 'checked_out', 'force_checked_out'] } }, 'ref').lean();
  if (!v) return res.status(409).json({ error: 'No pass has been issued for this visit' });
  audit(req.user, 'pass.printed', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.json({ ok: true });
});

// Visitor gave up before the host answered. Closes the approval link too.
router.post('/:id/cancel', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['pending', 'expired'] } },
    { status: 'cancelled', decidedAt: new Date() },
    { new: true },
  );
  if (!v) return res.status(409).json({ error: 'Only a visit still waiting for the host can be cancelled' });
  await ApprovalToken.updateMany({ visit: v._id, usedAt: { $exists: false } }, { usedAt: new Date() });
  audit(req.user, 'visit.cancelled', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  await retireTelegram(v._id, `🚫 ${v.firstName} ${v.lastName}: cancelled by the security desk.\nThe visitor left before you replied. Nothing more to do.`);
  res.json({ ok: true, status: v.status });
});

// Guard marks departure, at whichever gate they work. A pass that outlives today stays open ("away"), so the
// visitor can come back on it; `final: true` closes it anyway (the visitor is done for good).
router.post('/:id/checkout', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const now = new Date();
  const current = await Visit.findOne({ _id: req.params.id, status: 'approved' }, 'validity validUntil card').lean();
  if (!current) return res.status(409).json({ error: 'Visitor is not currently inside' });
  const gate = await passes.gateOf(req.user.id);
  const keep = req.body?.final !== true && passes.staysOpen(current.validity, current.validUntil, now);
  const exit = passes.movement('out', gate, req.user, now);
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: 'approved' },
    keep
      ? { status: 'away', $push: { movements: exit } }
      : { status: 'checked_out', checkedOutAt: now, checkedOutBy: req.user.id, $push: { movements: exit } },
    { new: true },
  );
  if (!v) return res.status(409).json({ error: 'Visitor is not currently inside' });
  audit(req.user, keep ? 'visit.went_out' : 'visit.checked_out', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, gate: gate.name }, ip: req.ip });
  await departure.tellHost(v, { at: now, gateName: gate.name }).catch((e) => console.error('[checkout] host message:', e.message));
  res.json({ ok: true, status: v.status, checkedOutAt: v.checkedOutAt, validUntil: v.validUntil, card: current.card?.no ? current.card : null });
});

// A pass holder comes back while the pass is valid: in again at this gate, no new approval.
router.post('/:id/reenter', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const current = await Visit.findById(req.params.id, 'status validUntil mobile ref').lean();
  if (!current) return res.status(404).json({ error: 'Not found' });
  if (current.status === 'approved') return res.status(409).json({ error: 'This visitor is already inside' });
  if (current.status !== 'away' || !current.validUntil || new Date(current.validUntil) <= new Date()) {
    return res.status(409).json({ error: 'This pass has ended. Check the visitor in again for a new pass.' });
  }
  const blocked = await blockFor(current.mobile);
  if (blocked) {
    audit(req.user, 'visit.blocked_attempt', { entity: 'Visit', entityId: current._id, details: { ref: current.ref, reason: blocked.reason, via: 'reentry' }, ip: req.ip });
    return res.status(403).json({ code: 'blocked', error: blockMessage(blocked) });
  }
  const now = new Date();
  const gate = await passes.gateOf(req.user.id);
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: 'away', validUntil: { $gt: now } },
    { status: 'approved', $unset: { card: 1 }, $push: { movements: passes.movement('in', gate, req.user, now) } }, // the card came back at exit
    { new: true },
  ).populate('host').lean();
  if (!v) return res.status(409).json({ error: 'This pass has ended. Check the visitor in again for a new pass.' });
  audit(req.user, 'visit.reentered', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, gate: gate.name }, ip: req.ip });
  res.json(publicVisit(v, v.host));
});

// The pass holder is done before the pass runs out (contract finished): close it so it cannot be used again.
router.post('/:id/end-pass', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const current = await Visit.findOne({ _id: req.params.id, status: 'away' }, 'movements').lean();
  if (!current) return res.status(409).json({ error: 'Only a pass holder who is outside can have the pass ended' });
  const lastOut = passes.entryExit(current).exit?.at || new Date();
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: 'away' },
    { status: 'checked_out', checkedOutAt: lastOut, checkedOutBy: req.user.id },
    { new: true },
  );
  if (!v) return res.status(409).json({ error: 'Only a pass holder who is outside can have the pass ended' });
  audit(req.user, 'visit.pass_ended', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.json({ ok: true, status: v.status });
});

// Admin force checkout when guard forgot to mark exit. Reason is mandatory.
router.post('/:id/force-checkout', requireRole('admin'), async (req, res) => {
  const reason = cleanText(req.body?.reason, 200);
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters)' });
  const v = await Visit.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['approved', 'away'] } },
    { status: 'force_checked_out', checkedOutAt: new Date(), checkedOutBy: req.user.id, forceReason: reason },
    { new: true },
  );
  if (!v) return res.status(409).json({ error: 'Visitor is not currently inside or holding a pass' });
  audit(req.user, 'visit.force_checked_out', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, reason }, ip: req.ip });
  await departure.tellHost(v, { at: v.checkedOutAt, by: 'security' }).catch((e) => console.error('[checkout] host message:', e.message));
  res.json({ ok: true, status: v.status });
});

// End-of-day sweep: several visitors the gate missed, checked out together with one reason, each audited on its own.
router.post('/force-checkout', requireRole('admin'), async (req, res) => {
  const reason = cleanText(req.body?.reason, 200);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(isId).slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Pick the visitors to check out' });
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters)' });
  const now = new Date();
  const due = await Visit.find({ _id: { $in: ids }, status: { $in: ['approved', 'away'] } }, '_id ref').lean();
  let done = 0;
  for (const v of due) {
    const out = await Visit.findOneAndUpdate(
      { _id: v._id, status: { $in: ['approved', 'away'] } },
      { status: 'force_checked_out', checkedOutAt: now, checkedOutBy: req.user.id, forceReason: reason },
      { new: true },
    );
    if (out) {
      done += 1;
      await departure.tellHost(out, { at: now, by: 'security' }).catch((e) => console.error('[checkout] host message:', e.message));
      audit(req.user, 'visit.force_checked_out', { entity: 'Visit', entityId: v._id, details: { ref: v.ref, reason, bulk: true }, ip: req.ip });
    }
  }
  res.json({ ok: true, checkedOut: done, skipped: ids.length - done });
});

// Re-queues the sticker print (printer jammed / offline).
router.post('/:id/reprint', requireRole('guard', 'admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (config.printer.mode === 'off') return res.status(409).json({ error: 'No sticker printer is connected. Write the pass number on the visitor slip.' });
  const v = await Visit.findById(req.params.id, 'status ref').lean();
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (!['approved', 'away', 'checked_out', 'force_checked_out'].includes(v.status)) return res.status(409).json({ error: 'Pass not issued yet' });
  await Outbox.create({ kind: 'print', visit: v._id });
  audit(req.user, 'sticker.reprint_requested', { entity: 'Visit', entityId: v._id, details: { ref: v.ref }, ip: req.ip });
  res.status(202).json({ ok: true });
});

module.exports = router;
