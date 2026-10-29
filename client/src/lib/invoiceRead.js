// Reads an invoice or delivery challan photo on the guard's device: invoice number, challan number, supplier name,
// address, mobile and GSTIN. Nothing leaves the device (the same on-device OCR as the ID card). The guard always
// sees what was read and corrects it; anything not found stays empty for them to type.

// ---------------------------------------------------------------- the text -> fields (pure, tested)
const HEADINGS = /^(tax\s*invoice|invoice|retail\s*invoice|bill\s*of\s*supply|delivery\s*challan|challan|cash\s*memo|estimate|quotation|original|duplicate|triplicate|for\s*recipient|copy|gst\s*invoice|credit\s*memo|debit\s*note|e-?way\s*bill)\b/i;
const COMPANY_WORDS = /\b(pvt|private|ltd|limited|llp|enterprises?|traders?|trading|industries|agency|agencies|foods?|services|corporation|company|co\.|stores?|mart|suppliers?|distributors?|associates|international|exports?|imports?|solutions|hotel supplies|dairy|farms?|bakers?|bakery|chemicals?|electricals?|hardware|textiles?)\b/i;
const STOP = /\b(gstin|gst\s*no|gst|pan|phone|ph|mob(?:ile)?|tel|contact|e-?mail|invoice|challan|date|bill\s*to|ship\s*to|buyer|consignee|state\s*code|place\s*of\s*supply|website|www\.)\b|@/i;
const GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;
// Letters OCR reads where the GSTIN has digits, and the other way round (GSTIN: 2 digits, 5 letters, 4 digits, letter, ...).
const TO_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G' };

const clean = (s) => s.replace(/[|_~`]+/g, ' ').replace(/\s+/g, ' ').trim();
const lettersShare = (s) => (s.replace(/[^A-Za-z]/g, '').length / Math.max(1, s.replace(/\s/g, '').length));

function fixGstin(raw) {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 15) return null;
  const shape = 'DDLLLLLDDDDLXZX'; // D digit, L letter, X either, Z the letter Z
  const out = [...s].map((ch, i) => {
    const want = shape[i];
    if (want === 'D') return TO_DIGIT[ch] || ch;
    if (want === 'L') return TO_LETTER[ch] || ch;
    if (want === 'Z') return ch === '2' ? 'Z' : ch;
    return ch;
  }).join('');
  return GSTIN.test(out) ? out : null;
}

function findGstin(lines) {
  for (const l of lines) {
    const direct = GSTIN.exec(l.toUpperCase());
    if (direct) return direct[1];
  }
  // A line that says GSTIN: take the 15 characters after it, fixing look-alikes.
  for (const l of lines) {
    const m = /gst\s*(?:in|no|n|number)?\.?\s*[:\-.]?\s*([A-Z0-9 ]{15,20})/i.exec(l);
    const fixed = m && fixGstin(m[1].replace(/\s+/g, '').slice(0, 15));
    if (fixed) return fixed;
  }
  return '';
}

// "Invoice No. : INV/2026/0412" -> "INV/2026/0412". The value must hold a digit, so "Invoice Date" is skipped.
function numberAfter(lines, label) {
  const re = new RegExp(`${label}\\s*(?:no|number|num|#)\\s*\\.?\\s*[:\\-.]?\\s*([A-Z0-9][A-Z0-9/\\-]{0,24})`, 'i');
  for (const l of lines) {
    const m = re.exec(l);
    if (m && /\d/.test(m[1])) return m[1].replace(/[-/.]+$/, '').toUpperCase();
  }
  return '';
}

function findMobile(lines) {
  const re = /(?:\+?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5})(?!\d)/;
  const labelled = lines.filter((l) => /\b(mob|mobile|ph|phone|tel|contact|cell|m)\b\s*[:.\-]?/i.test(l));
  for (const l of [...labelled, ...lines]) {
    const m = re.exec(l.toUpperCase().replace(GSTIN, ' ')); // a GSTIN's digits are not a phone number
    if (m) return m[1].replace(/\D/g, '');
  }
  return '';
}

function findCompany(lines) {
  const top = lines.slice(0, 10).map((l, i) => ({ l: l.replace(/^(m\/s\.?|for\s+)/i, '').trim(), i }))
    .filter(({ l }) => l.length >= 4 && !HEADINGS.test(l) && lettersShare(l) >= 0.6 && !STOP.test(l));
  const named = top.find(({ l }) => COMPANY_WORDS.test(l));
  return named || top[0] || null;
}

function findAddress(lines, from) {
  if (from == null) return '';
  const parts = [];
  for (const l of lines.slice(from + 1, from + 5)) {
    if (HEADINGS.test(l) || STOP.test(l) || /\bbill\s*(no|number)\b/i.test(l) || lettersShare(l) < 0.3) break;
    parts.push(l.replace(/[,\s]+$/, ''));
    if (/\b\d{3}\s?\d{3}\b/.test(l)) break; // the PIN code closes the address
  }
  return parts.join(', ');
}

// Tables print the label in one row and the value under it: "Invoice No.  Date" / "FF/0412  26-10-2026".
function numberBelow(lines, label) {
  const re = new RegExp(`^${label}\\s*(?:no|number|num|#)\\b`, 'i');
  for (const [i, l] of lines.entries()) {
    if (!re.test(l) || /\d/.test(l)) continue; // a heading row: the label, maybe other headings, no value
    const m = /^([A-Z0-9][A-Z0-9/\-]{1,24})/i.exec(lines[i + 1] || '');
    if (m && /\d/.test(m[1])) return m[1].replace(/[-/.]+$/, '').toUpperCase();
  }
  return '';
}

export function parseInvoiceText(text) {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const company = findCompany(lines);
  const inv = '(?:tax\\s*)?(?:invoice|inv|bill)';
  const dc = '(?:delivery\\s*)?(?:challan|d\\.?\\s?c)';
  const out = {
    company: company ? company.l.replace(/[,.:;\s]+$/, '') : '',
    address: findAddress(lines, company?.i),
    gstin: findGstin(lines),
    mobile: findMobile(lines),
    invoice: numberAfter(lines, inv) || numberBelow(lines, inv),
    challan: numberAfter(lines, dc) || numberBelow(lines, dc),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

// ---------------------------------------------------------------- vehicle number and goods lines (pure, tested)
// Indian number plates: DL 1L AB 1234, MH12AB1234, HR 55 X 0001. Bharat series: 22 BH 1234 AA.
const PLATE = /\b([A-Z]{2})[\s-]?(\d{1,2})[\s-]?([A-Z]{1,3})[\s-]?(\d{4})\b/;
const BH_PLATE = /\b(\d{2})[\s-]?BH[\s-]?(\d{4})[\s-]?([A-Z]{1,2})\b/;
const STATES = new Set('AN AP AR AS BR CH CG DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB'.split(' '));
function findVehicle(lines) {
  const labelled = lines.filter((l) => /\b(vehicle|veh|truck|lorry|tempo|vehical)\b/i.test(l));
  for (const l of [...labelled, ...lines]) {
    const u = l.toUpperCase().replace(GSTIN, ' ');
    const m = PLATE.exec(u);
    if (m && STATES.has(m[1])) return `${m[1]}${m[2]}${m[3]}${m[4]}`;
    const b = BH_PLATE.exec(u);
    if (b) return `${b[1]}BH${b[2]}${b[3]}`;
  }
  return '';
}

// Units as printed -> the register's units.
const UNIT_WORDS = [
  [/^(kgs?|kilos?|kilograms?)$/i, 'kg'], [/^(g|gms?|grams?)$/i, 'g'], [/^(l|ltrs?|litres?|liters?|lt)$/i, 'litre'], [/^(ml)$/i, 'ml'],
  [/^(nos?|numbers?|units?|ea|each)$/i, 'nos'], [/^(pcs?|pieces?)$/i, 'pcs'], [/^(box|boxes)$/i, 'box'], [/^(ctns?|cartons?|cases?)$/i, 'carton'],
  [/^(sets?)$/i, 'set'], [/^(pairs?|prs)$/i, 'pair'], [/^(mtrs?|metres?|meters?|m)$/i, 'metre'], [/^(rolls?)$/i, 'roll'], [/^(bags?|sacks?)$/i, 'bag'],
  [/^(drums?|cans?)$/i, 'drum'], [/^(bundles?|bdls?)$/i, 'bundle'], [/^(pkts?|packets?|packs?)$/i, 'packet'], [/^(dozens?|dz)$/i, 'nos'],
];
const unitOf = (w) => UNIT_WORDS.find(([re]) => re.test(w))?.[1] || null;
const NOT_GOODS = /\b(total|sub\s*total|gst|cgst|sgst|igst|tax|amount|rate|discount|round|grand|balance|paid|due|freight|hsn|invoice|challan|date|gstin|bank|ifsc|a\/c|account|signature|authori[sz]ed)\b/i;

// Lines that read like "1  Tomato  50 kg  ..." or "Bath towels 200 nos": a name, then a quantity and a unit.
// Suggestions only: the guard taps the ones to add, so a wrong guess costs nothing.
function findItems(lines) {
  const found = [];
  const seen = new Set();
  for (const raw of lines) {
    if (NOT_GOODS.test(raw)) continue;
    const l = raw.replace(/^\s*\d{1,3}[.)]?\s+/, ''); // serial number
    const m = /^([A-Za-z][A-Za-z .,&()'/-]{2,48}?)\s+(?:\d{4,8}\s+)?(\d{1,6}(?:\.\d{1,3})?)\s*([A-Za-z]{1,9})\b/.exec(l);
    if (!m) continue;
    const unit = unitOf(m[3]);
    const qty = Number(m[2]);
    const name = m[1].replace(/[\s.,(-]+$/, '').trim();
    if (!unit || !qty || qty > 1e6 || lettersShare(name) < 0.7 || name.length < 3) continue;
    const dozen = /^(dozens?|dz)$/i.test(m[3]);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ name: name.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase()), qty: dozen ? qty * 12 : qty, unit });
    if (found.length >= 20) break;
  }
  return found;
}

export function parseInvoiceExtras(text) {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const out = { vehicle: findVehicle(lines), items: findItems(lines) };
  if (!out.vehicle) delete out.vehicle;
  if (!out.items.length) delete out.items;
  return out;
}

// ---------------------------------------------------------------- the photo -> text (browser only)
let workerPromise = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(({ createWorker }) => createWorker('eng', 1, {
      workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr/lang', workerBlobURL: false, gzip: true,
    })).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' }); // a page of text, in reading order
      return w;
    }).catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// Start loading the engine while the guard is still taking the photo.
export function warmUpInvoiceReader() { getWorker().catch(() => { /* retried on read */ }); }

// The photo made easier to read: grey, stretched to full contrast, and enlarged when small (OCR wants big letters).
async function prepare(dataUrl) {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = img.naturalWidth < 1600 ? Math.min(2, 1600 / img.naturalWidth) : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 4) {
      const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0;
      p[i] = v; hist[v] += 1;
    }
    // Contrast from the 2nd to the 98th percentile of brightness: faded print and grey paper become black on white.
    const n = p.length / 4;
    let lo = 0; let hi = 255; let acc = 0;
    for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v -= 1) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < p.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((p[i] - lo) * 255) / span));
      p[i] = v; p[i + 1] = v; p[i + 2] = v;
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL('image/jpeg', 0.92);
  } catch { return dataUrl; }
}

// A JPEG data URL -> the fields found, plus the vehicle number and suggested goods lines.
// Throws when the engine cannot run (old phone, no memory).
export async function readInvoice(dataUrl, { timeoutMs = 45000 } = {}) {
  const w = await getWorker();
  const job = prepare(dataUrl).then((src) => w.recognize(src)).then((r) => r.data.text);
  const text = await Promise.race([job, new Promise((_, no) => setTimeout(() => no(new Error('Reading took too long')), timeoutMs))]);
  return { ...parseInvoiceText(text), ...parseInvoiceExtras(text) };
}
