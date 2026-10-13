import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera as CameraIcon, CameraOff, CheckCircle2, Keyboard, ScanLine, X, XCircle } from 'lucide-react';
import { api } from '../api.js';
import { cue } from '../lib/notify.js';
import { readQr } from '../lib/qr.js';
import { Modal, Spinner } from './ui.jsx';

// Guest passes at the gate, one after another: the camera reads the QR, or a handheld scanner "types" the
// pass into the box (it ends with Enter). Each result shows big and sounds, then the next guest can come.
const SAME_CODE_PAUSE = 4000; // the same pass held in front of the camera is read once, not every frame

export default function PassScanner({ open, onClose, onChanged }) {
  const videoRef = useRef(null);
  const inputRef = useRef(null);
  const streamRef = useRef(null);
  const last = useRef({ code: '', at: 0 });
  const busyRef = useRef(false);
  const [camera, setCamera] = useState(() => { try { return localStorage.getItem('vms.scan.camera') !== 'off'; } catch { return true; } });
  const [camError, setCamError] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);

  const submit = useCallback(async (raw) => {
    const code = String(raw || '').trim();
    if (!code || busyRef.current) return;
    const now = Date.now();
    if (code === last.current.code && now - last.current.at < SAME_CODE_PAUSE) return;
    last.current = { code, at: now };
    busyRef.current = true;
    setBusy(true);
    let r;
    try {
      r = await api('/api/groups/scan', { method: 'POST', body: { code } });
    } catch (e) {
      r = { ok: false, result: e.data?.result || 'error', message: e.data?.message || e.message };
    }
    busyRef.current = false;
    setBusy(false);
    setTyped('');
    setResult({ ...r, at: now });
    setRecent((list) => [{ ...r, at: now }, ...list].slice(0, 6));
    if (r.ok) { cue.approved(); onChanged?.(); } else if (r.result === 'inside') cue.expired(); else cue.rejected();
    inputRef.current?.focus();
  }, [onChanged]);

  // Camera on while the scanner is open; read a frame about four times a second.
  useEffect(() => {
    if (!open || !camera) return undefined;
    let alive = true;
    let timer;
    setCamError('');
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      .then((stream) => {
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; v.play().catch(() => {}); }
        const loop = async () => {
          if (!alive) return;
          if (!busyRef.current) {
            const text = await readQr(videoRef.current).catch(() => null);
            if (text && alive) await submit(text);
          }
          timer = setTimeout(loop, 250);
        };
        loop();
      })
      .catch(() => alive && setCamError('The camera is not available. Use a scanner or type the pass code below.'));
    if (!navigator.mediaDevices) setCamError('This browser cannot use the camera here. Use a scanner or type the pass code below.');
    return () => {
      alive = false;
      clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open, camera, submit]);

  useEffect(() => { if (open) { setResult(null); setTyped(''); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);
  // The result fades back to "ready" after a while, so the next guest sees a neutral screen.
  useEffect(() => {
    if (!result) return undefined;
    const t = setTimeout(() => setResult(null), result.ok ? 4000 : 8000);
    return () => clearTimeout(t);
  }, [result]);

  const toggleCamera = () => setCamera((on) => {
    try { localStorage.setItem('vms.scan.camera', on ? 'off' : 'on'); } catch { /* storage blocked */ }
    return !on;
  });
  const tone = !result ? 'ready' : result.ok ? 'ok' : result.result === 'inside' ? 'warn' : 'bad';
  const Icon = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle }[tone];

  return (
    <Modal open={open} onClose={onClose} className="scanner" label="Scan guest passes">
      <div className="scanner-head">
        <strong><ScanLine />Scan guest passes</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={toggleCamera}>{camera ? <><CameraOff />Camera off</> : <><CameraIcon />Camera on</>}</button>
          <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X /></button>
        </div>
      </div>

      <div className={`scan-stage scan-${tone}`}>
        {camera && !camError && <video ref={videoRef} playsInline muted className="scan-video" />}
        {camera && !camError && tone === 'ready' && <div className="scan-frame" aria-hidden="true" />}
        {(!camera || camError) && tone === 'ready' && (
          <div className="scan-idle"><Keyboard /><span>{camError || 'Ready. Scan with the handheld scanner, or type the code.'}</span></div>
        )}
        {result && (
          <div className="scan-result" role="status" aria-live="assertive">
            <Icon />
            {result.guest ? <strong>{result.guest.name}</strong> : <strong>{tone === 'bad' ? 'Not let in' : ''}</strong>}
            {result.group && <span className="scan-group">{result.group.name}</span>}
            {result.ok && result.visit?.dailyNumber != null && <span className="scan-pass">Pass {result.visit.dailyNumber}</span>}
            <span className="scan-msg">{result.ok ? (result.result === 'reentered' ? 'Let in again' : 'Let in') : result.message}</span>
          </div>
        )}
        {busy && <div className="scan-busy"><Spinner /></div>}
      </div>

      <form className="scan-type" onSubmit={(e) => { e.preventDefault(); last.current = { code: '', at: 0 }; submit(typed); }}>
        <input ref={inputRef} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Scanner or pass code, e.g. K7M2-9QXP"
          aria-label="Pass code" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        <button className="btn btn-primary" disabled={busy || !typed.trim()}>Check</button>
      </form>

      {recent.length > 0 && (
        <ol className="scan-recent" aria-label="Recent scans">
          {recent.map((r) => (
            <li key={r.at} className={r.ok ? 'ok' : r.result === 'inside' ? 'warn' : 'bad'}>
              <span className="dot" />
              <span className="grow">{r.guest?.name || 'Unknown pass'}{r.group ? <span className="faint"> · {r.group.name}</span> : null}</span>
              <span className="faint">{r.ok ? `Pass ${r.visit?.dailyNumber ?? ''}` : r.result === 'inside' ? 'Already inside' : 'Refused'}</span>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
