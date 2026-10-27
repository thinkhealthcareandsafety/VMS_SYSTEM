const crypto = require('node:crypto');
const mongoose = require('mongoose');

const { Schema } = mongoose;
const opts = { timestamps: true, versionKey: false };

const userSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  fullName: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['guard', 'admin', 'superadmin'], required: true }, // superadmin = admin + the full (unmasked) Aadhaar
  gate: { type: Schema.Types.ObjectId, ref: 'Gate' },  // where this person checks visitors in and out; none = the site's first gate
  active: { type: Boolean, default: true },
  sessionVersion: { type: Number, default: 0 },   // bumped on password change: signs out every other device
  lastLoginAt: { type: Date },
}, opts);

// An entry point: main entrance, staff entrance, receiving gate... Switched off, never deleted, so history keeps its name.
const gateSchema = new Schema({
  name: { type: String, required: true, trim: true },
  active: { type: Boolean, default: true },
}, opts);

// One entry or exit. Gate and guard names are copied in, so renaming either later never rewrites history.
const movementSchema = new Schema({
  kind: { type: String, enum: ['in', 'out'], required: true },
  at: { type: Date, required: true },
  gate: { type: Schema.Types.ObjectId, ref: 'Gate' },
  gateName: { type: String, default: '' },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  byName: { type: String, default: '' },
}, { _id: false });

const hostSchema = new Schema({
  fullName: { type: String, required: true, trim: true, index: true },
  unit: { type: String, required: true, trim: true },      // flat / room / department
  mobile: { type: String, required: true, trim: true },    // E.164, e.g. +919876543210
  email: { type: String, trim: true, lowercase: true },
  active: { type: Boolean, default: true },
  telegramChatId: { type: String },          // set when the host taps their connect link; approvals then arrive in Telegram
  telegramLinkHash: { type: String },        // one-time connect code (hashed) and its expiry
  telegramLinkExpires: { type: Date },
}, opts);
hostSchema.index({ fullName: 'text', unit: 'text' });

// A pass code: 8 characters without look-alikes (no 0/O, 1/I/L), printed as a QR and as K7M2-9QXP. Random, so a pass
// cannot be guessed from another; the same alphabet as event passes, so one scanner reads both.
const PASS_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newPassCode = () => Array.from(crypto.randomBytes(8)).map((b) => PASS_ALPHABET[b % PASS_ALPHABET.length]).join('');

const visitSchema = new Schema({
  ref: { type: String, required: true, unique: true },      // permanent visitor ID, e.g. V-000123
  passCode: { type: String, default: newPassCode },          // on the printed pass: scanned at any gate to let out or back in
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required() { return !this.group; }, trim: true, default: '' },  // group guests may have one name
  mobile: { type: String, required() { return !this.group; } },  // group guests may come without a number
  email: { type: String, trim: true, lowercase: true },           // optional
  gender: { type: String, enum: ['male', 'female', 'other'] },  // chosen by the guard; absent on visits from before the field existed
  company: { type: String, required: true, trim: true },
  purpose: { type: String, trim: true, default: '' },
  host: { type: Schema.Types.ObjectId, ref: 'Host', required: true },
  status: {
    type: String, required: true, index: true,
    // approved = inside. away = left on a pass that is still valid (multi-day): any gate can let them in again.
    enum: ['pending', 'approved', 'away', 'rejected', 'expired', 'cancelled', 'checked_out', 'force_checked_out'],
  },
  visitDay: { type: String, required: true, index: true },  // YYYY-MM-DD, site timezone
  dailyDay: { type: String },                                // day the pass number belongs to
  dailyNumber: { type: Number },                             // 1,2,3... resets each day
  photoPath: { type: String },
  idImagePath: { type: String },                             // MASKED Aadhaar image only
  idMaskMethod: { type: String },                            // auto | already | guide | none, + "+manual" if the guard blacked out more
  idType: { type: String, enum: ['aadhaar', 'pan', 'dl', 'passport', 'voter', 'other'] }, // absent on visits from before the choice existed (all Aadhaar)
  idTypeOther: { type: String },                             // what "other" was, as typed by the guard
  idCheck: {                                                 // the card against the typed name and gender, read on the guard's device; advice only
    status: { type: String, enum: ['match', 'partial', 'mismatch', 'unread'] },
    source: { type: String, enum: ['qr', 'ocr'] },             // Aadhaar Secure QR, or the printed text
    nameScore: { type: Number },
    gender: { type: String, enum: ['match', 'mismatch'] },
    tamper: { type: Boolean },                               // the QR's last 4 digits differ from the printed number
  },
  idImagePurgedAt: { type: Date },
  idFullPath: { type: String },                             // FULL Aadhaar image, AES-256-GCM encrypted (services/vault); Super Admin only
  // Live photo vs the face on the Aadhaar card, compared on the guard's device. Only the score is kept, never a face template.
  // Advisory: it helps the guard look twice, it never admits or refuses anyone.
  mobileVerified: { type: String, enum: ['otp', 'expected', 'returning', 'skipped'] }, // how the number was checked; absent = not checked
  mobileVerifiedAt: { type: Date },
  faceMatchScore: { type: Number, min: 0, max: 100 },
  faceMatchStatus: { type: String, enum: ['scored', 'no_card_face', 'no_photo_face', 'unavailable'] },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  decidedAt: { type: Date },
  checkedInAt: { type: Date },
  checkedOutAt: { type: Date },
  checkedOutBy: { type: Schema.Types.ObjectId, ref: 'User' },
  forceReason: { type: String, trim: true },
  // How long the pass lasts ('8h', '10d', 'date:2026-10-30'); validUntil is fixed when the visitor is let in.
  validity: { type: String },
  validUntil: { type: Date },
  // The hotel's numbered lanyard card handed over at the gate ("01 Visitor" / "01 Vendor"); the printed pass slip is
  // stuck on its back. Collected again at exit. One card can be with only one person at a time.
  card: { no: { type: String }, type: { type: String, enum: ['visitor', 'vendor'] } },
  // Each time the pass was made longer at the gate or in the console: from when, to when, by whom.
  extensions: { type: [{ _id: false, at: Date, from: Date, to: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String, note: String }], default: undefined },
  // Still inside after the pass ended: the guard acknowledges it; an hour later it is escalated. Cleared when extended.
  overstay: { ackAt: Date, ackBy: { type: Schema.Types.ObjectId, ref: 'User' }, ackByName: String, ackNote: String, escalatedAt: Date },
  arrival: { gate: { type: Schema.Types.ObjectId, ref: 'Gate' }, gateName: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String },
  movements: { type: [movementSchema], default: undefined },
  // Let in as a guest of a group (event, wedding, conference): no host request, no photo or ID by default.
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true },
  guest: { type: Schema.Types.ObjectId, ref: 'Guest' },
}, opts);
// one pass number per day
visitSchema.index({ dailyDay: 1, dailyNumber: 1 }, { unique: true, partialFilterExpression: { dailyNumber: { $exists: true } } });
visitSchema.index({ status: 1, checkedOutAt: 1 });
visitSchema.index({ mobile: 1, status: 1 }); // duplicate check-in guard
visitSchema.index({ status: 1, validUntil: 1 }); // passes that expire while the holder is away
visitSchema.index({ passCode: 1 }, { unique: true, sparse: true });
visitSchema.index({ 'card.no': 1, status: 1 }, { partialFilterExpression: { 'card.no': { $exists: true } } }); // who holds card 07 now

const approvalTokenSchema = new Schema({
  visit: { type: Schema.Types.ObjectId, ref: 'Visit', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: true },
  usedAt: { type: Date },
}, opts);

// Atomic counters: daily pass sequence + permanent visitor refs
const counterSchema = new Schema({
  _id: { type: String, required: true },   // e.g. "pass:2026-10-06", "visitor"
  seq: { type: Number, default: 0 },
}, { versionKey: false });

const outboxSchema = new Schema({
  kind: { type: String, enum: ['sms', 'telegram', 'whatsapp', 'print', 'email'], required: true, index: true },
  visit: { type: Schema.Types.ObjectId, ref: 'Visit' },          // a visitor's approval request...
  material: { type: Schema.Types.ObjectId, ref: 'Material' },    // ...or a material gate pass approval...
  parcel: { type: Schema.Types.ObjectId, ref: 'Parcel' },        // ...or a courier notice
  emergency: { type: Schema.Types.ObjectId, ref: 'Emergency', index: true }, // ...or an emergency message (vars.n: which one)
  status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued', index: true },
  to: { type: String },              // sms, whatsapp: mobile number; telegram: chat id
  body: { type: String },            // message text
  vars: { type: Schema.Types.Mixed },  // sms: { name, company, link, minutes } for template-based gateways; whatsapp: { fallback }
  attempts: { type: Number, default: 0 },
  lastError: { type: String },
  nextAttemptAt: { type: Date, default: () => new Date() },
  providerRef: { type: String },
  sentAt: { type: Date },
  retiredAt: { type: Date },          // telegram: buttons replaced with the outcome
}, opts);

// Site settings an admin can change without a developer (one document, _id "site").
const settingSchema = new Schema({
  _id: { type: String },
  siteName: { type: String, trim: true },     // printed on passes, the approval page and downloads
  gateName: { type: String, trim: true },     // shown on the guard desk
  idRetentionDays: { type: Number },          // masked Aadhaar images are deleted after this many days
  escalateTo: { mobiles: [String], emails: [String] }, // told when a visitor is still inside an hour after the pass ended
  assemblyPoint: { type: String, trim: true },
  purposes: { type: [String], default: undefined },  // the purpose buttons at check-in, in order
  durations: { type: [String], default: undefined }, // the pass lengths offered: "2h", "today", "10d"...
  lanyardCards: { type: Boolean },              // ask for the hotel's lanyard card number at check-in
  notifyCheckout: { type: Boolean },            // tell the host when their visitor leaves
  license: { type: String },                    // the GateSmartX licence key (services/license)
  licenseSeenAt: { type: Date },                // the latest time the server has seen: a clock turned back shows here  // where people gather in an evacuation; filled into the emergency messages
  otpMode: { type: String, enum: ['off', 'optional', 'required'] }, // mobile verification by OTP at check-in
  fullIdCapture: { type: Boolean },           // keep the full Aadhaar (encrypted) for the Super Admin; only a Super Admin changes it
}, { versionKey: false, timestamps: true });

// A group of expected guests (wedding, banquet, conference). Creating it is the approval: each guest on the list
// is let in at any gate by scanning their pass or by name, between the first and the last day.
const groupSchema = new Schema({
  name: { type: String, required: true, trim: true },
  host: { type: Schema.Types.ObjectId, ref: 'Host', required: true },   // the person responsible
  purpose: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },                      // shown to the guard at the gate
  startDay: { type: String, required: true, index: true },              // YYYY-MM-DD, site time
  endDay: { type: String, required: true, index: true },
  allowWalkIns: { type: Boolean, default: false },                      // the guard may add someone not on the list
  // One link the host shares (a family WhatsApp group, an email): guests add themselves and get their own pass.
  joinCode: { type: String, unique: true, sparse: true },
  joinOpen: { type: Boolean, default: false },
  joinLimit: { type: Number, default: 0 },                              // most guests who may add themselves
  joinCount: { type: Number, default: 0 },                              // places taken through the link (reserved atomically)
  status: { type: String, enum: ['active', 'cancelled'], default: 'active', index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, opts);

// One person on a group's list. `code` is their pass (QR and typed); `visit` is their latest visit.
const guestSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, trim: true, default: '' },
  mobile: { type: String },
  company: { type: String, trim: true, default: '' },
  code: { type: String, required: true, unique: true },
  visit: { type: Schema.Types.ObjectId, ref: 'Visit' },
  arrivedAt: { type: Date },                       // first time let in
  addedAtGate: { type: Boolean, default: false },  // walk-in added by a guard
  selfRegistered: { type: Boolean, default: false }, // added themselves through the group's link
  removedAt: { type: Date },                       // taken off the list: the pass no longer works
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, opts);
guestSchema.index({ group: 1, mobile: 1 });

// ---------- Material: gate passes (RGP / NRGP) and gate entries ----------
const materialItemSchema = new Schema({
  code: { type: String, trim: true, default: '' },     // item no. on the invoice or challan
  name: { type: String, required: true, trim: true },
  qty: { type: Number, required: true, min: 0 },
  acceptedQty: { type: Number },                       // inward, at the vendor's checkout: what the hotel kept; the rest went back
  unit: { type: String, default: 'nos' },
  serial: { type: String, trim: true, default: '' },   // serial number or asset tag
  returnedQty: { type: Number, default: 0 },           // returnable passes: how much has come back
});
const materialReturnSchema = new Schema({
  at: { type: Date, required: true },
  items: [{ _id: false, item: Schema.Types.ObjectId, qty: Number }],
  gateName: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String, note: String,
}, { _id: false });
// direction out: kind returnable (RGP: comes back by returnBy) or non_returnable (NRGP), approved by a head first.
// direction in:  kind delivery (supplier goods) or returnable_in (contractor tools that must leave again).
// The site uses the inward register only (outward gate passes live in the hotel's own gate pass system):
// a delivery is received -> checked_out, when the vendor leaves with the stamped invoice and anything not accepted.
const materialSchema = new Schema({
  number: { type: String, required: true, unique: true },   // OUT-000123 / IN-000123
  direction: { type: String, enum: ['in', 'out'], required: true, index: true },
  kind: { type: String, enum: ['returnable', 'non_returnable', 'delivery', 'returnable_in'], required: true },
  // out: pending -> approved -> out -> (returnable) partly_returned -> returned; or rejected / cancelled
  // in:  received -> handed_over (delivery) or closed (returnable_in taken back out)
  status: { type: String, required: true, index: true,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'out', 'partly_returned', 'returned', 'received', 'handed_over', 'closed', 'checked_out'] },
  items: { type: [materialItemSchema], validate: (v) => v.length > 0 },
  party: {
    name: { type: String, trim: true, default: '' }, company: { type: String, trim: true, default: '' }, mobile: String,
    address: { type: String, trim: true, default: '' }, gstin: { type: String, trim: true, default: '' },
  },
  department: { type: String, trim: true, default: '' },
  purpose: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },
  vehicle: { number: { type: String, default: '' }, driver: { type: String, default: '' }, driverMobile: String, transporter: { type: String, default: '' } },
  docs: { dc: { type: String, default: '' }, invoice: { type: String, default: '' }, po: { type: String, default: '' }, eway: { type: String, default: '' } },
  returnBy: { type: String },                                  // YYYY-MM-DD, returnable passes
  approver: { type: Schema.Types.ObjectId, ref: 'Host' },     // the head who approves an outward pass
  decidedAt: Date, decidedBy: String, decisionNote: String,
  returns: { type: [materialReturnSchema], default: undefined },
  handedTo: String, handedAt: Date,
  movements: { type: [movementSchema], default: undefined },
  photos: { type: [String], default: undefined },     // the material
  docPhotos: { type: [String], default: undefined },  // invoice / challan as it arrived
  exitPhotos: { type: [String], default: undefined }, // invoice as stamped by the hotel, at the vendor's checkout
  receivedBy: { name: { type: String, default: '' }, department: { type: String, default: '' } },
  cardNo: { type: String },                           // the hotel's vendor lanyard card given at the gate, collected at checkout
  exitNote: String,
  checkedOutAt: Date,
  takenBack: { type: Boolean, default: false },       // the vendor took some of it back (accepted less than delivered)
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: String,
}, opts);
materialSchema.index({ kind: 1, status: 1, returnBy: 1 });
materialSchema.index({ createdAt: -1 });

// ---------- Couriers: parcels in (to a person) and out (dispatched) ----------
// In:  received at the gate; the recipient sees the photos and accepts or declines it on WhatsApp / Telegram / the link
//      -> collected (handed over against a name, mobile number and photo) | forwarded | returned (refused, sent back).
//      Parcels from before used a pickup code (codeSealed); those records keep it.
// Out: booked (a department hands it to security) -> dispatched (the courier's agent took it).
const parcelSchema = new Schema({
  number: { type: String, required: true, unique: true },     // PCL-000123
  direction: { type: String, enum: ['in', 'out'], required: true, index: true },
  status: { type: String, required: true, index: true, enum: ['received', 'collected', 'forwarded', 'returned', 'booked', 'dispatched', 'void'] },
  carrier: { type: String, trim: true, default: '' },
  awb: { type: String, trim: true, default: '', index: true },  // tracking / airway bill number
  pieces: { type: Number, default: 1, min: 1 },
  type: { type: String, enum: ['document', 'parcel', 'large', 'perishable', 'confidential'], default: 'parcel' },
  sender: { name: { type: String, trim: true, default: '' }, company: { type: String, trim: true, default: '' } },
  // The person it is for (in) or from (out): a host, or anyone else (a hotel guest, a staff member) by name.
  host: { type: Schema.Types.ObjectId, ref: 'Host' },
  person: { name: { type: String, trim: true, default: '' }, room: { type: String, trim: true, default: '' }, mobile: String },
  department: { type: String, trim: true, default: '' },
  addressee: { type: String, trim: true, default: '' },        // out: the name on the courier
  address: { type: String, trim: true, default: '' },          // out: where it is going
  note: { type: String, trim: true, default: '' },
  photos: { type: [String], default: undefined },
  // The pickup code: sealed (services/vault), never shown to staff; only the recipient's notice carries it.
  codeSealed: String,
  codeTries: { type: Number, default: 0 },
  notifiedVia: String, notifiedAt: Date, reminders: { type: Number, default: 0 }, lastReminderAt: Date,
  response: { kind: { type: String, enum: ['accepted', 'declined'] }, at: Date, by: String, via: String },
  handover: {
    at: Date, to: String, mobile: String, how: { type: String, enum: ['code', 'override', 'forward', 'return', 'dispatch', 'handover'] },
    reason: String, gateName: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, byName: String,
  },
  movements: { type: [movementSchema], default: undefined },
  handoverPhotos: { type: [String], default: undefined },     // the person receiving it (in) or the courier picker (out)
  signature: String,                                          // their signature, drawn on the tablet (a JPEG file)
  ackSentAt: Date,                                            // the recipient was told who collected it
  voidReason: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: String,
}, opts);
parcelSchema.index({ direction: 1, status: 1, createdAt: -1 });

// Single-use links for decisions other than a visitor's (a material pass, a parcel's accept / decline). Only a hash is kept.
const actionTokenSchema = new Schema({
  kind: { type: String, enum: ['material', 'parcel'], required: true },
  ref: { type: Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: Date,
}, { versionKey: false, timestamps: true });

// An emergency (fire, evacuation, drill...): started by its first message, ended by "All clear" or by hand.
// `people` is everyone inside when it started, for the roll call at the assembly point. Names are copied in,
// so the roll call stays exactly as it was even after people check out.
const emergencySchema = new Schema({
  status: { type: String, enum: ['active', 'closed'], default: 'active' },
  kind: { type: String, default: 'custom' },        // the first message's template
  title: { type: String, default: '' },
  people: [{
    _id: false, visit: { type: Schema.Types.ObjectId, ref: 'Visit' }, name: String, company: String, pass: Number,
    host: String, hostUnit: String, mobile: String, group: String, card: String, safeAt: Date, safeBy: String,
  }],
  messages: [{
    _id: false, at: Date, template: String, title: String, text: String, audience: { type: String, enum: ['visitors', 'hosts', 'both'] },
    allHosts: Boolean, by: String, visitors: Number, hosts: Number,
  }],
  startedBy: { type: Schema.Types.ObjectId, ref: 'User' }, startedByName: String, gateName: String,
  closedAt: Date, closedByName: String,
}, opts);
// Only one emergency at a time: two gates pressing Send together join the same one.
emergencySchema.index({ status: 1 }, { name: 'one_active_emergency', unique: true, partialFilterExpression: { status: 'active' } });

// A visitor the admin expects: at the gate they are let in without waiting for the host.
const inviteSchema = new Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  mobile: { type: String, required: true, index: true },
  company: { type: String, trim: true, default: '' },
  purpose: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },
  host: { type: Schema.Types.ObjectId, ref: 'Host', required: true },
  day: { type: String, required: true, index: true },        // YYYY-MM-DD, site time
  status: { type: String, enum: ['expected', 'arrived', 'cancelled'], default: 'expected', index: true },
  visit: { type: Schema.Types.ObjectId, ref: 'Visit' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, opts);

// People who must not be let in. Checked on every lookup and every check-in.
const blockSchema = new Schema({
  mobile: { type: String, required: true, index: true },
  name: { type: String, trim: true, default: '' },
  reason: { type: String, required: true, trim: true },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  removedAt: { type: Date },
}, opts);

// One-time codes for verifying a visitor's mobile number. Only a hash of the code is kept; documents expire after two days.
const otpSchema = new Schema({
  mobile: { type: String, required: true, index: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  verifiedAt: { type: Date },
  usedAt: { type: Date },            // a check-in counted this verification; the next visit asks again
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: () => new Date(), index: { expireAfterSeconds: 2 * 86400 } },
}, { versionKey: false });

// Append-only audit trail. The API never updates or deletes these documents.
const auditSchema = new Schema({
  at: { type: Date, default: () => new Date(), index: true },
  actor: { type: String, required: true },  // username, "host:<id>", or "system"
  actorRole: { type: String },
  action: { type: String, required: true, index: true },
  entity: { type: String },
  entityId: { type: String },
  details: { type: Schema.Types.Mixed },
  ip: { type: String },
}, { versionKey: false });

module.exports = {
  newPassCode,
  User: mongoose.model('User', userSchema),
  Gate: mongoose.model('Gate', gateSchema),
  Group: mongoose.model('Group', groupSchema),
  Material: mongoose.model('Material', materialSchema),
  Parcel: mongoose.model('Parcel', parcelSchema),
  Emergency: mongoose.model('Emergency', emergencySchema),
  ActionToken: mongoose.model('ActionToken', actionTokenSchema),
  Guest: mongoose.model('Guest', guestSchema),
  Host: mongoose.model('Host', hostSchema),
  Visit: mongoose.model('Visit', visitSchema),
  ApprovalToken: mongoose.model('ApprovalToken', approvalTokenSchema),
  Counter: mongoose.model('Counter', counterSchema),
  Outbox: mongoose.model('Outbox', outboxSchema),
  Audit: mongoose.model('Audit', auditSchema),
  Setting: mongoose.model('Setting', settingSchema),
  Invite: mongoose.model('Invite', inviteSchema),
  Block: mongoose.model('Block', blockSchema),
  Otp: mongoose.model('Otp', otpSchema),
};
