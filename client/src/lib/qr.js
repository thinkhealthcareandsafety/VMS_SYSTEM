// Reads QR codes from the camera. The browser's own BarcodeDetector is fast where it exists (Android, macOS,
// ChromeOS); everywhere else (Chrome on Windows, older Safari) jsQR reads a downscaled frame instead.
let detector;
let jsQR;

async function native() {
  if (detector !== undefined) return detector;
  detector = null;
  try {
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch { detector = null; }
  return detector;
}

const canvas = document.createElement('canvas');
const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

// One frame from the video -> the QR text, or null.
export async function readQr(video) {
  if (!video?.videoWidth) return null;
  const d = await native();
  if (d) {
    try {
      const found = await d.detect(video);
      return found[0]?.rawValue || null;
    } catch { /* fall through to jsQR */ }
  }
  if (!jsQR) jsQR = (await import('jsqr')).default;
  const scale = Math.min(1, 640 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
}

// Pass code as shown to people: K7M2-9QXP.
export const showCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
