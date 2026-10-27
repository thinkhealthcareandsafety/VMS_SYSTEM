import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Save } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Spinner, useToast } from './ui.jsx';

// The GateSmartX licence on the hotel's own server: a bar on every screen when it is about to end or has ended,
// and the panel in Settings where the admin pastes a new key. Nothing shows when no licence is needed.
const dayText = (until) => fmtDate(`${until}T12:00:00+05:30`);

export function useLicense() {
  const [lic, setLic] = useState(null);
  const load = useCallback(() => api('/api/license').then(setLic).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 10 * 60e3); return () => clearInterval(t); }, [load]);
  return [lic, load];
}

export function LicenseBar({ admin = false, onOpen }) {
  const [lic] = useLicense();
  if (!lic || !['warn', 'expired', 'missing', 'clock'].includes(lic.state)) return null;
  const ended = lic.state !== 'warn';
  const text = lic.state === 'clock'
    ? 'The date on the server is wrong, so new entries are paused. Set the right date and time on the server.'
    : ended
      ? `The licence has ended: new check-ins, material and courier entries are paused. Check-outs, Emergency and all records still work. ${admin ? 'Enter the new licence key in Settings.' : 'Tell your admin.'}`
      : `The licence ends on ${dayText(lic.until)} (${lic.daysLeft} ${lic.daysLeft === 1 ? 'day' : 'days'} left). ${admin ? 'Ask GateSmartX for the renewal key.' : 'Tell your admin.'}`;
  return (
    <button type="button" className={`license-bar ${ended ? 'is-ended' : ''}`} onClick={onOpen} disabled={!onOpen}>
      <KeyRound /><span className="grow">{text}</span>
    </button>
  );
}

export function LicensePanel() {
  const toast = useToast();
  const [lic, reload] = useLicense();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!lic || !lic.required) return null;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/api/admin/license', { method: 'POST', body: { key } });
      setKey(''); reload(); toast(`Licence saved. Valid till ${dayText(r.until)}.`, 'ok');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const ok = ['ok', 'warn'].includes(lic.state);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Licence</h2></div>
      <div className="panel-body">
        <div className={`alert ${ok ? (lic.state === 'warn' ? 'alert-warn' : 'alert-ok') : 'alert-bad'}`}>
          {ok ? <CheckCircle2 /> : <AlertTriangle />}
          <span className="grow">
            {lic.state === 'missing' ? 'No licence key yet. Paste the key from GateSmartX below.'
              : lic.state === 'clock' ? 'The date on the server is wrong. Set the right date and time.'
                : `${lic.site} · valid till ${dayText(lic.until)}${lic.state === 'expired' ? ' · ended' : ` · ${lic.daysLeft} days left`}`}
          </span>
        </div>
        <label className="field"><span>New licence key</span>
          <textarea className="textarea mono" rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key exactly as GateSmartX sent it" />
        </label>
        {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        <button type="button" className="btn btn-primary" style={{ justifySelf: 'start' }} disabled={busy || key.trim().length < 40} onClick={save}>{busy ? <Spinner /> : <Save />}Save licence</button>
      </div>
    </section>
  );
}
