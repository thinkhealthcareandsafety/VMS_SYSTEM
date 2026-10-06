// Aadhaar masking, done on the guard's device before any image leaves the browser.
//
// 1. The card is cropped from the camera (unmasked, kept only in memory).
// 2. On-device OCR (Tesseract, served from our own origin) reads the card and finds every Aadhaar
//    number (12 digits in groups of four) and VID (16 digits), wherever they are and however many
//    times they appear. The first 8 digits (first 12 of a VID) are painted solid black.
// 3. QR codes are painted black where the browser can detect them: older Aadhaar letters carry the
//    full number inside the QR.
// 4. If nothing can be read (glare, blur), the fixed guide box is painted instead and the guard is
//    asked to check; they can black out anything else by hand before sending.
// Painting is solid fill, not blur, so nothing under it is recoverable.
import { createWorker } from 'tesseract.js';

export const CARD_ASPECT = 85.6 / 54; // ISO/IEC 7810 ID-1 card
export const MASK_RECT = { x: 0.16, y: 0.6, w: 0.48, h: 0.2 }; // fallback: where the number sits on the PVC card front
export const GUIDE_WIDTH = 0.84; // guide box as a fraction of the camera frame width

// Maps the on-screen guide (object-fit: cover) back to source-video pixels and crops the card. Unmasked.
export function grabCard(video, container, maxWidth = 1280) {
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;

  const gw = cw * GUIDE_WIDTH;
  const gh = gw / CARD_ASPECT;
  const gx = (cw - gw) / 2;
  const gy = (ch - gh) / 2;

  const sx = (gx - ox) / scale;
  const sy = (gy - oy) / scale;
  const sw = gw / scale;
  const sh = gh / scale;

  const outW = Math.min(maxWidth, Math.round(sw));
  const outH = Math.round(outW / CARD_ASPECT);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
  return canvas;
}

// ---------------------------------------------------------------- OCR engine (one per session)
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      workerPath: '/ocr/worker.min.js',
      corePath: '/ocr',
      langPath: '/ocr/lang',
      workerBlobURL: false,
      gzip: true,
    }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' }); // sparse text: cards are scattered labels
      return w;
    }).catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// Start loading the engine early (while the guard is still typing), so the scan is quick.
export function warmUp() {
  getWorker().catch(() => { /* retried on capture */ });
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

// ---------------------------------------------------------------- Finding the numbers
// Common OCR confusions in printed digits.
const LOOKALIKE = { O: '0', o: '0', D: '0', Q: '0', U: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1', L: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6', b: '6', g: '9', q: '9', T: '7' };

// "4826" -> "4826", "48Z6" -> "4826"; a real word ("SOIL") is rejected: at most one look-alike per four characters.
function digitsOf(text) {
  const t = String(text).replace(/[\s.,:;'"`_()\-–—]/g, '');
  if (!t || t.length > 16) return null;
  let out = '';
  let fixed = 0;
  for (const ch of t) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (LOOKALIKE[ch]) { out += LOOKALIKE[ch]; fixed += 1; } else return null;
  }
  return fixed <= Math.max(1, Math.floor(out.length / 4)) - (out.length < 4 ? 1 : 0) ? out : null;
}

function wordsByLine(data) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) lines.push(line.words || []);
    }
  }
  return lines;
}

// Chains digit-words that sit side by side at the same height, by position on the card rather than by
// OCR "line": a slightly tilted card can make OCR split one number across two lines.
function chainDigits(items) {
  const chains = [];
  for (const it of items.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
    let best = null;
    for (const ch of chains) {
      const last = ch[ch.length - 1];
      const h = Math.max(it.h, last.h);
      const gap = it.bbox.x0 - last.bbox.x1;
      const sameRow = Math.abs(it.cy - last.cy) < h * 0.75;
      const sameSize = it.h / last.h > 0.6 && it.h / last.h < 1.6;
      if (sameRow && sameSize && gap > -h * 0.3 && gap < h * 1.8 && (!best || gap < best.gap)) best = { ch, gap };
    }
    if (best) best.ch.push(it); else chains.push([it]);
  }
  return chains;
}

const boxOf = (parts) => ({
  x0: Math.min(...parts.map((c) => c.x0)), x1: Math.max(...parts.map((c) => c.x1)),
  y0: Math.min(...parts.map((c) => c.y0)), y1: Math.max(...parts.map((c) => c.y1)),
});

// Returns boxes (in the coordinates of the image OCR saw) covering the digits to hide.
function findNumbers(data) {
  const boxes = [];
  let alreadyMasked = false;
  let uncertain = false;
  const lines = wordsByLine(data);
  for (const words of lines) {
    if (/[Xx×*]{4}\s*[Xx×*]{4}\s*\d{4}/.test(words.map((w) => w.text).join(' '))) alreadyMasked = true; // UIDAI's own masked Aadhaar
  }

  const all = lines.flat().filter((w) => w.bbox && w.text.trim());
  const heights = all.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] || 1;

  const items = all.map((w) => ({ d: digitsOf(w.text), bbox: w.bbox, h: w.bbox.y1 - w.bbox.y0, cy: (w.bbox.y0 + w.bbox.y1) / 2 }))
    .filter((w) => w.d && w.d.length >= 1);

  for (const raw of chainDigits(items)) {
    // On a tilted card the reader can split one group ("482" + "6"): rejoin pieces that almost touch.
    const chain = [];
    for (const w of raw) {
      const prev = chain[chain.length - 1];
      if (prev && w.bbox.x0 - prev.bbox.x1 < Math.max(prev.h, w.h) * 0.3 && prev.d.length + w.d.length <= 4) {
        prev.d += w.d;
        prev.bbox = boxOf([prev.bbox, w.bbox]);
      } else chain.push({ ...w, bbox: { ...w.bbox } });
    }
    const single = chain.filter((w) => w.d.length > 1);
    if (!single.length) continue; // stray single digits on their own are not a number

    // Best case: the printed pattern itself. Aadhaar = 4-4-4 (hide 2 groups), VID = 4-4-4-4 (hide 3).
    // The last group may be clipped or misread (3 to 5 characters); the groups being hidden must be exact.
    const four = chain.map((w) => w.d.length === 4);
    const tail = chain.map((w) => w.d.length >= 3 && w.d.length <= 5);
    let matched = false;
    for (let i = 0; i < chain.length; i += 1) {
      const vid = four[i] && four[i + 1] && four[i + 2] && tail[i + 3];
      const uid = four[i] && four[i + 1] && tail[i + 2];
      if (vid || uid) {
        const hidden = chain.slice(i, i + (vid ? 3 : 2));
        boxes.push(boxOf(hidden.map((w) => w.bbox)));
        matched = true;
        i += vid ? 3 : 2;
      }
    }
    if (matched) continue;

    // Otherwise the reader merged or split the groups: count digits instead.
    const chars = chain.flatMap(({ d, bbox }) => {
      const step = (bbox.x1 - bbox.x0) / d.length;
      return [...d].map((ch, i) => ({ x0: bbox.x0 + i * step, x1: bbox.x0 + (i + 1) * step, y0: bbox.y0, y1: bbox.y1 }));
    });
    const n = chars.length;
    const groupsOfFour = chain.filter((w) => w.d.length === 4).length;
    const big = Math.max(...chain.map((w) => w.h)) >= typical * 1.3; // the Aadhaar number is the largest print on the card
    let hide = 0;
    if (n >= 12) hide = n - 4;                                         // Aadhaar (12) or VID (16): keep only the last 4
    else if (n >= 8 && groupsOfFour >= 2) hide = n;                    // partly read number: hide all of it
    else if (n >= 4 && big && !alreadyMasked) hide = n;                // a lone big group the reader could not join up
    if (hide > 0) {
      // Not a clean 4-4-4 read: the reader may have missed a digit at either end, so widen by one digit.
      const box = boxOf(chars.slice(0, hide));
      const cw = (box.x1 - box.x0) / hide;
      box.x0 -= cw * 1.2;
      if (hide === n) box.x1 += cw * 1.2;
      boxes.push(box);
      uncertain = true;
    }
  }
  return { boxes, alreadyMasked, uncertain };
}

// Grayscale, more contrast and a sensible size help OCR on phone photos.
// Second look (only when the first finds nothing): larger and harder contrast, for blur and glare.
function prepareForOcr(card, strong = false) {
  const scale = Math.min(strong ? 2.2 : 2, (strong ? 2000 : 1600) / card.width);
  const c = document.createElement('canvas');
  c.width = Math.round(card.width * scale);
  c.height = Math.round(card.height * scale);
  const ctx = c.getContext('2d');
  ctx.filter = strong ? 'grayscale(1) contrast(2.2) brightness(1.1)' : 'grayscale(1) contrast(1.35)';
  ctx.drawImage(card, 0, 0, c.width, c.height);
  return { canvas: c, scale };
}

async function findQrCodes(card) {
  try {
    if (!('BarcodeDetector' in window)) return [];
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return [];
    const found = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(card);
    return found.map((f) => f.boundingBox);
  } catch { return []; }
}

// ---------------------------------------------------------------- Masking
// Paints the card in place and returns { dataUrl, method, numbers, qr }.
// method: 'auto' (number found and hidden), 'already' (card was already masked), 'guide' (fallback box).
export async function maskCard(card) {
  const ctx = card.getContext('2d');
  let numbers = [];
  let uncertain = false;
  let alreadyMasked = false;
  try {
    const worker = await withTimeout(getWorker(), 25000);
    for (const strong of [false, true]) {
      const { canvas, scale } = prepareForOcr(card, strong);
      const { data } = await withTimeout(worker.recognize(canvas, {}, { blocks: true }), 15000);
      const found = findNumbers(data);
      alreadyMasked = alreadyMasked || found.alreadyMasked;
      uncertain = found.uncertain;
      numbers = found.boxes.map((b) => ({ x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale }));
      if (numbers.length || alreadyMasked) break;
    }
  } catch { /* engine unavailable or too slow: fall back below */ }

  const qr = await findQrCodes(card);

  ctx.fillStyle = '#000';
  for (const b of numbers) {
    const h = b.y1 - b.y0;
    const px = h * 0.25; // less than the gap between digit groups, so the last 4 stay readable
    const py = h * 0.3;
    ctx.fillRect(b.x0 - px, b.y0 - py, b.x1 - b.x0 + px * 2, h + py * 2);
  }
  for (const b of qr) {
    const p = Math.max(b.width, b.height) * 0.06;
    ctx.fillRect(b.x - p, b.y - p, b.width + p * 2, b.height + p * 2);
  }

  let method = 'auto';
  if (!numbers.length) {
    if (alreadyMasked) method = 'already';
    else {
      method = 'guide';
      const w = card.width;
      const h = card.height;
      ctx.fillRect(MASK_RECT.x * w, MASK_RECT.y * h, MASK_RECT.w * w, MASK_RECT.h * h);
    }
  }
  return { dataUrl: card.toDataURL('image/jpeg', 0.82), method, numbers: numbers.length, qr: qr.length, check: method === 'guide' || (method === 'auto' && uncertain) };
}

// The guard's own touch-ups: paints rectangles (in image pixels) onto an already masked image.
export function paintBoxes(dataUrl, rects) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = '#000';
      for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// For the test harness only.
export const __test = {
  findNumbers,
  digitsOf,
  async words(card) {
    const { canvas } = prepareForOcr(card);
    const { data } = await (await getWorker()).recognize(canvas, {}, { blocks: true });
    return wordsByLine(data).flatMap((line, li) => line.map((w) => ({ li, text: w.text, bbox: w.bbox })));
  },
};
