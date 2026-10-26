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

export function parseInvoiceText(text) {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const company = findCompany(lines);
  const out = {
    company: company ? company.l.replace(/[,.:;\s]+$/, '') : '',
    address: findAddress(lines, company?.i),
    gstin: findGstin(lines),
    mobile: findMobile(lines),
    invoice: numberAfter(lines, '(?:tax\\s*)?(?:invoice|inv|bill)'),
    challan: numberAfter(lines, '(?:delivery\\s*)?(?:challan|d\\.?\\s?c)'),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
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

// A JPEG data URL -> the fields found. Throws when the engine cannot run (old phone, no memory).
export async function readInvoice(dataUrl, { timeoutMs = 45000 } = {}) {
  const w = await getWorker();
  const job = w.recognize(dataUrl).then((r) => r.data.text);
  const text = await Promise.race([job, new Promise((_, no) => setTimeout(() => no(new Error('Reading took too long')), timeoutMs))]);
  return parseInvoiceText(text);
}
