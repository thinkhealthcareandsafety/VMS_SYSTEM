const ExcelJS = require('exceljs');
const config = require('../config');

// Builds every download format from one normalised record per visit, so the Excel sheet, the
// printable report and the folder of photos can never disagree with each other.

const STATUS_LABEL = {
  pending: 'Awaiting host', approved: 'On premises', rejected: 'Declined', expired: 'No response',
  cancelled: 'Cancelled', checked_out: 'Checked out', force_checked_out: 'Checked out by admin',
};

// Wall-clock time at the site, as a Date whose UTC fields hold the local time. Excel has no time
// zones, so this is what makes "9:05" in the sheet mean 9:05 at the gate.
function wall(d) {
  if (!d) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}
const dayDate = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`) : null);
const human = (d, withTime = true) => (d ? new Intl.DateTimeFormat('en-IN', {
  timeZone: config.timezone, day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
}).format(new Date(d)) : '');
const duration = (m) => (m == null ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const safe = (s) => String(s ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60) || 'visitor';
// Indian numbers as "98765 43210": readable, and Excel keeps them as text instead of 9.88E+09.
const localMobile = (m = '') => (m.startsWith(config.defaultCountryCode)
  ? m.slice(config.defaultCountryCode.length).replace(/^(\d{5})(\d{5})$/, '$1 $2')
  : m.replace(/^\+/, ''));

function records(docs) {
  return docs.map((v) => {
    const admitted = ['approved', 'checked_out', 'force_checked_out'].includes(v.status);
    const end = v.checkedOutAt ? new Date(v.checkedOutAt) : v.status === 'approved' ? new Date() : null;
    const minutes = admitted && v.decidedAt && end ? Math.max(0, Math.round((end - new Date(v.decidedAt)) / 60000)) : null;
    return {
      ref: v.ref,
      day: v.visitDay,
      pass: v.dailyNumber ?? null,
      name: `${v.firstName} ${v.lastName}`,
      mobile: localMobile(v.mobile),
      company: v.company || '',
      purpose: v.purpose || '',
      host: v.host?.fullName || '',
      unit: v.host?.unit || '',
      status: STATUS_LABEL[v.status] || v.status,
      statusKey: v.status,
      arrived: v.createdAt || null,
      letIn: admitted ? v.decidedAt || null : null,
      left: v.checkedOutAt || null,
      minutes,
      note: v.forceReason || '',
      folder: `${v.visitDay}/${v.ref} ${safe(`${v.firstName} ${v.lastName}`)}`,
      photoPath: v.photoPath || null,
      idImagePath: v.idImagePath || null,
      idPurged: Boolean(v.idImagePurgedAt),
    };
  });
}

// ---------------------------------------------------------------- Excel
// `files`: null for a sheet on its own; { aadhaar } when the sheet sits in the ZIP next to the folders.
async function workbook(recs, { files = null, meta }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.siteName;
  wb.created = new Date();

  const ws = wb.addWorksheet('Visits', { views: [{ state: 'frozen', ySplit: 1 }] });
  const when = { numFmt: 'dd-mmm-yyyy hh:mm' };
  ws.columns = [
    { header: 'Visitor ID', key: 'ref', width: 12 },
    { header: 'Date', key: 'day', width: 13, style: { numFmt: 'dd-mmm-yyyy' } },
    { header: 'Pass no', key: 'pass', width: 9 },
    { header: 'Name', key: 'name', width: 24 },
    { header: `Mobile (${config.defaultCountryCode})`, key: 'mobile', width: 14 },
    { header: 'Company', key: 'company', width: 22 },
    { header: 'Purpose', key: 'purpose', width: 15 },
    { header: 'Meeting', key: 'host', width: 20 },
    { header: 'Flat / dept', key: 'unit', width: 12 },
    { header: 'Status', key: 'status', width: 19 },
    { header: 'Arrived', key: 'arrived', width: 18, style: when },
    { header: 'Let in', key: 'letIn', width: 18, style: when },
    { header: 'Left', key: 'left', width: 18, style: when },
    { header: 'Time inside', key: 'inside', width: 13 },
    { header: 'Checkout note', key: 'note', width: 30 },
    ...(files ? [{ header: 'Photo', key: 'photo', width: 10 }, { header: 'Aadhaar (masked)', key: 'aadhaar', width: 18 }] : []),
  ];

  // Relative links to the files next to the sheet. Plain paths: Excel on Windows resolves these most reliably.
  const link = (text, target) => ({ text, hyperlink: target });
  for (const r of recs) {
    const row = ws.addRow({
      ...r, day: dayDate(r.day), arrived: wall(r.arrived), letIn: wall(r.letIn), left: wall(r.left), inside: duration(r.minutes),
    });
    if (files) {
      row.getCell('photo').value = r.hasPhoto ? link('Open', `${r.folder}/photo.jpg`) : '—';
      row.getCell('aadhaar').value = !files.aadhaar ? 'Not included'
        : r.hasIdImage ? link('Open', `${r.folder}/aadhaar-masked.jpg`)
          : r.idPurged ? 'Deleted after retention' : '—';
      for (const key of ['photo', 'aadhaar']) {
        const c = row.getCell(key);
        if (c.value?.hyperlink) c.font = { color: { argb: 'FF0563C1' }, underline: true };
      }
    }
  }

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FF111111' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  head.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0F3' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFB8BEC8' } } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  const about = wb.addWorksheet('About this download');
  about.columns = [{ width: 22 }, { width: 70 }];
  const lines = [
    ['Site', config.siteName],
    ['Downloaded', human(new Date())],
    ['Downloaded by', meta.by],
    ['Visits', recs.length],
    ['Dates', meta.range],
    ...(meta.filters ? [['Filters', meta.filters]] : []),
    ['Contents', files ? `This sheet, a printable report (Report.html), and one folder per visit with the visitor photo${files.aadhaar ? ' and the masked Aadhaar image' : ''}.` : 'This sheet only. Photos are in the full record download.'],
    ['Times', `Local time at the site (${config.timezone}).`],
    ...(files?.aadhaar ? [['Aadhaar images', 'Masked on the guard\'s device before upload: the first 8 digits are blacked out. Handle as personal data.']] : []),
  ];
  for (const [k, v] of lines) about.addRow([k, v]).getCell(1).font = { bold: true };

  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------- Printable report (opens in any browser)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const src = (p) => p.split('/').map(encodeURIComponent).join('/');

function report(recs, { meta, aadhaar }) {
  const byDay = new Map();
  for (const r of recs) (byDay.get(r.day) || byDay.set(r.day, []).get(r.day)).push(r);

  const card = (r) => `
    <article class="visit">
      ${r.hasPhoto ? `<img class="face" src="${src(`${r.folder}/photo.jpg`)}" alt="">` : '<div class="face none">No photo</div>'}
      <div>
        <h3>${esc(r.name)} ${r.pass != null ? `<span class="pass">Pass ${r.pass}</span>` : ''}</h3>
        <p class="sub">${esc(r.company)}${r.purpose ? ` · ${esc(r.purpose)}` : ''}</p>
        <dl>
          <dt>Visitor ID</dt><dd>${esc(r.ref)}</dd>
          <dt>Mobile</dt><dd>${esc(r.mobile)}</dd>
          <dt>Meeting</dt><dd>${esc(r.host)}, ${esc(r.unit)}</dd>
          <dt>Status</dt><dd>${esc(r.status)}</dd>
          <dt>Arrived</dt><dd>${esc(human(r.arrived))}</dd>
          ${r.letIn ? `<dt>Let in</dt><dd>${esc(human(r.letIn))}</dd>` : ''}
          ${r.left ? `<dt>Left</dt><dd>${esc(human(r.left))}${r.minutes != null ? ` (${duration(r.minutes)} inside)` : ''}</dd>` : ''}
          ${r.note ? `<dt>Note</dt><dd>${esc(r.note)}</dd>` : ''}
        </dl>
      </div>
      ${aadhaar ? (r.hasIdImage ? `<img class="id" src="${src(`${r.folder}/aadhaar-masked.jpg`)}" alt="Masked Aadhaar">` : `<div class="id none">${r.idPurged ? 'Aadhaar deleted after retention' : 'No Aadhaar image'}</div>`) : ''}
    </article>`;

  const days = [...byDay.entries()].map(([day, list]) => `
    <section>
      <h2>${esc(human(`${day}T12:00:00Z`, false))} <span>${list.length} ${list.length === 1 ? 'visit' : 'visits'}</span></h2>
      ${list.map(card).join('')}
    </section>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visitor records · ${esc(meta.range)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; background: #f4f5f7; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 20px 48px; }
  header { margin-bottom: 24px; }
  header h1 { margin: 0 0 4px; font-size: 24px; }
  header p { margin: 0; color: #555; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  h2 span { color: #777; font-weight: 400; font-size: 13px; margin-left: 6px; }
  .visit { display: grid; grid-template-columns: 96px 1fr ${aadhaar ? '220px' : ''}; gap: 16px; align-items: start; background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 14px; margin-bottom: 10px; break-inside: avoid; }
  .visit h3 { margin: 0; font-size: 16px; }
  .pass { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 6px; background: #111; color: #fff; font-size: 12px; vertical-align: 2px; }
  .sub { margin: 2px 0 8px; color: #555; }
  dl { display: grid; grid-template-columns: 90px 1fr; gap: 2px 10px; margin: 0; font-size: 13px; }
  dt { color: #777; } dd { margin: 0; }
  .face { width: 96px; height: 96px; border-radius: 10px; object-fit: cover; background: #eef0f3; }
  .id { width: 220px; border-radius: 8px; border: 1px solid #e3e6eb; background: #111; }
  .none { display: grid; place-items: center; color: #888; font-size: 12px; text-align: center; padding: 8px; background: #eef0f3; border: 0; min-height: 96px; }
  footer { margin-top: 32px; color: #777; font-size: 12px; }
  @media (max-width: 700px) { .visit { grid-template-columns: 72px 1fr; } .face { width: 72px; height: 72px; } .id { grid-column: 1 / -1; width: 100%; } }
  @media print { body { background: #fff; } main { padding: 0; } .visit { border-color: #ccc; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Visitor records</h1>
    <p>${esc(config.siteName)} · ${esc(meta.range)} · ${recs.length} ${recs.length === 1 ? 'visit' : 'visits'}${meta.filters ? ` · ${esc(meta.filters)}` : ''}</p>
    <p>Downloaded ${esc(human(new Date()))} by ${esc(meta.by)}. Times are local to the site.</p>
  </header>
  ${days || '<p>No visits in this range.</p>'}
  <footer>${aadhaar ? 'Aadhaar images are masked on the guard’s device before upload (first 8 digits hidden). Handle this file as personal data.' : 'Aadhaar images were not included in this download.'}</footer>
</main>
</body>
</html>`;
}

module.exports = { records, workbook, report, STATUS_LABEL };
