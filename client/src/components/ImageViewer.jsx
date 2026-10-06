import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eraser, Minus, Plus, Undo2, X } from 'lucide-react';
import { Modal } from './ui.jsx';

const STEPS = [1, 1.5, 2, 3, 4];
const MIN = 1;
const MAX = 5;
const clamp = (z) => Math.min(MAX, Math.max(MIN, z));
const coarse = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

// Full-screen view of a photo or a masked ID, so the guard or admin can check the mask properly.
// Pinch, double-tap, click or Ctrl+scroll to zoom; drag to move around. When `editable`, the guard
// can switch to drawing and drag boxes to black out more, on the big image.
export default function ImageViewer({
  open, onClose, src, alt, title, status, editable = false, drawing = false, onDrawingChange, onPaint, canUndo = false, onUndo,
}) {
  const areaRef = useRef(null);
  const imgRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(null); // displayed width at zoom 1
  const [drag, setDrag] = useState(null); // box being drawn, in displayed pixels
  const [touch] = useState(coarse);
  const g = useRef({ pointers: new Map(), pinch: null, pan: null, anchor: null, moved: 0, lastTap: 0 });

  useEffect(() => { if (open) setZoom(1); }, [open, src]);

  // "Fit" = the largest size that shows the whole image inside the viewer.
  const measure = () => {
    const area = areaRef.current;
    const img = imgRef.current;
    if (!area || !img?.naturalWidth) return;
    const pad = 32;
    const w = area.clientWidth - pad;
    const h = area.clientHeight - pad;
    setFit(Math.max(120, Math.min(w, (h * img.naturalWidth) / img.naturalHeight)));
  };
  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, src]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom keeping the point under the finger or cursor (or the centre) where it is.
  const zoomTo = (next, cx, cy) => {
    const area = areaRef.current;
    const z = clamp(next);
    if (!area || Math.abs(z - zoom) < 0.001) return;
    const r = area.getBoundingClientRect();
    const i = imgRef.current.getBoundingClientRect();
    const x = cx ?? r.left + r.width / 2;
    const y = cy ?? r.top + r.height / 2;
    g.current.anchor = { x, y, fx: (x - i.left) / i.width, fy: (y - i.top) / i.height };
    setZoom(z);
  };
  useLayoutEffect(() => {
    const a = g.current.anchor;
    const area = areaRef.current;
    if (!a || !area) return;
    g.current.anchor = null;
    const i = imgRef.current.getBoundingClientRect();
    area.scrollLeft += i.left + a.fx * i.width - a.x;
    area.scrollTop += i.top + a.fy * i.height - a.y;
  }, [zoom]);

  // Ctrl+scroll and trackpad pinch on a laptop. Needs a non-passive listener to stop the page zooming.
  useEffect(() => {
    const area = areaRef.current;
    if (!open || !area) return undefined;
    const wheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    area.addEventListener('wheel', wheel, { passive: false });
    return () => area.removeEventListener('wheel', wheel);
  });

  // Keyboard: + and - zoom, 0 fits. Escape is handled by the dialog.
  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => {
      if (e.target.closest?.('input, textarea')) return;
      if (e.key === '+' || e.key === '=') zoomTo(stepUp(zoom));
      else if (e.key === '-' || e.key === '_') zoomTo(stepDown(zoom));
      else if (e.key === '0') zoomTo(1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const onImage = (x, y) => {
    const r = imgRef.current?.getBoundingClientRect();
    return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const imgPoint = (x, y) => {
    const r = imgRef.current.getBoundingClientRect();
    return { x: Math.min(Math.max(x - r.left, 0), r.width), y: Math.min(Math.max(y - r.top, 0), r.height) };
  };
  const two = () => {
    const [a, b] = [...g.current.pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const down = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const s = g.current;
    s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (s.pointers.size === 2) {
      setDrag(null); // a second finger means zoom, not draw
      const t = two();
      s.pinch = { d: t.d, zoom };
      s.pan = null;
      return;
    }
    if (s.pointers.size > 2) return;
    s.moved = 0;
    if (drawing && onImage(e.clientX, e.clientY)) {
      e.preventDefault();
      const p = imgPoint(e.clientX, e.clientY);
      setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    } else {
      const area = areaRef.current;
      s.pan = { x: e.clientX, y: e.clientY, sl: area.scrollLeft, st: area.scrollTop };
    }
  };

  const move = (e) => {
    const s = g.current;
    const prev = s.pointers.get(e.pointerId);
    if (!prev) return;
    s.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (s.pinch && s.pointers.size === 2) {
      const t = two();
      zoomTo(s.pinch.zoom * (t.d / s.pinch.d), t.x, t.y);
    } else if (drag) {
      const p = imgPoint(e.clientX, e.clientY);
      setDrag((d) => d && { ...d, x1: p.x, y1: p.y });
    } else if (s.pan) {
      const area = areaRef.current;
      area.scrollLeft = s.pan.sl - (e.clientX - s.pan.x);
      area.scrollTop = s.pan.st - (e.clientY - s.pan.y);
    }
  };

  const finishDrag = () => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    const img = imgRef.current;
    const k = img.naturalWidth / img.getBoundingClientRect().width;
    const rect = { x: Math.min(d.x0, d.x1) * k, y: Math.min(d.y0, d.y1) * k, w: Math.abs(d.x1 - d.x0) * k, h: Math.abs(d.y1 - d.y0) * k };
    if (rect.w >= 6 && rect.h >= 6) onPaint?.(rect); // ignore taps
  };

  const up = (e) => {
    const s = g.current;
    if (!s.pointers.has(e.pointerId)) return;
    s.pointers.delete(e.pointerId);
    if (s.pinch) {
      if (s.pointers.size < 2) s.pinch = null;
      // Carry on panning with the finger that is still down, without a jump.
      const rest = [...s.pointers.values()][0];
      const area = areaRef.current;
      s.pan = rest ? { x: rest.x, y: rest.y, sl: area.scrollLeft, st: area.scrollTop } : null;
      s.moved = 99; // the end of a pinch is not a tap
      return;
    }
    if (drag) { finishDrag(); return; }
    s.pan = null;
    if (drawing || s.moved > 6 || !onImage(e.clientX, e.clientY)) return;
    // A tap or click on the image: a click zooms on a computer, a double-tap on a phone.
    const toggle = () => zoomTo(zoom > 1.05 ? 1 : 2.5, e.clientX, e.clientY);
    if (e.pointerType === 'mouse') toggle();
    else if (e.timeStamp - s.lastTap < 320) { s.lastTap = 0; toggle(); }
    else s.lastTap = e.timeStamp;
  };

  const cancel = (e) => {
    const s = g.current;
    s.pointers.delete(e.pointerId);
    if (s.pointers.size < 2) s.pinch = null;
    s.pan = null;
    setDrag(null);
  };

  const zoomed = zoom > 1.05;
  const hint = touch ? 'Pinch or double-tap to zoom.' : 'Click to zoom. Drag to move around.';
  return (
    <Modal open={open} onClose={onClose} className="viewer" label={title || 'Image'}>
      <div className="viewer-bar">
        <div className="viewer-title">
          <strong>{title}</strong>
          {status && (
            <span className={`viewer-status ${status.tone === 'warn' ? 'warn' : ''}`}>
              {status.tone === 'warn' ? <AlertTriangle /> : <CheckCircle2 />}<span>{status.text}</span>
            </span>
          )}
        </div>
        <div className="viewer-zoom" role="group" aria-label="Zoom">
          <button type="button" className="vbtn" onClick={() => zoomTo(stepDown(zoom))} disabled={zoom <= MIN + 0.001} aria-label="Zoom out"><Minus /></button>
          <button type="button" className="vbtn vbtn-text" onClick={() => zoomTo(1)} title="Fit to screen (0)">{zoomed ? `${Math.round(zoom * 100)}%` : 'Fit'}</button>
          <button type="button" className="vbtn" onClick={() => zoomTo(stepUp(zoom))} disabled={zoom >= MAX - 0.001} aria-label="Zoom in"><Plus /></button>
        </div>
        <button type="button" className="vbtn" onClick={onClose} aria-label="Close"><X /></button>
      </div>

      <div
        ref={areaRef}
        className={`viewer-area ${drawing ? 'drawing' : ''} ${zoomed ? 'zoomed' : ''}`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
      >
        <div className="viewer-stage">
          <img ref={imgRef} src={src} alt={alt} draggable={false} onLoad={measure} style={fit ? { width: fit * zoom } : undefined} />
          {drag && (
            <span className="paint-box" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} />
          )}
        </div>
      </div>

      <div className="viewer-foot">
        {editable ? (
          drawing ? (
            <>
              <span className="viewer-hint"><Eraser />Drag over anything to black it out.{touch ? ' Pinch to zoom for small text.' : ' Zoom in with + for small text.'}</span>
              {canUndo && <button type="button" className="vbtn vbtn-text" onClick={onUndo}><Undo2 />Undo</button>}
              <button type="button" className="vbtn vbtn-solid" onClick={() => onDrawingChange?.(false)}>Done</button>
            </>
          ) : (
            <>
              <span className="viewer-hint">Check that the first 8 digits, and any QR code, are fully black. {hint}</span>
              {canUndo && <button type="button" className="vbtn vbtn-text" onClick={onUndo}><Undo2 />Undo</button>}
              <button type="button" className="vbtn vbtn-text" onClick={() => onDrawingChange?.(true)}><Eraser />Black out more</button>
              <button type="button" className="vbtn vbtn-solid" onClick={onClose}>Looks right</button>
            </>
          )
        ) : (
          <span className="viewer-hint">{hint}</span>
        )}
      </div>
    </Modal>
  );
}

function stepUp(z) { return STEPS.find((s) => s > z + 0.01) ?? MAX; }
function stepDown(z) { return [...STEPS].reverse().find((s) => s < z - 0.01) ?? MIN; }
