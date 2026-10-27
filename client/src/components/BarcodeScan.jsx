import { useEffect, useRef, useState } from 'react';
import { Barcode, X } from 'lucide-react';
import { Modal } from './ui.jsx';

// Reads the barcode on a courier label with the camera and hands back its text (the AWB / tracking number).
// The phone's own barcode reader where it has one (Chrome on Android), otherwise ZXing in the page, loaded only
// when a scan starts. A handheld USB / Bluetooth scanner needs none of this: it types into the field.
const FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'itf', 'ean_13', 'ean_8', 'upc_a', 'qr_code', 'data_matrix', 'pdf417'];

// The courier, when the number itself says so. Only formats that are unmistakable; anything else is left to the guard.
export function carrierFromAwb(awb) {
  const a = String(awb || '').toUpperCase();
  if (/^TBA\d{9,}$/.test(a)) return 'Amazon';
  if (/^FM[A-Z]{2}\d{8,}$/.test(a)) return 'Ekart (Flipkart)';
  if (/^SF\d{8,}[A-Z]*$/.test(a)) return 'Shadowfax';
  return '';
}

export default function BarcodeScan({ open, onClose, onResult, title = 'Scan the courier barcode' }) {
  const videoRef = useRef(null);
  const done = useRef(onResult);
  done.current = onResult;
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let stopped = false;
    let stream = null;
    let controls = null;
    let timer = null;
    setError('');
    const found = (text) => {
      if (stopped || !text) return;
      stopped = true;
      try { navigator.vibrate?.(60); } catch { /* not supported */ }
      done.current(String(text).trim());
    };
    (async () => {
      try {
        if ('BarcodeDetector' in window) {
          const supported = (await window.BarcodeDetector.getSupportedFormats?.()) || FORMATS;
          const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
          if (stopped) return;
          const v = videoRef.current;
          v.srcObject = stream;
          await v.play();
          const look = async () => {
            if (stopped) return;
            try { const codes = await detector.detect(v); if (codes.length) return found(codes[0].rawValue); } catch { /* frame not ready */ }
            timer = setTimeout(look, 120);
          };
          look();
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (stopped) return;
          controls = await new BrowserMultiFormatReader().decodeFromConstraints(
            { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false },
            videoRef.current,
            (result) => { if (result) found(result.getText()); },
          );
          if (stopped) controls.stop();
        }
      } catch (e) {
        setError(e?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in the browser settings, or type the number.' : 'The camera could not start. Type the number instead.');
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controls?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} className="scanner" label={title}>
      <div className="scanner-head">
        <strong><Barcode />{title}</strong>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <p className="scanner-hint">Hold the label flat and fill the frame with the barcode. It fills in by itself.</p>
      <div className="scan-stage scan-ready">
        {!error && <video ref={videoRef} playsInline muted className="scan-video" />}
        {!error && <div className="scan-frame barcode-frame" aria-hidden="true" />}
        {error && <div className="scan-idle"><Barcode /><span>{error}</span></div>}
      </div>
    </Modal>
  );
}
