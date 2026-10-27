import { useEffect, useRef, useState } from 'react';
import { Barcode, Camera, X } from 'lucide-react';
import { shrink } from './Photos.jsx';
import { Modal, Spinner } from './ui.jsx';

// Reads the barcode on a courier label and hands back its text (the AWB / tracking number).
// Live camera: the phone's own barcode reader where it has one (Chrome on Android), otherwise ZXing, tried hard on
// every frame, whole and the centre band enlarged, plus the QR reader the pass scanner uses. "Take a photo" reads a
// full-resolution photo instead: the sure way on a weak or fixed-focus camera. A handheld scanner just types.
const FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'itf', 'ean_13', 'ean_8', 'upc_a', 'qr_code', 'data_matrix', 'pdf417'];

// The courier, when the number itself says so. Only formats that are unmistakable; anything else is left to the guard.
export function carrierFromAwb(awb) {
  const a = String(awb || '').toUpperCase();
  if (/^TBA\d{9,}$/.test(a)) return 'Amazon';
  if (/^FM[A-Z]{2}\d{8,}$/.test(a)) return 'Ekart (Flipkart)';
  if (/^SF\d{8,}[A-Z]*$/.test(a)) return 'Shadowfax';
  return '';
}

// ZXing set to try hard on the formats couriers print, and jsQR for QR codes. Loaded only when needed.
let zx = null;
async function zxing() {
  if (!zx) {
    zx = Promise.all([import('@zxing/browser'), import('@zxing/library'), import('jsqr')]).then(([{ BrowserMultiFormatReader }, lib, qr]) => {
      const F = lib.BarcodeFormat;
      const hints = new Map([
        [lib.DecodeHintType.TRY_HARDER, true],
        [lib.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128, F.CODE_39, F.CODE_93, F.CODABAR, F.ITF, F.EAN_13, F.EAN_8, F.UPC_A, F.QR_CODE, F.DATA_MATRIX, F.PDF_417]],
      ]);
      return { reader: new BrowserMultiFormatReader(hints), jsQR: qr.default };
    }).catch((e) => { zx = null; throw e; });
  }
  return zx;
}

// Tries one picture: the whole of it, then the middle band (where the frame is) at twice the size.
function readCanvas({ reader, jsQR }, src, w, h) {
  const tries = [[0, 0, w, h, 1], [w * 0.1, h * 0.3, w * 0.8, h * 0.4, 2]];
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  for (const [x, y, cw, ch, k] of tries) {
    cv.width = Math.round(cw * k); cv.height = Math.round(ch * k);
    ctx.drawImage(src, x, y, cw, ch, 0, 0, cv.width, cv.height);
    try { return reader.decodeFromCanvas(cv).getText(); } catch { /* nothing in this crop */ }
    try { const d = ctx.getImageData(0, 0, cv.width, cv.height); const q = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' }); if (q?.data) return q.data; } catch { /* no QR */ }
  }
  return null;
}

export default function BarcodeScan({ open, onClose, onResult, title = 'Scan the courier barcode' }) {
  const videoRef = useRef(null);
  const fileRef = useRef(null);
  const done = useRef(onResult);
  done.current = onResult;
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(() => {});

  const found = (text) => {
    if (!text) return false;
    stopRef.current();
    try { navigator.vibrate?.(60); } catch { /* not supported */ }
    done.current(String(text).trim());
    return true;
  };

  useEffect(() => {
    if (!open) return undefined;
    let stopped = false;
    let stream = null;
    let timer = null;
    setError(''); setNote('');
    stopRef.current = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        v.srcObject = stream;
        await v.play();
        let native = null;
        if ('BarcodeDetector' in window) {
          try {
            const ok = await window.BarcodeDetector.getSupportedFormats();
            if (ok.includes('code_128')) native = new window.BarcodeDetector({ formats: FORMATS.filter((f) => ok.includes(f)) });
          } catch { native = null; }
        }
        const reader = native ? null : await zxing();
        const look = async () => {
          if (stopped) return;
          if (v.videoWidth) {
            if (native) {
              try { const codes = await native.detect(v); if (codes.length && found(codes[0].rawValue)) return; } catch { /* frame not ready */ }
            } else if (found(readCanvas(reader, v, v.videoWidth, v.videoHeight))) return;
          }
          timer = setTimeout(look, native ? 120 : 200);
        };
        look();
      } catch (e) {
        setError(e?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in the browser settings, or take a photo.' : 'The live camera could not start. Take a photo of the barcode instead.');
      }
    })();
    return () => stopRef.current();
  }, [open]);

  // A still photo at full resolution: sharper than the live picture on most cameras.
  const fromPhoto = async (file) => {
    if (!file) return;
    setBusy(true); setNote('');
    try {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
      let text = null;
      if ('BarcodeDetector' in window) {
        try { const codes = await new window.BarcodeDetector({ formats: FORMATS }).detect(img); text = codes[0]?.rawValue || null; } catch { /* try ZXing */ }
      }
      if (!text) text = readCanvas(await zxing(), img, img.naturalWidth, img.naturalHeight);
      if (!text) { // a very large photo: try it smaller too
        const small = new Image(); small.src = await shrink(file); await small.decode();
        text = readCanvas(await zxing(), small, small.naturalWidth, small.naturalHeight);
      }
      URL.revokeObjectURL(img.src);
      if (!found(text)) setNote('No barcode found in that photo. Take it closer, flat and in good light, or type the number.');
    } catch { setNote('That photo could not be read. Try again, or type the number.'); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} className="scanner" label={title}>
      <div className="scanner-head">
        <strong><Barcode />{title}</strong>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <p className="scanner-hint">Hold the label flat, 10 to 15 cm away, and fill the frame with the barcode. Not reading? Take a photo instead.</p>
      <div className="scan-stage scan-ready">
        {!error && <video ref={videoRef} playsInline muted className="scan-video" />}
        {!error && <div className="scan-frame barcode-frame" aria-hidden="true" />}
        {error && <div className="scan-idle"><Barcode /><span>{error}</span></div>}
      </div>
      {note && <p className="scanner-hint" role="status">{note}</p>}
      <button type="button" className="btn btn-block" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? <Spinner /> : <Camera />}Take a photo of the barcode</button>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { fromPhoto(e.target.files[0]); e.target.value = ''; }} />
    </Modal>
  );
}
