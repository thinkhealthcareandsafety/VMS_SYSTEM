import { useEffect, useRef, useState } from 'react';
import { Aperture, Camera, SwitchCamera, Upload, X } from 'lucide-react';
import ImageViewer from './ImageViewer.jsx';
import { Modal } from './ui.jsx';

// Phones and tablets open their own camera app from the file picker (sharper, with focus and flash). A laptop or
// desktop has no such camera app, so it gets the live camera here instead.
const touchDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const hasCamera = () => typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

// The live camera in a window: Capture hands back a JPEG (longest side 1600 px), as an uploaded photo would be.
export function LiveShot({ open, onClose, onShot, title = 'Take a photo' }) {
  const videoRef = useRef(null);
  const [facing, setFacing] = useState('environment');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return undefined;
    let stream = null;
    let cancelled = false;
    setReady(false); setError('');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(async (s) => {
        stream = s;
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        videoRef.current.srcObject = s;
        await videoRef.current.play();
        setReady(true);
      })
      .catch((e) => { if (!cancelled) setError(e?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in the browser settings, or upload a photo.' : 'No camera could be started. Upload a photo instead.'); });
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [open, facing]);
  const capture = () => {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const s = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.round(v.videoWidth * s); cv.height = Math.round(v.videoHeight * s);
    cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
    onShot(cv.toDataURL('image/jpeg', 0.82));
  };
  return (
    <Modal open={open} onClose={onClose} className="scanner" label={title}>
      <div className="scanner-head">
        <strong><Camera />{title}</strong>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="scan-stage scan-ready">
        {!error && <video ref={videoRef} playsInline muted className="scan-video" />}
        {error && <div className="scan-idle"><Camera /><span>{error}</span></div>}
      </div>
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}><SwitchCamera />Switch camera</button>
        <button type="button" className="btn btn-primary btn-lg" disabled={!ready} onClick={capture}><Aperture />Capture</button>
      </div>
    </Modal>
  );
}

// A photo taken or chosen, made small enough to send over a weak connection (longest side 1600 px, JPEG).
export function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read. Take it again.')); };
    img.src = url;
  });
}

// Photos being added to a form: thumbnails with a remove button, and one "add" tile until the limit.
export function PhotoPicker({ photos, onChange, max = 3, addLabel = 'Take photo', onError, invalid = false }) {
  const fileRef = useRef(null);
  const uploadRef = useRef(null);
  const [zoom, setZoom] = useState(null);
  const [live, setLive] = useState(false);
  const desk = !touchDevice() && hasCamera();
  const add = async (files) => {
    const room = max - photos.length;
    const picked = [...files].slice(0, room);
    try {
      const shots = await Promise.all(picked.map(shrink));
      onChange([...photos, ...shots].slice(0, max));
    } catch (e) { onError?.(e.message); }
  };
  return (
    <div className="photo-strip" aria-invalid={invalid || undefined}>
      {photos.map((p, i) => (
        <span key={i} className="photo-thumb">
          <button type="button" className="photo-open" onClick={() => setZoom(p)} aria-label={`See photo ${i + 1} full size`}><img src={p} alt="" /></button>
          <button type="button" onClick={() => onChange(photos.filter((_, j) => j !== i))} aria-label={`Remove photo ${i + 1}`}><X /></button>
        </span>
      ))}
      {photos.length < max && <button type="button" className="photo-add" onClick={() => (desk ? setLive(true) : fileRef.current?.click())}><Camera />{addLabel}</button>}
      {photos.length < max && <button type="button" className="photo-add photo-upload" onClick={() => uploadRef.current?.click()}><Upload />Upload</button>}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <input ref={uploadRef} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <LiveShot open={live} onClose={() => setLive(false)} onShot={(d) => { onChange([...photos, d].slice(0, max)); if (photos.length + 1 >= max) setLive(false); }} />
      <ImageViewer open={Boolean(zoom)} onClose={() => setZoom(null)} src={zoom} alt="Photo" title="Photo" />
    </div>
  );
}

// Saved photos: tap one to see it full size.
export function PhotoRow({ srcs, title, label = 'Photo' }) {
  const [zoom, setZoom] = useState(null);
  if (!srcs?.length) return null;
  return (
    <>
      <div className="photo-strip">
        {srcs.map((src, i) => <button type="button" key={src} className="photo-thumb" onClick={() => setZoom(src)} aria-label={`${label} ${i + 1}, open full size`}><img src={src} alt="" loading="lazy" /></button>)}
      </div>
      <ImageViewer open={Boolean(zoom)} onClose={() => setZoom(null)} src={zoom} alt={label} title={title} />
    </>
  );
}
