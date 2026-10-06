import { useEffect, useRef, useState } from 'react';
import { CameraOff, CheckCircle2, RefreshCcw, SwitchCamera } from 'lucide-react';
import { CARD_ASPECT, GUIDE_WIDTH, MASK_RECT, captureMaskedCard } from '../lib/aadhaarMask.js';

// mode="face": live photo. mode="aadhaar": card guide; the mask is burned into the pixels on capture.
export default function Camera({ mode, onCapture, captured, onRetake }) {
  const videoRef = useRef(null);
  const boxRef = useRef(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
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
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 960 } },
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

  const snap = () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    if (mode === 'aadhaar') return onCapture(captureMaskedCard(video, boxRef.current));
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
    return (
      <div className={`shot ${mode === 'aadhaar' ? 'card-shot' : ''}`}>
        <img src={captured} alt={mode === 'aadhaar' ? 'Captured Aadhaar card, number masked' : 'Captured visitor photo'} />
        <span className="ok-tag"><CheckCircle2 />{mode === 'aadhaar' ? 'Masked on this device' : 'Photo captured'}</span>
        <button type="button" className="btn btn-sm retake" onClick={onRetake}><RefreshCcw />Retake</button>
      </div>
    );
  }

  return (
    <div className={`camera ${mode}`} ref={boxRef}>
      <video ref={videoRef} playsInline muted autoPlay className={mode === 'face' && facing === 'user' ? 'mirror' : ''} />
      {ready && mode === 'face' && <div className="face-guide" />}
      {ready && mode === 'aadhaar' && (
        <>
          <span className="cam-tip">Fit the front of the card inside the frame</span>
          <div className="card-guide" style={{ width: `${GUIDE_WIDTH * 100}%`, aspectRatio: `${CARD_ASPECT}` }}>
            <i /><i /><i /><i />
            <div className="mask" style={{ left: `${MASK_RECT.x * 100}%`, top: `${MASK_RECT.y * 100}%`, width: `${MASK_RECT.w * 100}%`, height: `${MASK_RECT.h * 100}%` }}>XXXX XXXX</div>
          </div>
        </>
      )}
      {error && (
        <div className="cam-msg" role="alert">
          <CameraOff />
          <p>{error}</p>
        </div>
      )}
      {!error && (
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
