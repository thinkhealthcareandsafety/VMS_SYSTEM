import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CameraOff, CheckCircle2, Maximize2, RefreshCcw, SwitchCamera } from 'lucide-react';
import { CARD_ASPECT, GUIDE_WIDTH, grabCard, maskCard, paintBoxes } from '../lib/aadhaarMask.js';
import { Spinner } from './ui.jsx';
import ImageViewer from './ImageViewer.jsx';

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
    return <PhotoShot image={captured} onRetake={onRetake} />;
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

// The masked card. Tap it to open it full size and check the mask; "Black out more" opens the
// big view straight in drawing mode, where small text is easy to cover.
function MaskedCard({ image, info, onRetake, onEdit }) {
  const [viewer, setViewer] = useState(null); // null | { drawing }
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

  const paint = async (rect) => {
    const next = await paintBoxes(image, [rect]);
    setHistory((h) => [...h, image]);
    onEdit(next, { manual: true });
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    onEdit(prev, { manual: history.length > 1 }); // back to the auto-mask once every box is undone
  };

  return (
    <div className="shot card-shot">
      <button type="button" className="shot-open" onClick={() => setViewer({ drawing: false })} aria-label="Open the masked Aadhaar full size to check it">
        <img src={image} alt="Captured Aadhaar card, number masked" draggable={false} />
      </button>
      <span className={`ok-tag ${status.tone === 'warn' ? 'warn-tag' : ''}`}>
        {status.tone === 'warn' ? <AlertTriangle /> : <CheckCircle2 />}{status.text}
      </span>
      <div className="shot-actions">
        <button type="button" className={`btn btn-sm ${status.tone === 'warn' ? 'btn-primary' : ''}`} onClick={() => setViewer({ drawing: false })}><Maximize2 />Check full size</button>
        <button type="button" className="btn btn-sm" onClick={onRetake}><RefreshCcw />Retake</button>
      </div>
      <ImageViewer
        open={Boolean(viewer)}
        onClose={() => setViewer(null)}
        src={image}
        alt="Masked Aadhaar card"
        title="Masked Aadhaar"
        status={status}
        editable
        drawing={Boolean(viewer?.drawing)}
        onDrawingChange={(d) => setViewer({ drawing: d })}
        onPaint={paint}
        canUndo={history.length > 0}
        onUndo={undo}
      />
    </div>
  );
}

// The visitor photo, tappable to see it full size.
function PhotoShot({ image, onRetake }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shot">
      <button type="button" className="shot-open" onClick={() => setOpen(true)} aria-label="Open the photo full size">
        <img src={image} alt="Captured visitor photo" draggable={false} />
      </button>
      <span className="ok-tag"><CheckCircle2 />Photo captured</span>
      <button type="button" className="btn btn-sm retake" onClick={onRetake}><RefreshCcw />Retake</button>
      <ImageViewer open={open} onClose={() => setOpen(false)} src={image} alt="Visitor photo" title="Visitor photo" />
    </div>
  );
}
