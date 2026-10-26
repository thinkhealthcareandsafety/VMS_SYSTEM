import { useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import ImageViewer from './ImageViewer.jsx';

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
export function PhotoPicker({ photos, onChange, max = 3, addLabel = 'Add photo', onError, invalid = false }) {
  const fileRef = useRef(null);
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
        <span key={i} className="photo-thumb"><img src={p} alt={`Photo ${i + 1}`} /><button type="button" onClick={() => onChange(photos.filter((_, j) => j !== i))} aria-label={`Remove photo ${i + 1}`}><X /></button></span>
      ))}
      {photos.length < max && <button type="button" className="photo-add" onClick={() => fileRef.current?.click()}><Camera />{addLabel}</button>}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
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
