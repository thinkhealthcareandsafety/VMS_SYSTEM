const mongoose = require('mongoose');

const { Schema } = mongoose;
const opts = { timestamps: true, versionKey: false };

const userSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  fullName: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['guard', 'admin'], required: true },
  active: { type: Boolean, default: true },
  sessionVersion: { type: Number, default: 0 },   // bumped on password change: signs out every other device
  lastLoginAt: { type: Date },
}, opts);

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

const visitSchema = new Schema({
  ref: { type: String, required: true, unique: true },      // permanent visitor ID, e.g. V-000123
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  mobile: { type: String, required: true },
  company: { type: String, required: true, trim: true },
  purpose: { type: String, trim: true, default: '' },
  host: { type: Schema.Types.ObjectId, ref: 'Host', required: true },
  status: {
    type: String, required: true, index: true,
    enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'checked_out', 'force_checked_out'],
  },
  visitDay: { type: String, required: true, index: true },  // YYYY-MM-DD, site timezone
  dailyDay: { type: String },                                // day the pass number belongs to
  dailyNumber: { type: Number },                             // 1,2,3... resets each day
  photoPath: { type: String },
  idImagePath: { type: String },                             // MASKED Aadhaar image only
  idImagePurgedAt: { type: Date },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  decidedAt: { type: Date },
  checkedInAt: { type: Date },
  checkedOutAt: { type: Date },
  checkedOutBy: { type: Schema.Types.ObjectId, ref: 'User' },
  forceReason: { type: String, trim: true },
}, opts);
// one pass number per day
visitSchema.index({ dailyDay: 1, dailyNumber: 1 }, { unique: true, partialFilterExpression: { dailyNumber: { $exists: true } } });
visitSchema.index({ status: 1, checkedOutAt: 1 });
visitSchema.index({ mobile: 1, status: 1 }); // duplicate check-in guard

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
  kind: { type: String, enum: ['sms', 'telegram', 'print'], required: true, index: true },
  visit: { type: Schema.Types.ObjectId, ref: 'Visit', required: true },
  status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued', index: true },
  to: { type: String },              // sms: mobile number; telegram: chat id
  body: { type: String },            // message text
  attempts: { type: Number, default: 0 },
  lastError: { type: String },
  nextAttemptAt: { type: Date, default: () => new Date() },
  providerRef: { type: String },
  sentAt: { type: Date },
}, opts);

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
  User: mongoose.model('User', userSchema),
  Host: mongoose.model('Host', hostSchema),
  Visit: mongoose.model('Visit', visitSchema),
  ApprovalToken: mongoose.model('ApprovalToken', approvalTokenSchema),
  Counter: mongoose.model('Counter', counterSchema),
  Outbox: mongoose.model('Outbox', outboxSchema),
  Audit: mongoose.model('Audit', auditSchema),
};
