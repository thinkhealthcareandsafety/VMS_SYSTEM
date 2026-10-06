// Copies the on-device OCR engine into public/ocr so it is served from our own origin
// (no third-party CDN, works under the strict Content-Security-Policy). Runs before dev and build.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const out = join(root, 'public', 'ocr');
mkdirSync(join(out, 'lang'), { recursive: true });

const files = [
  [nm('tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js')],
  // LSTM-only builds, with and without SIMD; the browser downloads just one of them.
  [nm('tesseract.js-core', 'tesseract-core-lstm.wasm.js'), join(out, 'tesseract-core-lstm.wasm.js')],
  [nm('tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'), join(out, 'tesseract-core-simd-lstm.wasm.js')],
  // Compact integer model: about 3 MB, plenty for printed digits.
  [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz')],
];
for (const [from, to] of files) {
  if (!existsSync(from)) throw new Error(`OCR asset missing: ${from} (run npm install)`);
  cpSync(from, to);
}
console.log('OCR assets ready in public/ocr');
