import { useEffect, useRef } from 'react';
import { Eraser } from 'lucide-react';

// A signature with a finger (or a stylus or mouse) on the tablet, in place of signing the paper register.
// Each stroke is drawn as it happens; when the finger lifts, the whole pad is handed back as a JPEG on white.
export default function SignaturePad({ value, onChange, label = 'Sign here' }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  // Sharp lines on high-density screens: the canvas is sized in device pixels.
  useEffect(() => {
    const cv = ref.current;
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = cv.getBoundingClientRect();
    cv.width = Math.round(width * ratio); cv.height = Math.round(height * ratio);
    const ctx = cv.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    inked.current = false;
  }, []);
  useEffect(() => { if (!value) clear(false); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const at = (e) => { const r = ref.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = (e) => {
    e.preventDefault();
    ref.current.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = ref.current.getContext('2d');
    const [x, y] = at(e);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke();
  };
  const move = (e) => {
    if (!drawing.current) return;
    const ctx = ref.current.getContext('2d');
    const [x, y] = at(e);
    ctx.lineTo(x, y); ctx.stroke();
    inked.current = true;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) onChange(ref.current.toDataURL('image/jpeg', 0.85));
  };
  function clear(tell = true) {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const { width, height } = cv.getBoundingClientRect();
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    inked.current = false;
    if (tell) onChange(null);
  }

  return (
    <div className="sign-pad">
      <canvas ref={ref} aria-label={label} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      {!value && <span className="sign-hint" aria-hidden="true">{label}</span>}
      <button type="button" className="btn btn-ghost btn-sm sign-clear" onClick={() => clear()} disabled={!value}><Eraser />Clear</button>
    </div>
  );
}
