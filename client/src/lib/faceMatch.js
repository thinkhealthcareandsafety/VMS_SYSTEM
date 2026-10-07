// Face match: the live photo against the face printed on the Aadhaar card, on the guard's device.
//
// 1. A small face finder (Human: BlazeFace + landmarks) locates the face and straightens it.
// 2. SFace (an ArcFace-class recognition model, Apache-2.0, run by onnxruntime-web) turns the
//    straightened face into a 128-number descriptor.
// 3. The two descriptors are compared. Only the resulting score (0-100) is sent to the server:
//    no face descriptor, template or card image with a face leaves the device.
// Models and runtime are served from /faces on our own origin: no third-party CDN, no outside call.
//
// The score is advice for the guard, not a verdict: Aadhaar photos are small, old and often
// photographed through glare, so a low score means "look twice", never "refuse".

// Cosine similarity of two SFace descriptors. OpenCV's published same-person threshold for SFace is 0.363.
// Provisional bands: calibrate on real cards from the site (see docs/OPERATIONS.md).
export const COSINE = { same: 0.363, strong: 0.5 };

// Maps cosine to a 0-100 score: the "same person" threshold reads as 50, a clear match as 70, and only a
// near-identical face (cosine 0.8, what the same photo gives) reaches 100. Two different photos of one person land in the 50s and 60s-80s.
export function toScore(cos) {
  const s = cos < COSINE.same
    ? (Math.max(cos, 0) / COSINE.same) * 50
    : cos < COSINE.strong
      ? 50 + ((cos - COSINE.same) / (COSINE.strong - COSINE.same)) * 20
      : 70 + ((cos - COSINE.strong) / (0.8 - COSINE.strong)) * 30;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export const BANDS = { strong: 70, possible: 50 };
export function bandOf(score) {
  if (score >= BANDS.strong) return 'strong';
  if (score >= BANDS.possible) return 'possible';
  return 'weak';
}

let modelUrl = '/faces/models/sface_int8.onnx'; // quantised SFace: 10 MB instead of 38 MB, same accuracy within noise
const ORT_WASM = '/faces/ort/ort-wasm-simd-threaded.wasm';

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

// ---------------------------------------------------------------- Engines (one of each per session)
const FINDER_CONFIG = {
  modelBasePath: '/faces/models/',
  debug: false,
  async: false,
  warmup: 'none',
  cacheSensitivity: 0, // every call is a new picture, never reuse an earlier result
  skipAllowed: false,
  filter: { enabled: true, equalization: true }, // evens out glare and faded print on the card photo
  face: {
    enabled: true,
    detector: { rotation: true, maxDetected: 4, minConfidence: 0.2, skipFrames: 0, skipTime: 0, return: false },
    mesh: { enabled: true },
    iris: { enabled: false },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
    attention: { enabled: false },
    description: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
};

let finderPromise = null;
function finder() {
  if (!finderPromise) {
    finderPromise = (async () => {
      const mod = await import('@vladmandic/human');
      const Human = mod.Human || mod.default;
      let human = new Human({ ...FINDER_CONFIG, backend: 'webgl' });
      try {
        await human.load();
        await human.init();
      } catch {
        // No usable GPU in this browser: the same models run on the CPU, just slower.
        human = new Human({ ...FINDER_CONFIG, backend: 'cpu' });
        await human.load();
        await human.init();
      }
      return human;
    })().catch((err) => { finderPromise = null; throw err; });
  }
  return finderPromise;
}

let recognizerPromise = null;
function recognizer() {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.wasmPaths = { wasm: ORT_WASM }; // the loader script is bundled with the library; only the engine file is fetched
      ort.env.wasm.numThreads = 1; // threads need cross-origin isolation; one is plenty for a 112x112 face
      ort.env.wasm.proxy = false;
      ort.env.logLevel = 'error';
      const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
      return { ort, session };
    })().catch((err) => { recognizerPromise = null; throw err; });
  }
  return recognizerPromise;
}

// Start loading while the guard is still typing, so the first comparison is quick.
export function warmUp() {
  finder().catch(() => { /* retried when needed */ });
  recognizer().catch(() => { /* retried when needed */ });
}

// ---------------------------------------------------------------- Finding and straightening the face
// The biggest, most certain face in the picture: a card also carries a small ghost photo and the visitor may not be alone.
function bestFace(result) {
  const faces = (result?.face || []).filter((f) => f.mesh?.length >= 468);
  if (!faces.length) return null;
  const rank = (f) => (f.box?.[2] || 0) * (f.box?.[3] || 0) * (f.faceScore || f.score || 0.5);
  return faces.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

const avg = (mesh, ids) => ids.reduce((p, i) => [p[0] + mesh[i][0] / ids.length, p[1] + mesh[i][1] / ids.length], [0, 0]);
// Five landmarks the recognition model was trained with: eye centres, nose tip, mouth corners (as seen in the picture, left to right).
function landmarks(mesh) {
  return [avg(mesh, [33, 133, 159, 145]), avg(mesh, [362, 263, 386, 374]), mesh[1].slice(0, 2), mesh[61].slice(0, 2), mesh[291].slice(0, 2)];
}
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

// Least-squares similarity transform (rotate, scale, move) taking the found landmarks onto the template.
function similarity(src, dst) {
  const n = src.length;
  const mean = (pts, k) => pts.reduce((s, p) => s + p[k], 0) / n;
  const [sx, sy, dx, dy] = [mean(src, 0), mean(src, 1), mean(dst, 0), mean(dst, 1)];
  let a = 0; let b = 0; let d = 0;
  for (let i = 0; i < n; i += 1) {
    const [x, y] = [src[i][0] - sx, src[i][1] - sy];
    const [u, v] = [dst[i][0] - dx, dst[i][1] - dy];
    a += x * u + y * v;
    b += x * v - y * u;
    d += x * x + y * y;
  }
  const c = a / d; // scale * cos
  const r = b / d; // scale * sin
  return { m: [c, r, -r, c], e: dx - (c * sx - r * sy), f: dy - (r * sx + c * sy) };
}

function align(canvas, face) {
  const { m, e, f } = similarity(landmarks(face.mesh), TEMPLATE);
  const out = document.createElement('canvas');
  out.width = 112;
  out.height = 112;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(m[0], m[1], m[2], m[3], e, f);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

async function embedOnce(session, ort, canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, 112, 112);
  const plane = 112 * 112;
  const input = new Float32Array(3 * plane); // RGB, 0-255, planar: the way the model was exported
  for (let i = 0; i < plane; i += 1) {
    input[i] = data[i * 4];
    input[plane + i] = data[i * 4 + 1];
    input[2 * plane + i] = data[i * 4 + 2];
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
  return Array.from(out[session.outputNames[0]].data);
}

// The face and its mirror image are described and averaged: steadier on soft, tilted card photos.
async function embed(aligned) {
  const { ort, session } = await withTimeout(recognizer(), 120000);
  const mirror = document.createElement('canvas');
  mirror.width = 112;
  mirror.height = 112;
  const mctx = mirror.getContext('2d');
  mctx.translate(112, 0);
  mctx.scale(-1, 1);
  mctx.drawImage(aligned, 0, 0);
  const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const [a, b] = [unit(await embedOnce(session, ort, aligned)), unit(await embedOnce(session, ort, mirror))];
  return unit(a.map((x, i) => x + b[i]));
}

function crop(src, x, y, w, h, scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

// Descriptor of the face in a canvas, or null when there is none.
// card: the photo sits on the left of an Aadhaar card, small, so if the whole card shows no face we look closer at the left side.
async function describe(canvas, { card = false } = {}) {
  const human = await withTimeout(finder(), 120000);
  const find = async (c) => ({ c, face: bestFace(await withTimeout(human.detect(c), 20000)) });
  let hit = await find(canvas);
  if (!hit.face && card) hit = await find(crop(canvas, 0, 0, canvas.width * 0.5, canvas.height, 1.6));
  if (!hit.face) return null;
  return { embedding: await embed(align(hit.c, hit.face)) };
}

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
});

// The live photo (a data URL). `mirrored`: the front camera preview is saved flipped, so flip it back to how a card shows the face.
export async function describePhoto(dataUrl, { mirrored = false } = {}) {
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  if (mirrored) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(img, 0, 0);
  return describe(c);
}

// The card, straight from the camera and still unmasked: call this before the number is painted over.
export function describeCard(cardCanvas) {
  return describe(cardCanvas, { card: true });
}

export const cosine = (a, b) => a.embedding.reduce((s, x, i) => s + x * b.embedding[i], 0);

// 0-100. Same person scores high, different people low; see BANDS for how the guard is told.
export const compare = async (a, b) => toScore(cosine(a, b));

// For the test harness only.
export const __test = {
  async faceBox(canvas) {
    const human = await finder();
    return bestFace(await human.detect(canvas))?.box || null;
  },
  use({ model }) {
    recognizerPromise = null;
    if (model) modelUrl = model;
  },
};
