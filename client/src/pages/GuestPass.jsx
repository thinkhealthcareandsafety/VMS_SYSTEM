import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { AlertTriangle, CalendarDays, CheckCircle2, Sun, UserPlus } from 'lucide-react';
import { api } from '../api.js';
import { Lockup, Spinner, useTitle, PoweredBy } from '../components/ui.jsx';

// The guest's own pass, opened from the link they were sent. No login: the code in the link is the pass.
// The QR carries the same link, so the gate's camera or scanner reads it, and the code can be read out.
export function GuestPass() {
  const { code } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  useTitle(info ? `${info.group} pass` : 'Guest pass');

  useEffect(() => {
    api(`/api/passes/${encodeURIComponent(code)}`).then(setInfo).catch((e) => setError(e.message));
    QRCode.toDataURL(`${window.location.origin}/g/${code}`, { width: 560, margin: 1, errorCorrectionLevel: 'M' }).then(setQr).catch(() => {});
  }, [code]);

  if (error) return <PublicNote tone="bad" title="Pass not valid" text="This pass link is wrong or no longer exists. Ask the person who invited you." />;
  if (!info) return <div className="splash"><Spinner size={22} /></div>;
  const usable = info.state === 'valid' || info.state === 'upcoming';

  return (
    <div className="approve-wrap">
      <div className="approve-brand"><Lockup /></div>
      <article className="approve-card guest-pass">
        <div className="body">
          <div style={{ textAlign: 'center' }}>
            <h1>{info.name}</h1>
            <p className="guest-pass-event">{info.group}</p>
          </div>
          {usable ? (
            <>
              <div className="guest-qr">{qr ? <img src={qr} alt={`Pass QR code ${info.code}`} /> : <div className="skeleton" style={{ width: '100%', aspectRatio: '1', borderRadius: 16 }} />}</div>
              <div className="guest-code"><span>Pass code</span><strong className="mono">{info.code}</strong></div>
              <div className="facts">
                <div className="fact"><CalendarDays /><span>Valid</span><strong>{info.days}</strong></div>
              </div>
              <p className="guest-tip"><Sun size={15} />Show this screen at the gate. Turn your screen brightness up.</p>
              {info.state === 'upcoming' && <div className="alert"><CalendarDays /><span className="grow">This pass starts on the first day shown above.</span></div>}
            </>
          ) : (
            <div className="done-state" role="status">
              <div className="state-icon bad"><AlertTriangle /></div>
              <h2 style={{ fontSize: 20 }}>{info.state === 'over' ? 'This event is over' : 'This pass no longer works'}</h2>
              <p className="muted">{info.state === 'over' ? 'Thank you for coming.' : 'Please contact the person who invited you.'}</p>
            </div>
          )}
        </div>
      </article>
    </div>
  );
}

// The group's shared link: a guest adds themselves and is taken straight to their own pass.
export function JoinGroup() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ name: '', mobile: '', company: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useTitle(info ? `Join ${info.group}` : 'Guest list');

  useEffect(() => { api(`/api/passes/join/${encodeURIComponent(code)}`).then(setInfo).catch((e) => setError(e.message)); }, [code]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api(`/api/passes/join/${encodeURIComponent(code)}`, { method: 'POST', body: f });
      navigate(`/g/${r.code}`, { replace: true });
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  if (error) return <PublicNote tone="bad" title="Link not valid" text="This link is wrong or was replaced. Ask the host for a new one." />;
  if (!info) return <div className="splash"><Spinner size={22} /></div>;
  const closed = { closed: 'This link is closed. Ask the host for your pass.', over: 'This event is over.', full: 'All places on this link are taken. Ask the host for your pass.' }[info.state];

  return (
    <div className="approve-wrap">
      <div className="approve-brand"><Lockup /></div>
      <article className="approve-card">
        <div className="body">
          <div>
            <p className="muted" style={{ marginBottom: 4 }}>You are invited</p>
            <h1>{info.group}</h1>
            <p className="muted">{info.days}</p>
          </div>
          {closed ? (
            <div className="done-state" role="status">
              <div className="state-icon warn"><AlertTriangle /></div>
              <p className="muted">{closed}</p>
            </div>
          ) : (
            <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
              <p className="muted" style={{ fontSize: 14 }}>Add your details to get your entry pass. One pass per person.</p>
              <label className="field"><span>Full name</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" maxLength={80} /></label>
              <label className="field"><span>Mobile number</span>
                <div className="input-group"><span className="prefix">+91</span>
                  <input className="input num" required inputMode="numeric" autoComplete="tel-national" value={f.mobile} maxLength={11}
                    onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
                </div>
              </label>
              <label className="field"><span>Company or relation <span className="faint">· optional</span></span><input className="input" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} maxLength={80} /></label>
              {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
              <button className="btn btn-primary btn-xl btn-block" disabled={busy || f.name.trim().length < 2 || f.mobile.length !== 10}>{busy ? <Spinner /> : <UserPlus />}Get my pass</button>
              <p className="faint" style={{ fontSize: 12.5, textAlign: 'center' }}>Your name and number are used only to let you in, and are kept by the venue’s security.</p>
            </form>
          )}
        </div>
      </article>
      <PoweredBy className="public-powered" />
    </div>
  );
}

function PublicNote({ tone, title, text }) {
  return (
    <div className="approve-wrap">
      <div className="approve-brand"><Lockup /></div>
      <div className="approve-card"><div className="body"><div className="done-state">
        <div className={`state-icon ${tone}`}>{tone === 'bad' ? <AlertTriangle /> : <CheckCircle2 />}</div>
        <h1>{title}</h1>
        <p className="muted">{text}</p>
      </div></div></div>
    </div>
  );
}
