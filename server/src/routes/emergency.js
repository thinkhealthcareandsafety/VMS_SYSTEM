const express = require('express');
const mongoose = require('mongoose');
const { requireRole } = require('../middleware/auth');
const { Emergency, Host } = require('../models');
const settings = require('../services/settings');
const passes = require('../services/passes');
const emergency = require('../services/emergency');
const { audit } = require('../services/core');

// Emergency messages and the roll call. Guards and admins both: in an emergency the first person to see it acts.
const router = express.Router();
router.use(requireRole('guard', 'admin'));
const isId = (v) => mongoose.isValidObjectId(v);

const activeOne = () => Emergency.findOne({ status: 'active' }).sort({ createdAt: -1 }).lean();
async function full(em) {
  return em ? emergency.view(em, await emergency.delivery(em._id)) : null;
}

// What the send screen needs: the templates with the site's words filled in, how many each choice reaches,
// which channels work, and the emergency going on (if any).
router.get('/setup', async (req, res) => {
  const visits = await emergency.inside();
  const [theirs, all, active] = await Promise.all([emergency.audienceOf(visits), Host.countDocuments({ active: true }), activeOne()]);
  res.json({
    templates: await emergency.filledTemplates(),
    maxText: emergency.MAX_TEXT,
    assemblyPoint: (await settings.get()).assemblyPoint || '',
    counts: { inside: visits.length, visitors: theirs.visitorMobiles.length, theirHosts: theirs.hosts.length, allHosts: all },
    channels: emergency.channels(),
    active: await full(active),
  });
});

router.get('/active', async (req, res) => {
  res.json({ active: await full(await activeOne()) });
});

router.post('/send', async (req, res) => {
  const b = req.body || {};
  const gate = await passes.gateOf(req.user.id);
  const r = await emergency.send({ template: b.template, text: b.text, audience: b.audience, allHosts: b.allHosts === true }, req.user, gate);
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.started) audit(req.user, 'emergency.started', { entity: 'Emergency', entityId: r.em._id, details: { kind: r.em.kind, inside: r.em.people.length, gate: gate.name }, ip: req.ip });
  audit(req.user, 'emergency.message', { entity: 'Emergency', entityId: r.em._id, details: { template: b.template, audience: b.audience, visitors: r.counts.visitors, hosts: r.counts.hosts, messages: r.counts.jobs }, ip: req.ip });
  if (r.closed) audit(req.user, 'emergency.closed', { entity: 'Emergency', entityId: r.em._id, details: { via: 'all clear', safe: r.em.people.filter((p) => p.safeAt).length, total: r.em.people.length }, ip: req.ip });
  res.status(201).json({ ...(await full(r.em.toObject())), sent: r.counts });
});

// Roll call at the assembly point: this person is safe (or not, if ticked by mistake).
router.post('/:id/safe', async (req, res) => {
  if (!isId(req.params.id) || !isId(req.body?.visitId)) return res.status(404).json({ error: 'Not found' });
  const safe = req.body.safe !== false;
  const em = await Emergency.findOneAndUpdate(
    { _id: req.params.id, status: 'active', 'people.visit': req.body.visitId },
    safe ? { $set: { 'people.$.safeAt': new Date(), 'people.$.safeBy': req.user.fullName } } : { $unset: { 'people.$.safeAt': 1, 'people.$.safeBy': 1 } },
    { new: true },
  ).lean();
  if (!em) return res.status(409).json({ error: 'This emergency has ended, or the person is not on its list' });
  const p = em.people.find((x) => String(x.visit) === String(req.body.visitId));
  audit(req.user, safe ? 'emergency.safe' : 'emergency.unsafe', { entity: 'Emergency', entityId: em._id, details: { name: p?.name }, ip: req.ip });
  res.json(emergency.view(em));
});

// Ended without sending "All clear" (it was a false alarm and everyone was told by other means).
router.post('/:id/close', async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const em = await Emergency.findOneAndUpdate({ _id: req.params.id, status: 'active' }, { status: 'closed', closedAt: new Date(), closedByName: req.user.fullName }, { new: true }).lean();
  if (!em) return res.status(409).json({ error: 'This emergency has already ended' });
  audit(req.user, 'emergency.closed', { entity: 'Emergency', entityId: em._id, details: { via: 'ended by hand', safe: em.people.filter((p) => p.safeAt).length, total: em.people.length }, ip: req.ip });
  res.json(await full(em));
});

// Past emergencies, newest first, for the record (drills included).
router.get('/history', requireRole('admin'), async (req, res) => {
  const rows = await Emergency.find().sort({ createdAt: -1 }).limit(30).lean();
  res.json({ rows: rows.map((e) => ({ id: String(e._id), title: e.title, status: e.status, startedAt: e.createdAt, startedBy: e.startedByName, closedAt: e.closedAt || null, total: e.people.length, safe: e.people.filter((p) => p.safeAt).length, messages: e.messages.length })) });
});

router.get('/:id', requireRole('admin'), async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const em = await Emergency.findById(req.params.id).lean();
  if (!em) return res.status(404).json({ error: 'Not found' });
  res.json(await full(em));
});

module.exports = router;
