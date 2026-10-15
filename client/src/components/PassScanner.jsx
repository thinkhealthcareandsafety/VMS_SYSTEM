import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera as CameraIcon, CameraOff, CheckCircle2, Hash, LogIn, LogOut, RotateCcw, ScanLine, ShieldAlert, X, XCircle } from 'lucide-react';
import { api, fmtUntil, passLabel } from '../api.js';
import { cue } from '../lib/notify.js';
import { readQr } from '../lib/qr.js';
import { Avatar, Modal, Spinner } from './ui.jsx';

// The gate scanner. One scan does the right thing for whoever holds the pass: inside -> out; outside on a
// valid pass -> in again; an event guest -> in on the list. The camera reads the QR, or a handheld scanner
// "types" it into the box (ending with Enter). Each result shows the person's photo big, so the guard can
// compare faces, and a mistaken scan can be undone for 30 seconds.
// A lost pass: type its number instead, see the photos that match, and press the button for the right person.
const SAME_CODE_PAUSE = 5000; // the same pass held in front of the camera is read once, not every frame
const UNDO_SECONDS = 30;

const TONE = { in: 'ok', out: 'ok', just_in: 'warn', just_out: 'warn', waiting: 'warn', busy: 'warn' };
const HEADLINE = {
  in: 'Let in', out: 'Checked out', just_in: 'Already inside', just_out: 'Already out', waiting: 'Not approved yet',
  declined: 'Do not let in', blocked: 'Do not admit', ended: 'Pass not valid', not_today: 'Not today', unknown: 'Unknown pass', busy: 'Try again', error: 'Could not check',
};
const ICON = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle };

export default function PassScanner({ open, onClose, onChanged }) {
  const videoRef = useRef(null);
  const inputRef = useRef(null);
  const last = useRef({ code: '', at: 0 });
  const busyRef = useRef(false);
  const [camera, setCamera] = useState(() => { try { return localStorage.getItem('vms.scan.camera') !== 'off'; } catch { return true; } });
  const [camError, setCamError] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);
  const [matches, setMatches] = useState(null); // people whose pass number was typed
  const [, setNow] = useState(0);

  const show = useCallback((r) => {
    const at = Date.now();
    const entry = { ...r, at, key: `${at}-${Math.random()}` };
    setResult(entry);
    setRecent((list) => [entry, ...list].slice(0, 8));
    const tone = r.ok ? 'ok' : TONE[r.result] || 'bad';
    if (tone === 'ok') cue.approved(); else if (tone === 'warn') cue.expired(); else cue.rejected();
    if (r.ok) onChanged?.();
  }, [onChanged]);

  const submit = useCallback(async (raw) => {
    const code = String(raw || '').trim();
    if (!code || busyRef.current) return;
    // Digits only: a pass number typed from a lost or unreadable pass.
    if (/^\d{1,4}$/.test(code)) { findByNumber(Number(code)); return; } // eslint-disable-line no-use-before-define
    const now = Date.now();
    if (code === last.current.code && now - last.current.at < SAME_CODE_PAUSE) return;
    last.current = { code, at: now };
    busyRef.current = true;
    setBusy(true);
    setMatches(null);
    let r;
    try { r = await api('/api/visits/scan', { method: 'POST', body: { code } }); } catch (e) {
      r = e.data?.result ? e.data : { ok: false, result: 'error', message: e.message };
    }
    busyRef.current = false;
    setBusy(false);
    setTyped('');
    show(r);
    inputRef.current?.focus();
  }, [show]);

  const findByNumber = async (n) => {
    setBusy(true);
    setResult(null);
    try {
      const d = await api('/api/visits/inside?all=1');
      const people = [...d.visits.map((v) => ({ ...v, where: 'inside' })), ...(d.away || []).map((v) => ({ ...v, where: 'away' }))]
        .filter((v) => v.dailyNumber === n);
      setMatches({ n, people });
    } catch (e) { setMatches({ n, people: [], error: e.message }); } finally { setBusy(false); setTyped(''); }
  };
  const actOn = async (v) => {
    setBusy(true);
    try {
      if (v.where === 'inside') {
        const r = await api(`/api/visits/${v.id}/checkout`, { method: 'POST' });
        show({ result: 'out', ok: true, message: r.status === 'away' ? `They keep the pass: it is valid till ${fmtUntil(r.validUntil)}. Scan it again when they come back.` : 'Take the pass back.', visit: toCard(v), undo: { action: 'out' } });
      } else {
        await api(`/api/visits/${v.id}/reenter`, { method: 'POST' });
        show({ result: 'in', ok: true, message: 'Let them in. Same pass, no new approval needed.', visit: toCard(v), undo: { action: 'in' } });
      }
      setMatches(null);
    } catch (e) {
      show({ result: e.data?.code === 'blocked' ? 'blocked' : 'error', ok: false, message: e.message, visit: toCard(v) });
      setMatches(null);
    } finally { setBusy(false); inputRef.current?.focus(); }
  };

  const undo = async (entry) => {
    try {
      const r = await api(`/api/visits/${entry.visit.id}/undo-scan`, { method: 'POST', body: { action: entry.undo.action } });
      setRecent((list) => list.map((x) => (x.key === entry.key ? { ...x, undone: true } : x)));
      setResult((cur) => (cur?.key === entry.key ? { ...cur, undone: true, message: r.message } : cur));
      cue.expired();
      onChanged?.();
    } catch (e) {
      setResult((cur) => (cur?.key === entry.key ? { ...cur, undoError: e.message } : cur));
    }
  };

  // Camera on while the scanner is open; read a frame about four times a second.
  useEffect(() => {
    if (!open || !camera) return undefined;
    let alive = true;
    let timer;
    let stream = null;
    setCamError('');
    if (!navigator.mediaDevices) { setCamError('This browser cannot use the camera here. Use a handheld scanner or type the code below.'); return undefined; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        const v = videoRef.current;
        if (v) { v.srcObject = s; v.play().catch(() => {}); }
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
      .catch(() => alive && setCamError('The camera is not available. Use a handheld scanner or type the code below.'));
    return () => { alive = false; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [open, camera, submit]);

  useEffect(() => { if (open) { setResult(null); setMatches(null); setTyped(''); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);
  // A good result clears after a few seconds so the next person sees a ready screen; a refusal stays longer.
  useEffect(() => {
    if (!result) return undefined;
    const t = setTimeout(() => setResult(null), result.ok && !result.undone ? 7000 : 10000);
    return () => clearTimeout(t);
  }, [result]);
  // Keeps the undo countdowns moving.
  useEffect(() => {
    if (!open || !recent.some((r) => r.undo && !r.undone && Date.now() - r.at < UNDO_SECONDS * 1000)) return undefined;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open, recent]);

  const toggleCamera = () => setCamera((on) => {
    try { localStorage.setItem('vms.scan.camera', on ? 'off' : 'on'); } catch { /* storage blocked */ }
    return !on;
  });
  const left = (r) => Math.max(0, UNDO_SECONDS - Math.floor((Date.now() - r.at) / 1000));
  const canUndo = (r) => r.ok && r.undo && !r.undone && left(r) > 0;
  const toneOf = (r) => (r.undone ? 'warn' : r.ok ? 'ok' : TONE[r.result] || 'bad');
  const tone = result ? toneOf(result) : 'ready';
  const Icon = result?.result === 'blocked' ? ShieldAlert : ICON[tone];
  const headline = (r) => (r.undone ? 'Undone' : HEADLINE[r.result] || 'Not let in');

  return (
    <Modal open={open} onClose={onClose} className="scanner" label="Scan a pass">
      <div className="scanner-head">
        <strong><ScanLine />Scan a pass</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={toggleCamera}>{camera ? <><CameraOff />Camera off</> : <><CameraIcon />Camera on</>}</button>
          <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X /></button>
        </div>
      </div>
      <p className="scanner-hint">Coming in or going out, just scan. Inside: they are checked out. Outside with a valid pass: they are let in again. <strong>Check the face against the photo.</strong></p>

      <div className={`scan-stage scan-${tone}`}>
        {camera && !camError && <video ref={videoRef} playsInline muted className="scan-video" />}
        {camera && !camError && tone === 'ready' && !matches && <div className="scan-frame" aria-hidden="true" />}
        {(!camera || camError) && tone === 'ready' && !matches && (
          <div className="scan-idle"><ScanLine /><span>{camError || 'Ready. Scan with the handheld scanner, or type the code from the pass.'}</span></div>
        )}
        {result && (
          <div className="scan-result" role="status" aria-live="assertive">
            <div className="scan-band"><Icon />{headline(result)}</div>
            {result.visit ? (
              <div className="scan-person">
                {result.visit.id ? <Avatar src={`/api/visits/${result.visit.id}/photo`} name={result.visit.name} size={120} square /> : <Avatar name={result.visit.name} size={120} square />}
                <strong>{result.visit.name}</strong>
                <span className="scan-meta">
                  {result.visit.dailyNumber != null && <span className="scan-pass">Pass {passLabel(result.visit)}</span>}
                  {result.visit.group ? `Guest of ${result.visit.group}` : result.visit.host ? `Meeting ${result.visit.host.name}, ${result.visit.host.unit}` : result.visit.company}
                </span>
              </div>
            ) : null}
            <span className="scan-msg">{result.undoError || result.message}</span>
            {canUndo(result) && (
              <button type="button" className="btn btn-sm scan-undo" onClick={() => undo(result)}><RotateCcw />Wrong person? Undo ({left(result)}s)</button>
            )}
          </div>
        )}
        {matches && !result && (
          <div className="scan-matches">
            <div className="scan-matches-head"><Hash />Pass {matches.n}{matches.people.length ? ': press the button for the person in front of you' : ''}</div>
            {matches.people.length === 0 ? (
              <p className="scan-none">{matches.error || `Nobody with pass ${matches.n} is inside or holding a valid pass. Check the number, or find them under On premises.`}</p>
            ) : matches.people.map((v) => (
              <div className="scan-match" key={v.id}>
                <Avatar src={`/api/visits/${v.id}/photo`} name={`${v.firstName} ${v.lastName}`} size={56} square />
                <span className="grow">
                  <strong>{v.firstName} {v.lastName}</strong>
                  <small>Pass {passLabel(v)} · {v.where === 'inside' ? 'inside' : `outside, valid till ${fmtUntil(v.validUntil)}`} · {v.host?.name}</small>
                </span>
                {v.where === 'inside'
                  ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => actOn(v)}><LogOut />Check out</button>
                  : <button type="button" className="btn btn-sm btn-success" disabled={busy} onClick={() => actOn(v)}><LogIn />Let in</button>}
              </div>
            ))}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setMatches(null); inputRef.current?.focus(); }}>Back to scanning</button>
          </div>
        )}
        {busy && <div className="scan-busy"><Spinner /></div>}
      </div>

      <form className="scan-type" onSubmit={(e) => { e.preventDefault(); last.current = { code: '', at: 0 }; submit(typed); }}>
        <input ref={inputRef} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Pass code or pass number"
          aria-label="Pass code or pass number" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        <button className="btn btn-primary" disabled={busy || !typed.trim()}>Check</button>
      </form>
      <p className="scanner-foot">Lost pass? Type the pass number and pick the person by their photo.</p>

      {recent.length > 0 && (
        <ol className="scan-recent" aria-label="Recent scans">
          {recent.map((r) => (
            <li key={r.key} className={toneOf(r)}>
              <span className="dot" />
              <span className="grow">{r.visit ? <>{r.visit.name}<span className="faint"> · {headline(r)}</span></> : headline(r)}</span>
              {canUndo(r) && r.key !== result?.key && <button type="button" className="btn btn-sm btn-ghost" onClick={() => undo(r)}><RotateCcw />Undo {left(r)}s</button>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

const toCard = (v) => ({
  id: v.id, name: `${v.firstName} ${v.lastName}`.trim(), company: v.company, dailyNumber: v.dailyNumber, dailyDay: v.dailyDay,
  host: v.host ? { name: v.host.name, unit: v.host.unit } : null, group: null,
});
