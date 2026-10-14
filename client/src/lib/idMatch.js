// Checks the ID card against what the guard typed: the name, and the gender where the card shows one.
// Everything runs on the guard's device; only the outcome (match / partial / mismatch) is sent.
//
// Sources, best first:
//   'qr'  Aadhaar Secure QR (every Aadhaar since 2019, and the PVC card): UIDAI's own data, read exactly.
//         Also the old XML QR on paper letters.
//   'ocr' The printed text read off the card (PAN, licence, passport, voter ID, or an Aadhaar without a
//         readable QR). Noisier, so the typed name is looked for among the words rather than extracted.
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

// OCR lines -> { source:'ocr', words, gender }. Only letters are kept: no number from the card stays in memory.
export function readPrinted(lines) {
  const text = lines.join(' ');
  const g = text.match(/\b(FEMALE|MALE|TRANSGENDER)\b/i);
  const words = lines.flatMap((l) => l.split(/[^A-Za-z]+/)).map((w) => w.toLowerCase()).filter((w) => w.length >= 2 && !CARD_WORDS.has(w));
  return { source: 'ocr', words, gender: g ? ({ female: 'female', male: 'male', transgender: 'other' })[g[1].toLowerCase()] : null };
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
// read: what the card gave ({ source:'qr', name, gender, last4 } or readPrinted output), plus ocrLast4 for Aadhaar.
// Returns null when there is nothing to compare yet.
export function checkId(read, { firstName, lastName, gender }) {
  if (!read) return null;
  const typed = `${firstName || ''} ${lastName || ''}`.trim();
  if (!typed) return null;
  const tamper = read.source === 'qr' && read.last4 && read.ocrLast4 && read.last4 !== read.ocrLast4;

  let name = null;
  if (read.source === 'qr') name = compareNames(typed, nameTokens(read.name));
  else if (read.words.length >= 3) name = compareNames(typed, read.words, { bag: true });
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
    cardName: read.source === 'qr' ? read.name : null,
    cardGender: read.gender || null,
  };
}

// "RAVI KUMAR SHARMA" -> { firstName: 'Ravi', lastName: 'Kumar Sharma' }
export function splitCardName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return { firstName: words[0] || '', lastName: words.slice(1).join(' ') };
}
