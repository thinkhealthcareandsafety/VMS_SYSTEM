import { api, fmtDate, fmtTime } from '../api.js';

// The day's registers on A4 for the paper file: material received, parcels in, parcels out. Each register starts on
// its own page with the hotels' logos and ends with lines for signatures. Opens as a page of its own (a preview the
// admin can print again), like the evacuation list.
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sub = (t) => (t ? `<br><span>${esc(t)}</span>` : '');
const num = (n) => (Math.round(n * 1000) / 1000).toLocaleString('en-IN');
const at = (d) => (d ? esc(fmtTime(d)) : '');

export const REPORT_PARTS = [
  { key: 'material', label: 'Material received' },
  { key: 'parcelsIn', label: 'Parcels in' },
  { key: 'parcelsOut', label: 'Parcels out' },
];

const signature = (p) => (p.signature ? `<img class="sig" src="${location.origin}${p.signature}" alt="">` : '');

function materialTable(rows) {
  const body = rows.map((m, i) => {
    const goods = m.items.map((it) => {
      const back = it.acceptedQty != null && it.acceptedQty < it.qty ? ` <b>· kept ${num(it.acceptedQty)}, back ${num(it.qty - it.acceptedQty)}</b>` : '';
      return `${esc(it.name)} — ${num(it.qty)} ${esc(it.unit)}${back}`;
    }).join('<br>');
    const party = m.party?.company || m.party?.name;
    const contact = [m.party?.company ? m.party?.name : '', m.party?.mobile].filter(Boolean).join(' · ');
    const docs = [m.docs?.invoice && `Inv ${m.docs.invoice}`, m.docs?.dc && `DC ${m.docs.dc}`].filter(Boolean).join('<br>') || '<i>No invoice</i>';
    const recv = [m.receivedBy?.department || m.department, m.receivedBy?.name].filter(Boolean).join(' · ');
    const out = m.out?.at || m.checkedOutAt;
    return `<tr><td class="n">${i + 1}</td><td class="no">${esc(m.number)}</td><td>${at(m.in?.at || m.createdAt)}${sub(m.in?.gate)}</td>
<td><strong>${esc(party)}</strong>${sub(contact)}${m.vehicle?.number ? sub(`Vehicle ${m.vehicle.number}`) : ''}</td><td>${goods}</td><td>${docs}</td>
<td>${esc(recv)}</td><td class="sigc">${signature(m)}</td><td>${out ? at(out) : '<i>Inside</i>'}</td><td>${esc(m.in?.by || m.createdBy)}${m.out?.by && m.out.by !== (m.in?.by || m.createdBy) ? sub(`out: ${m.out.by}`) : ''}</td><td>${esc(m.statusLabel)}${m.note || m.exitNote ? sub([m.note, m.exitNote].filter(Boolean).join(' · ')) : ''}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th class="n">#</th><th>Entry</th><th>In</th><th>Supplier</th><th>Goods and quantity</th><th>Invoice / challan</th><th>For / received by</th><th>Signature</th><th>Out</th><th>Guard</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>`;
}

const recipient = (p) => (p.recipient?.kind === 'host' ? [p.recipient.name, p.recipient.unit] : [p.recipient?.name, p.recipient?.room]);

function parcelsInTable(rows) {
  const body = rows.map((p, i) => {
    const [who, where] = recipient(p);
    const from = [p.sender?.company, p.sender?.name].filter(Boolean).join(' · ');
    const h = p.handover;
    return `<tr><td class="n">${i + 1}</td><td class="no">${esc(p.number)}</td><td>${at(p.createdAt)}</td><td><strong>${esc(p.carrier)}</strong>${sub(p.awb)}</td>
<td>${esc(from)}</td><td><strong>${esc(who)}</strong>${sub([where, p.department].filter(Boolean).join(' · '))}</td><td>${esc(p.pieces)} · ${esc(p.typeLabel)}</td>
<td>${esc(p.statusLabel)}${p.response ? sub(p.response.label) : ''}</td><td>${h ? `${esc(h.to)}${sub(fmtTime(h.at))}` : ''}</td><td class="sigc">${signature(p)}</td><td>${esc(p.createdBy)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th class="n">#</th><th>No.</th><th>Time</th><th>Courier / AWB</th><th>From</th><th>For</th><th>Pieces</th><th>Status</th><th>Handed to</th><th>Signature</th><th>Guard</th></tr></thead><tbody>${body}</tbody></table>`;
}

function parcelsOutTable(rows) {
  const body = rows.map((p, i) => {
    const [who, where] = recipient(p);
    const h = p.handover;
    return `<tr><td class="n">${i + 1}</td><td class="no">${esc(p.number)}</td><td>${at(p.createdAt)}</td><td><strong>${esc(who || p.department)}</strong>${sub([where, who ? p.department : ''].filter(Boolean).join(' · '))}</td>
<td><strong>${esc(p.addressee)}</strong>${sub(p.address)}</td><td><strong>${esc(p.carrier)}</strong>${sub(p.awb)}</td><td>${esc(p.pieces)} · ${esc(p.typeLabel)}</td>
<td>${esc(p.statusLabel)}</td><td>${h ? `${esc(h.to)}${sub(fmtTime(h.at))}` : ''}</td><td class="sigc">${signature(p)}</td><td>${esc(p.createdBy)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th class="n">#</th><th>No.</th><th>Booked</th><th>From</th><th>To</th><th>Courier / AWB</th><th>Pieces</th><th>Status</th><th>Picked up by</th><th>Signature</th><th>Guard</th></tr></thead><tbody>${body}</tbody></table>`;
}

const count = (rows, test) => rows.filter(test).length;
const SECTIONS = {
  material: {
    title: 'Material received',
    table: materialTable,
    empty: 'No material was received on this day.',
    summary: (r) => [[r.length, 'entries'], [r.reduce((n, m) => n + m.itemCount, 0), 'items'], [count(r, (m) => m.takenBack), 'part taken back'], [count(r, (m) => m.status === 'received'), 'vendors still inside']],
    signs: ['Security supervisor', 'Stores / receiving'],
  },
  parcelsIn: {
    title: 'Parcels in',
    table: parcelsInTable,
    empty: 'No parcels came in on this day.',
    summary: (r) => [[r.length, 'received'], [count(r, (p) => ['collected', 'forwarded'].includes(p.status)), 'handed over'], [count(r, (p) => p.status === 'received'), 'waiting'], [count(r, (p) => p.status === 'returned'), 'returned']],
    signs: ['Security supervisor', 'Mail room / front office'],
  },
  parcelsOut: {
    title: 'Parcels out',
    table: parcelsOutTable,
    empty: 'No parcels went out on this day.',
    summary: (r) => [[r.length, 'booked'], [count(r, (p) => p.status === 'dispatched'), 'dispatched'], [count(r, (p) => p.status === 'booked'), 'not yet picked up']],
    signs: ['Security supervisor', 'Despatching department'],
  },
};

const CSS = `
@page { size: A4 landscape; margin: 10mm 10mm 12mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Arial, sans-serif; color: #444; } }
* { box-sizing: border-box; }
body { font: 9pt/1.3 -apple-system, "Segoe UI", Arial, sans-serif; color: #000; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
section + section { break-before: page; }
header { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; border-bottom: .6mm solid #9c1c2e; padding-bottom: 2.5mm; margin-bottom: 3mm; }
.lg { display: flex; align-items: center; gap: 4mm; margin-bottom: 2mm; } .lg img { height: 9mm; width: auto; } .lg img.sr { height: 12mm; } .lg i { width: .25mm; height: 9mm; background: #000; }
h1 { font-size: 16pt; margin: 0; } .site { color: #333; }
.day { text-align: right; } .day strong { display: block; font-size: 14pt; } .day span { color: #444; font-size: 8pt; }
.sum { display: flex; gap: 3mm; margin-bottom: 3mm; } .sum div { border: .3mm solid #000; padding: 1.2mm 3mm; min-width: 28mm; }
.sum b { display: block; font-size: 14pt; line-height: 1.1; } .sum div:first-child { border-color: #9c1c2e; } .sum div:first-child b { color: #9c1c2e; }
table { width: 100%; border-collapse: collapse; } th, td { border: .2mm solid #777; padding: 1.2mm 1.6mm; text-align: left; vertical-align: top; }
th { background: #f1e6e8; font-size: 8pt; text-transform: uppercase; letter-spacing: .04em; } tr { break-inside: avoid; }
td span { color: #444; font-size: 8pt; } td i { color: #666; } td b { font-weight: 600; color: #7a1020; }
.no { white-space: nowrap; } .n { width: 7mm; text-align: right; } .sigc { width: 30mm; padding: .5mm; } .sig { display: block; max-width: 29mm; max-height: 11mm; margin: auto; }
.empty { font-size: 12pt; padding: 8mm 0; color: #333; }
.signs { display: flex; gap: 10mm; margin-top: 10mm; break-inside: avoid; } .signs div { flex: 1; border-top: .3mm solid #000; padding-top: 1.5mm; font-size: 8.5pt; }
.signs span { display: block; color: #555; margin-top: 1mm; }
`;

export async function printDailyReport({ day, parts, onError }) {
  const win = window.open('', '_blank');
  if (!win) { onError?.('Allow pop-ups for this site to print the report.'); return; }
  win.document.write('<p style="font:16px system-ui;padding:24px">Preparing the daily report…</p>');
  let data;
  try {
    data = await api(`/api/reports/daily?day=${encodeURIComponent(day)}`);
  } catch (e) {
    win.close();
    onError?.(e.message);
    return;
  }
  const now = new Date();
  const dayLabel = new Date(`${data.day}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const site = data.siteName || 'The St. Regis New Delhi & New Delhi Marriott Marquis';
  const sections = parts.map((key) => {
    const s = SECTIONS[key];
    const rows = data[key] || [];
    return `<section>
<header><div><div class="lg"><img class="sr" src="${location.origin}/brand/stregis-print.png" alt="St. Regis"><i></i><img src="${location.origin}/brand/marquis-print.png" alt="Marriott Marquis"></div>
<h1>${esc(s.title)}</h1><div class="site">${esc(site)}</div></div>
<div class="day"><strong>${esc(dayLabel)}</strong><span>Printed ${esc(fmtDate(now))}, ${esc(fmtTime(now))} by ${esc(data.printedBy)}</span></div></header>
<div class="sum">${s.summary(rows).map(([n, l]) => `<div><b>${n}</b>${esc(l)}</div>`).join('')}</div>
${rows.length ? s.table(rows) : `<p class="empty">${esc(s.empty)}</p>`}
<div class="signs">${s.signs.map((who) => `<div>${esc(who)}<span>Name, signature and date</span></div>`).join('')}</div>
</section>`;
  }).join('');

  win.document.open();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Daily report ${esc(data.day)}</title><style>${CSS}</style></head><body>${sections}</body></html>`);
  win.document.close();
  const go = () => { try { win.focus(); win.print(); } catch { /* Ctrl+P still works */ } };
  if (win.document.readyState === 'complete') setTimeout(go, 300); else win.addEventListener('load', () => setTimeout(go, 300), { once: true });
}
