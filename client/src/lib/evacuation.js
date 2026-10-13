import { api, fmtDate, fmtTime } from '../api.js';

// Everyone on the premises right now, on paper, for a fire drill or an emergency: visitors by host, event guests
// by group, with an empty column to tick people off at the assembly point. The window opens before the data
// is fetched, so the browser does not treat it as a pop-up; printing starts from here because the site's
// security policy blocks scripts inside the sheet.
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function printEvacuation({ siteName, onError }) {
  const win = window.open('', '_blank');
  if (!win) { onError?.('Allow pop-ups for this site to print the evacuation list.'); return; }
  win.document.write('<p style="font:16px system-ui;padding:24px">Preparing the evacuation list…</p>');
  let data;
  try {
    data = await api('/api/visits/inside?all=1');
  } catch (e) {
    win.close();
    onError?.(e.message);
    return;
  }
  const now = new Date().toISOString();
  const people = data.visits || [];
  const visitors = people.filter((v) => !v.groupId).sort((a, b) => `${a.host?.name}`.localeCompare(`${b.host?.name}`));
  const names = new Map((data.groups || []).map((g) => [g.id, g.name]));
  const byGroup = new Map();
  for (const v of people.filter((x) => x.groupId)) {
    if (!byGroup.has(v.groupId)) byGroup.set(v.groupId, []);
    byGroup.get(v.groupId).push(v);
  }
  const since = (v) => v.lastIn?.at || v.decidedAt;
  const row = (v, i, withHost) => `<tr><td class="n">${i + 1}</td><td>${esc(v.dailyNumber)}</td><td><strong>${esc(`${v.firstName} ${v.lastName}`.trim())}</strong><br><span>${esc(v.company)}</span></td>${withHost ? `<td>${esc(v.host?.name)}<br><span>${esc(v.host?.unit)}</span></td>` : ''}<td>${esc(fmtTime(since(v)))}<br><span>${esc(v.lastIn?.gate || '')}</span></td><td>${esc(v.mobile || '')}</td><td class="tick"></td></tr>`;
  const table = (list, withHost) => `<table><thead><tr><th class="n">#</th><th>Pass</th><th>Name</th>${withHost ? '<th>Meeting</th>' : ''}<th>In since</th><th>Mobile</th><th class="tick">✓</th></tr></thead><tbody>${list.map((v, i) => row(v, i, withHost)).join('')}</tbody></table>`;
  const sections = [
    visitors.length ? `<h2>Visitors <small>${visitors.length}</small></h2>${table(visitors, true)}` : '',
    ...[...byGroup.entries()].map(([id, list]) => `<h2>${esc(names.get(id) || 'Group')} <small>${list.length}</small></h2>${table(list.sort((a, b) => a.firstName.localeCompare(b.firstName)), false)}`),
  ].join('');

  win.document.open();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Evacuation list ${esc(fmtDate(now))} ${esc(fmtTime(now))}</title><style>
@page { size: A4; margin: 12mm; } body { font: 10pt/1.35 -apple-system, "Segoe UI", Arial, sans-serif; color: #000; margin: 0; }
header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: .6mm solid #000; padding-bottom: 2mm; margin-bottom: 4mm; }
h1 { font-size: 16pt; margin: 0; } .total { font-size: 14pt; font-weight: 700; } h2 { font-size: 12pt; margin: 6mm 0 2mm; } h2 small { font-weight: 400; color: #444; }
table { width: 100%; border-collapse: collapse; } th, td { border: .2mm solid #888; padding: 1.5mm 2mm; text-align: left; vertical-align: top; } th { background: #eee; font-size: 9pt; }
td span { color: #444; font-size: 8.5pt; } .n { width: 8mm; text-align: right; } .tick { width: 12mm; } tr { break-inside: avoid; }
.empty { font-size: 13pt; padding: 10mm 0; }
</style></head><body>
<header><div><h1>Evacuation list</h1><div>${esc(siteName || 'Visitor Desk')} · printed ${esc(fmtDate(now))}, ${esc(fmtTime(now))}</div></div><div class="total">${people.length} on premises</div></header>
${people.length ? sections : '<p class="empty">Nobody is recorded as inside.</p>'}
<p style="margin-top:6mm;font-size:8.5pt;color:#444">Visitors and guests let in at the gates and not yet checked out. Staff and residents are not on this list.</p>
</body></html>`);
  win.document.close();
  const go = () => { try { win.focus(); win.print(); } catch { /* Ctrl+P still works */ } };
  if (win.document.readyState === 'complete') setTimeout(go, 300); else win.addEventListener('load', () => setTimeout(go, 300), { once: true });
}
