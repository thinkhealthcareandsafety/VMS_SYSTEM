import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CameraOff, CheckCircle2, Eraser, RefreshCcw, SwitchCamera, Undo2 } from 'lucide-react';
import { CARD_ASPECT, GUIDE_WIDTH, grabCard, maskCard, paintBoxes } from '../lib/aadhaarMask.js';
import { Spinner } from './ui.jsx';

// mode="face": live photo. mode="aadhaar": the card is read on this device, the number is found and
// painted out, and only the masked image is handed back (onCapture(dataUrl, info)).
export default function Camera({ mode, onCapture, captured, onRetake, info, onEdit }) {
  const videoRef = useRef(null);
  const boxRef = useRef(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [facing, setFacing] = useState('environment');

  useEffect(() => {
    if (captured) return undefined;
    let stream;
    let cancelled = false;
    setReady(false);
    setError('');
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(!window.isSecureContext
          ? 'The camera needs a secure (https) connection.'
          : err?.name === 'NotAllowedError'
            ? 'Camera access is blocked. Allow it in the browser settings, then try again.'
            : 'No camera found on this device.');
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [captured, facing]);

  const snap = async () => {
    const video = videoRef.current;
    if (!video?.videoWidth || busy) return;
    if (mode === 'aadhaar') {
      setBusy(true);
      try {
        const card = grabCard(video, boxRef.current);
        const result = await maskCard(card); // the unmasked card never leaves this function
        onCapture(result.dataUrl, result);
      } finally {
        setBusy(false);
      }
      return;
    }
    const canvas = document.createElement('canvas');
    const w = Math.min(720, video.videoWidth);
    canvas.width = w;
    canvas.height = Math.round((w / video.videoWidth) * video.videoHeight);
    const ctx = canvas.getContext('2d');
    if (facing === 'user') { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onCapture(canvas.toDataURL('image/jpeg', 0.82));
  };

  if (captured) {
    if (mode === 'aadhaar') return <MaskedCard image={captured} info={info} onRetake={onRetake} onEdit={onEdit} />;
    return (
      <div className="shot">
        <img src={captured} alt="Captured visitor photo" />
        <span className="ok-tag"><CheckCircle2 />Photo captured</span>
        <button type="button" className="btn btn-sm retake" onClick={onRetake}><RefreshCcw />Retake</button>
      </div>
    );
  }

  return (
    <div className={`camera ${mode}`} ref={boxRef}>
      <video ref={videoRef} playsInline muted autoPlay className={mode === 'face' && facing === 'user' ? 'mirror' : ''} />
      {ready && mode === 'face' && <div className="face-guide" />}
      {ready && mode === 'aadhaar' && !busy && (
        <>
          <span className="cam-tip">Fit the card in the frame. The number is hidden automatically.</span>
          <div className="card-guide" style={{ width: `${GUIDE_WIDTH * 100}%`, aspectRatio: `${CARD_ASPECT}` }}>
            <i /><i /><i /><i />
          </div>
        </>
      )}
      {busy && (
        <div className="cam-busy" role="status">
          <Spinner size={26} />
          <strong>Hiding the Aadhaar number…</strong>
          <span>Reading the card on this device. Nothing unmasked is sent.</span>
        </div>
      )}
      {error && (
        <div className="cam-msg" role="alert">
          <CameraOff />
          <p>{error}</p>
        </div>
      )}
      {!error && !busy && (
        <div className="cam-controls">
          <span className="cam-spacer" />
          <button type="button" className="shutter" onClick={snap} disabled={!ready} aria-label={mode === 'aadhaar' ? 'Capture card' : 'Take photo'} />
          <button type="button" className="cam-round" onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))} aria-label="Switch camera">
            <SwitchCamera />
          </button>
        </div>
      )}
    </div>
  );
}

// The masked card, with what the auto-mask did and a way to black out anything it missed.
function MaskedCard({ image, info, onRetake, onEdit }) {
  const imgRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState(null); // { x0, y0, x1, y1 } in displayed pixels
  const [history, setHistory] = useState([]);

  const status = info?.method === 'auto' && info.check
    ? { tone: 'warn', text: 'Number hidden. Check that no digit is still showing.' }
    : info?.method === 'auto'
    ? { tone: 'ok', text: `Aadhaar number found and hidden${info.numbers > 1 ? ` (${info.numbers} places)` : ''}${info.qr ? ', QR hidden' : ''}` }
    : info?.method === 'already'
      ? { tone: 'ok', text: 'Card was already masked' }
      : info?.method === 'guide'
        ? { tone: 'warn', text: 'Could not read the number. Check the first 8 digits are hidden, or black them out.' }
        : { tone: 'ok', text: 'Masked on this device' };

  const point = (e) => {
    const r = imgRef.current.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  };
  const down = (e) => { if (!drawing) return; e.currentTarget.setPointerCapture(e.pointerId); const p = point(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); };
  const move = (e) => { if (!drag) return; const p = point(e); setDrag((d) => ({ ...d, x1: p.x, y1: p.y })); };
  const up = async () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const img = imgRef.current;
    const k = img.naturalWidth / img.clientWidth;
    const rect = { x: Math.min(d.x0, d.x1) * k, y: Math.min(d.y0, d.y1) * k, w: Math.abs(d.x1 - d.x0) * k, h: Math.abs(d.y1 - d.y0) * k };
    if (rect.w < 8 || rect.h < 8) return; // a tap, not a box
    const next = await paintBoxes(image, [rect]);
    setHistory((h) => [...h, image]);
    onEdit(next);
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    onEdit(prev, { undo: true });
  };

  return (
    <div className={`shot card-shot ${drawing ? 'drawing' : ''}`}>
      <div className="paint-area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}>
        <img ref={imgRef} src={image} alt="Captured Aadhaar card, number masked" draggable={false} />
        {drag && (
          <span className="paint-box" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} />
        )}
      </div>
      {!drawing && (
        <span className={`ok-tag ${status.tone === 'warn' ? 'warn-tag' : ''}`}>
          {status.tone === 'warn' ? <AlertTriangle /> : <CheckCircle2 />}{status.text}
        </span>
      )}
      {drawing && <span className="ok-tag draw-tip"><Eraser />Drag over anything to black it out</span>}
      <div className="shot-actions">
        {drawing ? (
          <>
            {history.length > 0 && <button type="button" className="btn btn-sm" onClick={undo}><Undo2 />Undo</button>}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setDrawing(false)}>Done</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setDrawing(true)}><Eraser />Black out more</button>
            <button type="button" className="btn btn-sm" onClick={onRetake}><RefreshCcw />Retake</button>
          </>
        )}
      </div>
    </div>
  );
}
