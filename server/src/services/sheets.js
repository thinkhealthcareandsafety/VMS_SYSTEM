const ExcelJS = require('exceljs');
const { cleanText } = require('./core');

// Lists arrive as an Excel file, a CSV, or text pasted straight out of Excel. One reader for all of them,
// shared by guest lists, the host directory and expected visitors.
const MAX_BYTES = 5 * 1024 * 1024;

// RFC 4180 CSV (quoted fields, commas and line breaks inside quotes); tabs work too, for text pasted from Excel.
function parseDelimited(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const first = text.split('\n')[0];
  const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
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

// { text } or { file: base64, filename } -> rows of cells. Throws a readable error for a file too large.
async function readCells({ text, file, filename }) {
  if (file) {
    const buf = Buffer.from(String(file), 'base64');
    if (buf.length > MAX_BYTES) throw Object.assign(new Error('The file is larger than 5 MB'), { expose: true });
    const isXlsx = /\.xlsx$/i.test(filename || '') || buf.subarray(0, 2).toString() === 'PK';
    return isXlsx ? parseXlsx(buf) : parseDelimited(buf.toString('utf8').replace(/^﻿/, ''));
  }
  return parseDelimited(String(text || '').replace(/^﻿/, ''));
}

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Rows of cells -> [{ line, ...fields }] using a heading row when one is recognised, else the fallback column order.
// spec: { field: ['heading', 'other heading', ...] }, fallback: ['field', 'field', ...]
function columns(rows, spec, fallback) {
  if (!rows.length) return [];
  const head = rows[0].map(key);
  const col = Object.fromEntries(Object.entries(spec).map(([f, names]) => [f, head.findIndex((h) => names.includes(h))]));
  const hasHead = Object.values(col).some((i) => i >= 0);
  if (!hasHead) for (const f of Object.keys(spec)) col[f] = fallback.indexOf(f);
  const body = hasHead ? rows.slice(1) : rows;
  return body.map((r, i) => {
    const out = { line: i + (hasHead ? 2 : 1) };
    for (const [f, c] of Object.entries(col)) out[f] = c >= 0 ? cleanText(String(r[c] ?? ''), 200) : '';
    return out;
  });
}

module.exports = { MAX_BYTES, parseDelimited, parseXlsx, readCells, columns, key };
