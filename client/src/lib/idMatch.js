// Checks the ID card against what the guard typed: the name, and the gender where the card shows one.
// Everything runs on the guard's device; only the outcome (match / partial / mismatch) is sent.
//
// Sources, best first:
//   'qr'  Aadhaar Secure QR (every Aadhaar since 2019, and the PVC card): UIDAI's own data, read exactly.
//         Also the old XML QR on paper letters.
//   'ocr' The printed text read off the card (PAN, licence, passport, voter ID, or an Aadhaar without a
//         readable QR). Noisier: the name is taken from its printed line only when every letter reads
//         cleanly, and the typed name is also looked for among all the words.
// Like the face match this is advice for the guard, never a block.

// ---------------------------------------------------------------- Aadhaar Secure QR
// The QR holds one big decimal number. As bytes it is a gzip stream; inside, fields are separated by 0xFF:
//   [V2,] indicator, reference id (last 4 of the Aadhaar + timestamp), name, dob, gender, care of, district, ...
// The signature and photo at the end are not read here.
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bigToBytes(digits) {
  let hex = BigInt(digits).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

const GENDER_CODE = { M: 'male', F: 'female', T: 'other' };

function parseXmlQr(text) {
  const attr = (k) => (text.match(new RegExp(`\\b${k}="([^"]*)"`, 'i')) || [])[1] || '';
  const name = attr('name');
  if (!name) return null;
  const uid = attr('uid').replace(/\D/g, '');
  return { source: 'qr', name, gender: GENDER_CODE[attr('gender').toUpperCase()[0]] || null, dob: attr('dob') || attr('yob'), last4: uid.length === 12 ? uid.slice(-4) : null };
}

// QR text -> { source:'qr', name, gender, dob, last4 } or null when it is not an Aadhaar QR.
export async function parseAadhaarQr(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/<\?xml|PrintLetterBarcodeData/i.test(text)) return parseXmlQr(text);
  if (!/^\d{200,}$/.test(text)) return null;
  try {
    const bytes = await gunzip(bigToBytes(text));
    const fields = [];
    let start = 0;
    for (let i = 0; i < bytes.length && fields.length < 8; i += 1) {
      if (bytes[i] === 255) { fields.push(new TextDecoder('latin1').decode(bytes.subarray(start, i))); start = i + 1; }
    }
    const at = /^V\d/.test(fields[0]) ? 2 : 1; // V2+ carry a version field first
    const [ref, name, dob, gender] = fields.slice(at, at + 4);
    if (!name || !/^\d{4}/.test(ref || '')) return null;
    return { source: 'qr', name: name.trim(), gender: GENDER_CODE[(gender || '').trim().toUpperCase()] || null, dob: (dob || '').trim(), last4: ref.slice(0, 4) };
  } catch { return null; }
}

// ---------------------------------------------------------------- Printed text
// Words that are on the card but are never part of a person's name.
const CARD_WORDS = new Set(`government india of the republic unique identification authority aadhaar aadhar mera pehchaan
  dob date birth year male female transgender gender sex father husband name names son daughter wife care address
  income tax department permanent account number card signature govt issued issue valid till upto licence license
  driving transport union territory state election commission identity elector electors photo passport type code
  nationality indian surname given place expiry authority holder blood group vid enrolment download no from to`.split(/\s+/));

// OCR lines -> { source:'ocr', words, gender, name }. Only letters are kept: no number from the card stays in memory.
// A line is OCR words ({ text, bbox, confidence }) or, from tests, plain text laid out one line under the other.
export function readPrinted(lines) {
  const all = toWords(lines);
  const text = all.map((w) => w.text).join(' ');
  const g = text.match(/\b(FEMALE|MALE|TRANSGENDER)\b/i);
  const words = all.flatMap((w) => w.text.split(/[^A-Za-z]+/)).map((w) => w.toLowerCase()).filter((w) => w.length >= 2 && !CARD_WORDS.has(w));
  return { source: 'ocr', words, gender: g ? ({ female: 'female', male: 'male', transgender: 'other' })[g[1].toLowerCase()] : null, name: printedName(all) };
}

function toWords(lines) {
  return lines.flatMap((line, row) => {
    if (typeof line !== 'string') return line.filter((w) => w?.bbox && String(w.text || '').trim()).map((w) => ({ ...w, text: String(w.text).trim() }));
    let x = 0;
    return line.split(/\s+/).filter(Boolean).map((t) => {
      const w = { text: t, bbox: { x0: x, x1: x + t.length * 10, y0: row * 30, y1: row * 30 + 20 } };
      x += (t.length + 1) * 10;
      return w;
    });
  });
}

// Words that sit side by side on one printed line. OCR's own lines jump around on a card (the photo and
// the QR sit between the labels), so the lines are rebuilt from where the words are.
const hasText = (t) => /[A-Za-z0-9]/.test(t);
function segmentsOf(items) {
  const segs = [];
  for (const w of items) {
    let best = null;
    for (const s of segs) {
      const last = s[s.length - 1];
      const h = Math.max(w.h, last.h);
      const gap = w.x0 - last.x1;
      const ratio = w.h / last.h;
      const sameSize = !hasText(w.text) || !hasText(last.text) || (ratio > 0.6 && ratio < 1.6); // a ":" is smaller than the letters
      if (Math.abs(w.cy - last.cy) < h * 0.5 && sameSize && gap > -h * 0.3 && gap < h * 2.5 && (!best || gap < best.gap)) best = { s, gap };
    }
    if (best) best.s.push(w); else segs.push([w]);
  }
  return segs.map((ws) => {
    const hs = ws.filter((w) => hasText(w.text)).map((w) => w.h).sort((a, b) => a - b);
    return { words: ws, x0: ws[0].x0, x1: ws[ws.length - 1].x1, y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)), h: hs[Math.floor(hs.length / 2)] || ws[0].h };
  });
}

// The name on a printed line, from word `from` on: "RAVI KUMAR" or "Ravi Kumar". Null when a letter reads
// unsure, or when the line runs into a word the reader could not join to it (glare swallowed part of the
// name): no name beats a wrong or cut-short one.
function nameIn(seg, from, items) {
  const used = [];
  for (const w of seg.words.slice(from)) {
    if (/^[:\-–.,]+$/.test(w.text)) continue; // "Name : RAVI"
    const t = w.text.replace(/^[:.,]+|[:.,]+$/g, '');
    if (CARD_WORDS.has(t.toLowerCase())) { if (used.length) break; return null; } // "RAVI KUMAR  Blood Group"
    if (!/^([A-Z][a-z]+|[A-Z]+)$/.test(t) || (typeof w.confidence === 'number' && w.confidence < 60)) return null;
    used.push(w);
  }
  if (!used.length || used.length > 5 || !used.some((w) => w.text.length >= 3)) return null;
  const first = used[0];
  const last = used[used.length - 1];
  const cy = (Math.min(...used.map((w) => w.y0)) + Math.max(...used.map((w) => w.y1))) / 2;
  const reach = seg.h * 1.5;
  const stray = items.some((w) => !seg.words.includes(w) && hasText(w.text) && w.y0 <= cy && w.y1 >= cy
    && ((w.x0 >= last.x1 - seg.h * 0.3 && w.x0 - last.x1 < reach) || (from === 0 && w.x1 <= first.x0 + seg.h * 0.3 && first.x0 - w.x1 < reach)));
  return stray ? null : used.map((w) => w.text.replace(/^[:.,]+|[:.,]+$/g, '')).join(' ');
}

const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
const isNameLabel = (t) => letters(t).length >= 3 && /^[nm][ae](m|rn|n)?e?s?$/.test(letters(t)); // Name, Name(s), and how OCR misreads it
const isRelation = (t) => /^fa[a-z]*(th|er|ry|rs)|ther|husb|moth|guard|spou/.test(letters(t)); // Father's Name (and misreads: Faery, Fahars), Husband's Name
const isSurname = (t) => /^s[uv]rn[ae]me$/.test(letters(t));
// Aadhaar: "DOB: 01/01/1990", "YoB", "Year of Birth". Not "Date of Birth": on a PAN that line is under the father's name.
const isDobLine = (s) => s.words.some((w) => /(^|[^A-Za-z])(DOB|D0B|YOB)(?![A-Za-z])/i.test(w.text))
  || (s.words.some((w) => letters(w.text) === 'year') && s.words.some((w) => letters(w.text) === 'birth'));

// The printed line just below a label (or above, for the Aadhaar DOB), starting about where the label starts.
function nextTo(segs, label, below, items) {
  const h = label.h;
  const near = segs.filter((s) => s !== label && (below
    ? s.y0 >= label.y1 - h * 0.3 && s.y0 - label.y1 <= h * 2.2 && s.x0 >= label.x0 - h * 2 && s.x0 <= label.x0 + h * 4
    : s.y1 <= label.y0 + h * 0.3 && label.y0 - s.y1 <= h * 2.2 && Math.abs(s.x0 - label.x0) <= h * 3));
  near.sort((a, b) => (below ? a.y0 - b.y0 : b.y1 - a.y1));
  return near[0] ? nameIn(near[0], 0, items) : null;
}

// The card holder's name, read from where it is printed:
//   "Name" label (PAN, voter ID, licence): the rest of that line, or the line under it. "Father's Name" is skipped.
//   "Given Name(s)" and "Surname" labels (passport).
//   No label (Aadhaar): the line above "DOB" / "Year of Birth".
function printedName(words) {
  const items = words.map((w) => ({ ...w, ...w.bbox, h: w.bbox.y1 - w.bbox.y0, cy: (w.bbox.y0 + w.bbox.y1) / 2 }))
    .filter((w) => w.h > 0).sort((a, b) => a.x0 - b.x0);
  const segs = segmentsOf(items);
  const top = segs.slice().sort((a, b) => a.y0 - b.y0);
  let given = null;
  let surname = null;
  let name = null;
  for (const s of top) {
    const i = s.words.findIndex((w) => isNameLabel(w.text) || isSurname(w.text));
    if (i < 0) continue;
    const before = s.words.slice(0, i);
    if (before.some((w) => isRelation(w.text)) || s.words.slice(i + 1, i + 3).some((w) => isRelation(w.text))) continue;
    const label = s.words[i];
    const value = nameIn(s, i + 1, items) || nextTo(segs, s, true, items);
    if (!value) continue;
    if (isSurname(label.text)) surname = surname || value;
    else if (before.some((w) => letters(w.text) === 'given')) given = given || value;
    else name = name || value;
  }
  if (given || surname) return [given, surname].filter(Boolean).join(' ');
  if (name) return name;
  const dob = top.find(isDobLine);
  return dob ? nextTo(segs, dob, false, items) : null;
}

// ---------------------------------------------------------------- Which card it is
// Words only one kind of card carries, matched loosely: the reader often gets a letter or two wrong.
const KIND_WORDS = {
  pan: ['income', 'permanent', 'account'],
  dl: ['driving', 'licence', 'license', 'transport'],
  voter: ['election', 'commission', 'elector', 'electors'],
  passport: ['passport', 'republic', 'nationality'],
};
const AADHAAR_WORDS = ['aadhaar', 'aadhar', 'uidai'];
const DIGIT_LIKE = { O: '0', D: '0', Q: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6', T: '7' };
// ABCDE1234F: the 4th letter says who holds it (P a person, C a company, ...).
const isPanNumber = (t) => {
  const s = t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 10 && /^[A-Z]{3}[ABCFGHJLPT][A-Z]$/.test(s.slice(0, 5)) && /^[A-Z]$/.test(s[9])
    && [...s.slice(5, 9)].every((c) => /\d/.test(c) || DIGIT_LIKE[c]);
};

// Words read off the card (and whether a printed Aadhaar number or Aadhaar QR was found) ->
// { kind: 'aadhaar'|'pan'|'dl'|'voter'|'passport'|null, maybeAadhaar }. maybeAadhaar: "Government of India",
// printed on every Aadhaar; never enough to call a card an Aadhaar, but enough to keep masking it.
export function cardKind(texts, { aadhaarNumber = false, qr = false } = {}) {
  const ws = texts.map(letters).filter((w) => w.length >= 4);
  const has = (key) => ws.some((w) => w === key || (key.length >= 6 && Math.abs(w.length - key.length) <= 2 && jaroWinkler(w, key) >= 0.88));
  if (qr || aadhaarNumber || AADHAAR_WORDS.some(has) || (has('unique') && has('identification'))) return { kind: 'aadhaar', maybeAadhaar: true };
  const maybeAadhaar = has('government') && ws.includes('india');
  let kind = null;
  let best = 1;
  for (const [k, keys] of Object.entries(KIND_WORDS)) {
    const score = keys.filter(has).length + (k === 'pan' && texts.some(isPanNumber) ? 2 : 0);
    if (score > best) { best = score; kind = k; }
  }
  return { kind, maybeAadhaar };
}

// ---------------------------------------------------------------- Name matching
// The same Indian name is spelt many ways in Roman script (Mohammed / Md, Lakshmi / Laxmi, Pooja / Puja,
// Sharma / Sarma): names are compared on a sound-alike key first, then by edit similarity, then as initials.
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'sri', 'smt', 'kumari', 'km', 'late', 'prof', 'er', 'adv', 'capt', 'col', 'major', 'sh']);
const SAME_NAME = { md: 'mohamad', mohd: 'mohamad', mohammad: 'mohamad', mohammed: 'mohamad', muhammad: 'mohamad', muhammed: 'mohamad', mohamed: 'mohamad' };

export function nameTokens(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t && !HONORIFICS.has(t));
}

export function soundKey(t) {
  let s = SAME_NAME[t] || t;
  s = s.replace(/ksh|x/g, 'ks').replace(/ph/g, 'f').replace(/w/g, 'v').replace(/q/g, 'k').replace(/z/g, 'j')
    .replace(/([kgcjtdpb])h/g, '$1').replace(/sh/g, 's').replace(/ee|ie/g, 'i').replace(/oo|ou/g, 'u')
    .replace(/y$/, 'i').replace(/(.)\1+/g, '$1');
  if (s.length > 3) s = s.replace(/a$/, '');
  return s;
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j += 1) {
      if (!bm[j] && a[i] === b[j]) { am[i] = true; bm[j] = true; m += 1; break; }
    }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i += 1) {
    if (!am[i]) continue;
    while (!bm[k]) k += 1;
    if (a[i] !== b[k]) t += 1;
    k += 1;
  }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] && a[p] === b[p]) p += 1;
  return jaro + p * 0.1 * (1 - jaro);
}

// 1 same name, 0.9 a spelling variant, 0.7 an initial ("R" for "Ravi"), 0 different.
export function tokenSimilarity(a, b) {
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 0.7 : 0;
  const ka = soundKey(a);
  const kb = soundKey(b);
  if (a === b || ka === kb) return 1;
  const short = Math.min(ka.length, kb.length);
  const jw = jaroWinkler(ka, kb);
  return jw >= (short <= 4 ? 0.93 : 0.9) ? 0.9 : 0;
}

// Pairs each typed word with its best card word, each card word used once.
function pairUp(typed, card) {
  const used = new Set();
  let sum = 0;
  let full = 0;
  let any = 0;
  for (const t of typed) {
    let best = 0;
    let at = -1;
    card.forEach((c, i) => {
      if (used.has(i)) return;
      const s = tokenSimilarity(t, c);
      if (s > best) { best = s; at = i; }
    });
    if (at >= 0) used.add(at);
    sum += best;
    if (best >= 0.9) full += 1;
    if (best > 0) any += 1;
  }
  return { sum, full, any, usedCard: used.size };
}

// typed name vs the card -> { status: 'match'|'partial'|'mismatch', score 0..100 }
export function compareNames(typedName, cardTokens, { bag = false } = {}) {
  const typed = nameTokens(typedName);
  const card = bag ? cardTokens : nameTokens(cardTokens.join(' '));
  if (!typed.length || !card.length) return null;
  // "Ravikumar" typed for "Ravi Kumar" (or the other way round)
  if (!bag && soundKey(typed.join('')) === soundKey(card.join(''))) return { status: 'match', score: 100 };
  const { sum, full, any } = pairUp(typed, card);
  const longest = bag ? typed.length : Math.max(typed.length, card.length);
  const score = Math.round((100 * sum) / longest);
  // Every typed word is on the card. A typed first name alone against a 3-word card name is only partial.
  const all = any === typed.length && full >= 1;
  const enough = bag || typed.length >= Math.min(2, card.length);
  if (all && enough) return { status: 'match', score: Math.max(score, bag ? 100 : score) };
  if (full >= 1 || (any >= 1 && any === typed.length)) return { status: 'partial', score };
  return { status: 'mismatch', score };
}

// ---------------------------------------------------------------- The check
// read: what the card gave ({ source:'qr', name, gender, last4 } or readPrinted output, whose name may be null), plus ocrLast4 for Aadhaar.
// Returns null when there is nothing to compare yet.
export function checkId(read, { firstName, lastName, gender }) {
  if (!read) return null;
  const typed = `${firstName || ''} ${lastName || ''}`.trim();
  if (!typed) return null;
  const tamper = read.source === 'qr' && read.last4 && read.ocrLast4 && read.last4 !== read.ocrLast4;

  let name = null;
  if (read.source === 'qr') name = compareNames(typed, nameTokens(read.name));
  else {
    // The name line read off the card, or failing that, the typed name looked for among all the words.
    const printed = read.name ? compareNames(typed, nameTokens(read.name)) : null;
    const anywhere = read.words.length >= 3 ? compareNames(typed, read.words, { bag: true }) : null;
    const rank = (r) => (r ? ['mismatch', 'partial', 'match'].indexOf(r.status) * 1000 + r.score : -1);
    name = rank(anywhere) > rank(printed) ? anywhere : printed;
  }
  const sex = read.gender && gender ? (read.gender === gender ? 'match' : 'mismatch') : null;

  let status;
  if (!name) status = 'unread';
  else if (tamper || name.status === 'mismatch' || sex === 'mismatch') status = 'mismatch';
  else if (name.status === 'match') status = 'match';
  else status = 'partial';
  if (status === 'unread' && sex === 'mismatch') status = 'mismatch';

  return {
    status,
    source: read.source,
    nameScore: name?.score ?? null,
    name: name?.status ?? null,
    gender: sex,
    tamper: Boolean(tamper),
    cardName: read.name || null,
    cardGender: read.gender || null,
  };
}

// "RAVI KUMAR SHARMA" -> { firstName: 'Ravi', lastName: 'Kumar Sharma' }
export function splitCardName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return { firstName: words[0] || '', lastName: words.slice(1).join(' ') };
}
