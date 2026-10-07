import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, MessageSquare, RotateCcw, ShieldAlert } from 'lucide-react';
import { api } from '../api.js';
import { Spinner } from './ui.jsx';

const RESEND_AFTER = 30; // seconds; the server enforces the same gap

// Checks that the visitor really holds the number they gave: the server texts a 6-digit code to it and the
// visitor reads it out. `value` is null | 'verified' | 'skipped'. In "required" mode only admins may skip.
export default function MobileVerify({ mobile, mode, canSkip, value, onChange }) {
  const [sentAt, setSentAt] = useState(null);   // when the current code was sent
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');         // 'send' | 'check'
  const [error, setError] = useState('');
  const [test, setTest] = useState(false);      // server has no SMS provider yet: the code is only in its log
  const [, tick] = useState(0);
  const input = useRef(null);

  useEffect(() => { setSentAt(null); setCode(''); setError(''); setBusy(''); }, [mobile]);
  useEffect(() => {
    if (!sentAt) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [sentAt]);
  useEffect(() => { if (sentAt) input.current?.focus(); }, [sentAt]);

  const wait = sentAt ? Math.max(0, RESEND_AFTER - Math.round((Date.now() - sentAt) / 1000)) : 0;

  const send = async () => {
    setBusy('send'); setError('');
    try {
      const r = await api('/api/visits/otp/send', { method: 'POST', body: { mobile } });
      setSentAt(Date.now()); setCode(''); setTest(!r.live);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const check = async () => {
    setBusy('check'); setError('');
    try {
      await api('/api/visits/otp/verify', { method: 'POST', body: { mobile, code } });
      onChange('verified');
    } catch (e) {
      setError(e.data?.triesLeft != null ? `Wrong code. ${e.data.triesLeft} ${e.data.triesLeft === 1 ? 'try' : 'tries'} left.` : e.message);
      setCode('');
    } finally { setBusy(''); }
  };

  if (value === 'verified') {
    return <div className="alert alert-ok" role="status"><CheckCircle2 /><span className="grow"><strong>Number verified.</strong> The visitor confirmed the code.</span></div>;
  }
  if (value === 'skipped') {
    return (
      <div className="alert alert-warn" role="status">
        <ShieldAlert /><span className="grow">Number <strong>not verified</strong>. This is recorded on the visit.</span>
        <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>Verify now</button>
      </div>
    );
  }

  return (
    <div className="otp-box">
      <div className="otp-head">
        <MessageSquare />
        <span className="grow">
          <strong>Verify this number</strong>
          <small>{sentAt ? `A 6-digit code was sent to +91 ${mobile.slice(0, 5)} ${mobile.slice(5)}. Ask the visitor to read it out.` : `We text a code to the number; the visitor reads it out.${mode === 'required' ? ' Required at this gate.' : ''}`}</small>
        </span>
        {!sentAt && <button type="button" className="btn btn-sm btn-primary" disabled={busy === 'send'} onClick={send}>{busy === 'send' ? <Spinner /> : 'Send code'}</button>}
      </div>
      {sentAt && (
        <div className="otp-entry">
          <input
            ref={input} className="input num otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" aria-label="6-digit code"
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6 && !busy) { e.preventDefault(); check(); } }}
          />
          <button type="button" className="btn btn-primary" disabled={code.length !== 6 || Boolean(busy)} onClick={check}>{busy === 'check' ? <Spinner /> : 'Verify'}</button>
          <button type="button" className="btn" disabled={wait > 0 || Boolean(busy)} onClick={send}><RotateCcw />{wait > 0 ? `${wait}s` : 'Resend'}</button>
        </div>
      )}
      {test && <p className="hint">Test mode: no SMS provider is connected yet, so no text was sent. The code is in the server log.</p>}
      {error && <p className="hint err" role="alert">{error}</p>}
      {canSkip && (
        <button type="button" className="otp-skip" onClick={() => onChange('skipped')}>Can’t verify now (no signal, no phone)? Skip</button>
      )}
    </div>
  );
}
