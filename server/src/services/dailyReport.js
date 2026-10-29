const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { Material, Parcel, Visit } = require('../models');
const passes = require('./passes');
const parcels = require('./parcels');
const settings = require('./settings');
const email = require('./email');
const { siteDay, audit } = require('./core');

// The day's registers: material received, parcels in, parcels out, each entered on that site day.
// Printed on A4 from the console, and emailed as a PDF to the security manager every night after midnight.

async function dayData(day) {
  const createdAt = { $gt: passes.endOfSiteDay(passes.addDays(day, -1)), $lte: passes.endOfSiteDay(day) };
  const [material, parcelsIn, parcelsOut, visits] = await Promise.all([
    Material.find({ direction: 'in', createdAt }).sort({ createdAt: 1 }).populate('approver').lean(),
    Parcel.find({ direction: 'in', createdAt, status: { $ne: 'void' } }).sort({ createdAt: 1 }).populate('host').lean(),
    Parcel.find({ direction: 'out', createdAt, status: { $ne: 'void' } }).sort({ createdAt: 1 }).populate('host').lean(),
    Visit.countDocuments({ visitDay: day, group: { $exists: false } }),
  ]);
  return { material, parcelsIn, parcelsOut, visits };
}

// ---------------------------------------------------------------- the PDF
const time = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' }) : '');
const longDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const num = (n) => (Math.round(n * 1000) / 1000).toLocaleString('en-IN');
const WINE = '#8e1b2d';
// A JPEG the PDF library can draw: it starts right and has a frame header (one cut short on a save would stop the whole report).
function drawable(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  for (let i = 2; i + 3 < buf.length;) {
    if (buf[i] !== 0xff) return false;
    const m = buf[i + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) return i + 9 < buf.length;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return false;
}
// A stored signature as a data URL for the PDF: null if the file is gone, 'bad' if it cannot be drawn.
const jpeg = (file) => {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    return drawable(buf) ? `data:image/jpeg;base64,${buf.toString('base64')}` : 'bad';
  } catch { return null; }
};
// The hotel logos the console prints with: client/dist in the built image, client/public when run from the source.
const logo = (name) => {
  for (const dir of ['dist', 'public']) {
    const f = path.resolve(__dirname, '../../../client', dir, 'brand', name);
    try { if (fs.existsSync(f)) return `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`; } catch { /* next */ }
  }
  return null;
};
const sig = (file) => { const src = jpeg(file); return src === 'bad' ? small('Signed (image unreadable)') : src ? { image: src, fit: [70, 26] } : ''; };
const head = (cols) => cols.map((t) => ({ text: t.toUpperCase(), style: 'th' }));
const small = (t) => ({ text: t || '', style: 'small' });
// A cell of two lines: the main value, and a smaller one under it.
const two = (main, sub) => ({ stack: [main, small(sub)] });

function materialRows(list) {
  return list.map((m, i) => {
    const ee = passes.entryExit(m);
    const goods = (m.items || []).map((it) => `${it.name}: ${num(it.qty)} ${it.unit}${it.acceptedQty != null && it.acceptedQty < it.qty ? ` (kept ${num(it.acceptedQty)}, back ${num(it.qty - it.acceptedQty)})` : ''}`).join('\n');
    const party = m.party?.company || m.party?.name || '';
    const person = [m.party?.company ? m.party?.name : '', m.party?.mobile].filter(Boolean).join(' · ');
    const docs = [m.docs?.invoice && `Inv ${m.docs.invoice}`, m.docs?.dc && `DC ${m.docs.dc}`].filter(Boolean).join('\n') || 'No invoice';
    const recv = [m.receivedBy?.department || m.department, m.receivedBy?.name].filter(Boolean).join(' · ');
    const out = ee.exit?.at || m.checkedOutAt;
    return [String(i + 1), m.number, two(time(ee.entry?.at || m.createdAt), ee.entry?.gate), two({ text: party, bold: true }, person), goods, docs, recv, sig(m.signature), out ? time(out) : 'Inside', ee.entry?.by || m.createdByName || ''];
  });
}
function parcelInRows(list) {
  return list.map((p, i) => {
    const who = p.host?.fullName ? [p.host.fullName, p.host.unit] : [p.person?.name, p.person?.room];
    return [String(i + 1), p.number, time(p.createdAt), two({ text: p.carrier || '', bold: true }, p.awb), [p.sender?.company, p.sender?.name].filter(Boolean).join(' · '),
      two({ text: who[0] || '', bold: true }, [...new Set([who[1], p.department].filter(Boolean))].join(' · ')), `${p.pieces}`, p.handover?.to ? `${p.handover.to}\n${time(p.handover.at)}` : statusWord(p), sig(p.signature), p.createdByName || ''];
  });
}
function parcelOutRows(list) {
  return list.map((p, i) => {
    const from = p.host?.fullName || p.person?.name || p.department || '';
    return [String(i + 1), p.number, time(p.createdAt), from, two({ text: p.addressee || '', bold: true }, p.address), two({ text: p.carrier || '', bold: true }, p.awb), `${p.pieces}`,
      p.handover?.to ? `${p.handover.to}\n${time(p.handover.at)}` : statusWord(p), sig(p.signature), p.createdByName || ''];
  });
}
const statusWord = (p) => parcels.STATUS_LABEL[p.status] || p.status;

function table(title, cols, widths, rows, empty) {
  return [
    { text: title, style: 'h2' },
    rows.length
      ? { table: { headerRows: 1, widths, body: [head(cols), ...rows], dontBreakRows: true }, layout: { hLineColor: '#cccccc', vLineColor: '#cccccc', fillColor: (r) => (r === 0 ? '#f1e6e8' : null), paddingTop: () => 3, paddingBottom: () => 3 } }
      : { text: empty, style: 'empty' },
  ];
}

async function pdf(day, data, siteName) {
  const PdfPrinter = require('pdfmake');
  const printer = new PdfPrinter({ Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } });
  const kept = data.material.filter((m) => m.takenBack).length;
  const inside = data.material.filter((m) => m.status === 'received').length;
  const handed = data.parcelsIn.filter((p) => ['collected', 'forwarded'].includes(p.status)).length;
  const logos = [logo('stregis-print.png'), logo('marquis-print.png')].filter(Boolean);
  const stat = (n, label) => ({ stack: [{ text: String(n), style: 'statN' }, { text: label, style: 'small' }], margin: [0, 0, 18, 0] });
  const doc = {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [28, 28, 28, 34],
    defaultStyle: { font: 'Helvetica', fontSize: 8, lineHeight: 1.2 },
    footer: (page, pages) => ({ columns: [{ text: `${siteName} · Daily gate report · ${longDay(day)}`, style: 'small' }, { text: `Page ${page} of ${pages}`, alignment: 'right', style: 'small' }], margin: [28, 8, 28, 0] }),
    content: [
      { columns: [
        logos.length ? { columns: logos.map((l) => ({ image: l, height: 30, width: 70 })), columnGap: 10, width: 'auto' } : { text: '' },
        { stack: [{ text: 'Daily gate report', style: 'h1' }, { text: siteName, style: 'small' }], margin: [14, 0, 0, 0] },
        { stack: [{ text: longDay(day), bold: true, fontSize: 11, alignment: 'right' }, { text: `Sent ${new Date().toLocaleString('en-IN', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} by the GateSmartX server`, style: 'small', alignment: 'right' }] },
      ] },
      { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 786, y2: 4, lineWidth: 1.2, lineColor: WINE }], margin: [0, 4, 0, 8] },
      { columns: [stat(data.visits, 'visitors'), stat(data.material.length, 'material entries'), stat(kept, 'part taken back'), stat(inside, 'vendors still inside'), stat(data.parcelsIn.length, 'parcels in'), stat(handed, 'handed over'), stat(data.parcelsOut.length, 'parcels out')], margin: [0, 0, 0, 6] },
      ...table('Material received', ['#', 'Entry', 'In', 'Supplier / person', 'Goods and quantity', 'Invoice / challan', 'For / received by', 'Signature', 'Out', 'Guard'],
        [14, 48, 46, 110, '*', 70, 80, 74, 36, 60], materialRows(data.material), 'No material was received on this day.'),
      ...table('Parcels in', ['#', 'No.', 'Time', 'Courier / AWB', 'From', 'For', 'Pcs', 'Handed to', 'Signature', 'Guard'],
        [14, 52, 40, 90, 100, '*', 24, 80, 74, 60], parcelInRows(data.parcelsIn), 'No parcels came in on this day.'),
      ...table('Parcels out', ['#', 'No.', 'Booked', 'From', 'To', 'Courier / AWB', 'Pcs', 'Picked up by', 'Signature', 'Guard'],
        [14, 52, 40, 90, '*', 90, 24, 80, 74, 60], parcelOutRows(data.parcelsOut), 'No parcels went out on this day.'),
    ],
    styles: {
      h1: { fontSize: 15, bold: true }, h2: { fontSize: 11, bold: true, color: WINE, margin: [0, 10, 0, 4] },
      th: { fontSize: 7, bold: true, color: '#444444' }, small: { fontSize: 7, color: '#555555' }, statN: { fontSize: 15, bold: true, color: WINE },
      empty: { fontSize: 9, color: '#555555', margin: [0, 2, 0, 4] },
    },
  };
  return new Promise((resolve, reject) => {
    const d = printer.createPdfKitDocument(doc);
    const chunks = [];
    d.on('data', (c) => chunks.push(c));
    d.on('end', () => resolve(Buffer.concat(chunks)));
    d.on('error', reject);
    d.end();
  });
}

// ---------------------------------------------------------------- sending
// The report for `day` to every address in Settings. Returns { sent, to } or throws with a plain reason.
async function send(day, { actor } = {}) {
  const s = await settings.get();
  const to = s.dailyReportTo || [];
  if (!email.enabled()) throw Object.assign(new Error('Email is not set up on this server'), { status: 409 });
  if (!to.length) throw Object.assign(new Error('Add an email address for the daily report in Settings first'), { status: 400 });
  const data = await dayData(day);
  const file = await pdf(day, data, s.siteName || config.siteName);
  const subject = `Daily gate report: ${longDay(day)}`;
  const summary = `Visitors ${data.visits} · material entries ${data.material.length} · parcels in ${data.parcelsIn.length} · parcels out ${data.parcelsOut.length}`;
  const mail = email.noticeEmail({ headline: subject, rows: [['Site', s.siteName || config.siteName], ['Summary', summary]], note: 'The full report is attached as a PDF, ready to print for the file.' });
  await email.send(to, subject, mail.html, mail.text, [{ filename: `Daily gate report ${day}.pdf`, content: file }]);
  audit(actor || { label: 'system' }, 'report.emailed', { details: { day, to: to.length, material: data.material.length, parcelsIn: data.parcelsIn.length, parcelsOut: data.parcelsOut.length } });
  return { sent: to.length, to };
}

// Every night after 00:05 site time, yesterday's report goes out once. A server that was off at midnight sends it
// when it starts again (yesterday's only). A failed send is tried again every 30 minutes.
let lastTry = 0;
let busy = false;
async function nightly(now = new Date()) {
  if (busy || Date.now() - lastTry < 30 * 60e3) return;
  const s = await settings.get();
  if (!s.dailyReportTo?.length || !email.enabled()) return;
  const [hh, mm] = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':').map(Number);
  if (hh === 0 && mm < 5) return; // entries made just before midnight are saved first
  const yesterday = passes.addDays(siteDay(now), -1);
  if ((s.dailyReportSentFor || '') >= yesterday) return;
  busy = true;
  lastTry = Date.now();
  try {
    await send(yesterday);
    await settings.update({ dailyReportSentFor: yesterday });
  } catch (err) {
    console.error('[daily report]', err.message);
  } finally {
    busy = false;
  }
}
// Tests start from a clean slate.
nightly.reset = () => { lastTry = 0; busy = false; };

module.exports = { dayData, pdf, send, nightly };
