// Copies the on-device face-matching engine into public/faces so it is served from our own origin
// (no third-party CDN, works under the strict Content-Security-Policy, works with no internet).
// Runs before dev and build.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const out = join(root, 'public', 'faces');
mkdirSync(join(out, 'models'), { recursive: true });
mkdirSync(join(out, 'ort'), { recursive: true });

const files = [
  // Face finder and face landmarks (to straighten the face): about 2 MB.
  ...['blazeface', 'facemesh'].flatMap((n) => ['json', 'bin'].map((e) => [nm('@vladmandic', 'human', 'models', `${n}.${e}`), join(out, 'models', `${n}.${e}`)])),
  // Face recognition (SFace, int8): about 10 MB, kept in vendor/ so builds work offline.
  [join(root, 'vendor', 'sface', 'face_recognition_sface_2021dec_int8.onnx'), join(out, 'models', 'sface_int8.onnx')],
  // ONNX runtime (WebAssembly) that runs the recognition model: about 14 MB, downloaded once and cached.
  [nm('onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm'), join(out, 'ort', 'ort-wasm-simd-threaded.wasm')],
];
for (const [from, to] of files) {
  if (!existsSync(from)) throw new Error(`Face engine file missing: ${from} (run npm install)`);
  cpSync(from, to);
}
console.log('Face engine ready in public/faces');
