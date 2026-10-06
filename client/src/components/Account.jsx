import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Eye, EyeOff, KeyRound } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Spinner, useToast } from './ui.jsx';

// Change your own password. Other devices are signed out; this one stays signed in.
export function PasswordDialog({ open, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF({ current: '', next: '', confirm: '' }); setErr(''); setShow(false); } }, [open]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const tooShort = f.next.length > 0 && f.next.length < 10;
  const mismatch = f.confirm.length > 0 && f.next !== f.confirm;
  const ready = f.current && f.next.length >= 10 && f.next === f.confirm;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: f.current, next: f.next } });
      toast('Password changed. Any other device you were signed in on has been signed out.');
      onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  const type = show ? 'text' : 'password';
  return (
    <Modal open={open} onClose={onClose} label="Change password">
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2>Change your password</h2>
          <p>Use at least 10 characters. A short phrase is easier to remember than a jumble.</p>
        </div>
        <div className="dialog-body">
          <label className="field"><span>Current password</span>
            <input className="input" type={type} autoComplete="current-password" value={f.current} onChange={set('current')} autoFocus />
          </label>
          <label className="field"><span>New password</span>
            <input className="input" type={type} autoComplete="new-password" value={f.next} onChange={set('next')} aria-invalid={tooShort} />
            {tooShort && <span className="hint">{10 - f.next.length} more characters</span>}
          </label>
          <label className="field"><span>New password again</span>
            <input className="input" type={type} autoComplete="new-password" value={f.confirm} onChange={set('confirm')} aria-invalid={mismatch} />
            {mismatch && <span className="hint err">These don’t match yet</span>}
          </label>
          <label className="checkbox" style={{ fontSize: 13.5 }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span>{show ? <EyeOff size={14} /> : <Eye size={14} />} Show passwords</span>
          </label>
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy}>{busy ? <Spinner /> : <KeyRound />}Change password</button>
        </div>
      </form>
    </Modal>
  );
}

// Shows a one-time secret (a new staff password) with a copy button. Never stored anywhere in the app.
export function SecretBox({ value, label = 'Password', compact = false }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked: the value is on screen */ }
  };
  return (
    <div className="secret">
      <span className="secret-label">{label}</span>
      <code className={`secret-value ${compact ? 'sm' : ''}`}>{value}</code>
      <button type="button" className="btn btn-sm" onClick={copy}>{copied ? <><Check />Copied</> : <><Copy />Copy</>}</button>
    </div>
  );
}
