import { fmtDate, fmtTime } from '../api.js';

// The material receipt, printed at the gate on the same 80 mm slip printer as visitor passes: what came in, what the
// hotel accepted, what went back with the vendor, who received it, and lines for the vendor's and security's
// signatures. The window opens before anything else so the browser does not treat it as a pop-up; printing starts
// from here because the site's security policy blocks scripts inside the sheet.
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Math.round(n * 1000) / 1000;

export function printMaterialReceipt(m, { siteName, onError } = {}) {
  const win = window.open('', '_blank');
  if (!win) { onError?.('Allow pop-ups for this site to print the receipt.'); return; }
  const done = m.status === 'checked_out';
  const inAt = m.in?.at || m.createdAt;
  const outAt = m.out?.at || m.checkedOutAt;
  const rows = m.items.map((i) => {
    const kept = i.acceptedQty ?? (done ? i.qty : null);
    const back = kept == null ? null : num(i.qty - kept);
    return `<tr><td>${esc(i.code ? `${i.code} · ` : '')}${esc(i.name)}</td><td class="r">${esc(i.qty)} ${esc(i.unit)}</td>${done ? `<td class="r">${esc(kept)}</td><td class="r${back > 0 ? ' b' : ''}">${back > 0 ? esc(back) : '–'}</td>` : ''}</tr>`;
  }).join('');
  const docs = [m.docs?.invoice && `Invoice ${m.docs.invoice}`, m.docs?.dc && `Challan ${m.docs.dc}`].filter(Boolean).join(' · ') || 'No invoice or challan';
  win.document.open();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Material receipt ${esc(m.number)}</title><style>
@page { size: 80mm auto; margin: 0; } * { box-sizing: border-box; } html, body { margin: 0; background: #fff; }
body { width: 72mm; margin: 0 auto; padding: 4mm 0 8mm; color: #000; font: 9.5pt/1.3 -apple-system, "Segoe UI", Arial, sans-serif; }
.logos { display: flex; align-items: center; justify-content: center; gap: 4mm; margin-bottom: 1mm; } .logos img { height: 10mm; width: auto; } .logos img:first-child { height: 13mm; } .logos i { width: .25mm; height: 9mm; background: #000; }
h1 { font-size: 11pt; letter-spacing: .18em; text-align: center; margin: 1mm 0 0; } .no { text-align: center; font: 700 14pt ui-monospace, Consolas, monospace; margin: 1mm 0 2mm; }
.rule { border-top: .35mm dashed #000; margin: 2.5mm 0; } .row { display: flex; justify-content: space-between; gap: 3mm; padding: .4mm 0; } .row span { color: #333; } .row strong { text-align: right; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; } th, td { padding: 1mm .5mm; border-bottom: .2mm solid #999; text-align: left; vertical-align: top; } th { font-size: 8pt; } .r { text-align: right; white-space: nowrap; } .b { font-weight: 700; }
.note { font-size: 8.5pt; margin-top: 2mm; } .sign { display: flex; gap: 4mm; margin-top: 10mm; } .sign div { flex: 1; border-top: .3mm solid #000; padding-top: 1mm; font-size: 8pt; text-align: center; }
.foot { font-size: 7.5pt; text-align: center; margin-top: 4mm; color: #333; }
</style></head><body>
<div class="logos"><img src="${location.origin}/brand/stregis-print.png" alt="St. Regis"><i></i><img src="${location.origin}/brand/marquis-print.png" alt="Marriott Marquis"></div>
<h1>MATERIAL ${done ? 'RECEIPT' : 'ENTRY'}</h1>
<div class="no">${esc(m.number)}</div>
<div class="row"><span>Supplier</span><strong>${esc(m.party?.company || m.party?.name || '')}</strong></div>
${m.party?.company && m.party?.name ? `<div class="row"><span>Delivered by</span><strong>${esc(m.party.name)}</strong></div>` : ''}
<div class="row"><span>Documents</span><strong>${esc(docs)}</strong></div>
${m.vehicle?.number ? `<div class="row"><span>Vehicle</span><strong>${esc(m.vehicle.number)}</strong></div>` : ''}
${m.cardNo ? `<div class="row"><span>Vendor card</span><strong>${esc(m.cardNo)}</strong></div>` : ''}
<div class="row"><span>In</span><strong>${esc(fmtDate(inAt))}, ${esc(fmtTime(inAt))}${m.in?.gate ? ` · ${esc(m.in.gate)}` : ''}</strong></div>
${done ? `<div class="row"><span>Out</span><strong>${esc(fmtDate(outAt))}, ${esc(fmtTime(outAt))}${m.out?.gate ? ` · ${esc(m.out.gate)}` : ''}</strong></div>` : ''}
<div class="rule"></div>
<table><thead><tr><th>Goods</th><th class="r">Came</th>${done ? '<th class="r">Accepted</th><th class="r">Taken back</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
${done && m.takenBack ? '<div class="note"><strong>Goods not accepted went back with the vendor.</strong></div>' : ''}
${m.receivedBy ? `<div class="rule"></div><div class="row"><span>Received by</span><strong>${esc([m.receivedBy.department, m.receivedBy.name].filter(Boolean).join(' · '))}</strong></div>` : ''}
${m.exitNote ? `<div class="note">Remarks: ${esc(m.exitNote)}</div>` : ''}
<div class="sign"><div>Vendor</div><div>Receiver</div><div>Security (LP)</div></div>
<div class="foot">${esc(siteName || 'The St. Regis New Delhi & New Delhi Marriott Marquis')} · printed ${esc(fmtDate(new Date().toISOString()))}, ${esc(fmtTime(new Date().toISOString()))}</div>
</body></html>`);
  win.document.close();
  const go = () => { try { win.focus(); win.print(); } catch { /* Ctrl+P still works */ } };
  if (win.document.readyState === 'complete') setTimeout(go, 300); else win.addEventListener('load', () => setTimeout(go, 300), { once: true });
}
