import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Building2, Check, CheckCircle2, Clock, Hash, LinkIcon, Target, X, XCircle, AlertTriangle } from 'lucide-react';
import { api, fmtTime } from '../api.js';
import { Logo, Spinner, useTitle } from '../components/ui.jsx';
import { useTick } from '../lib/live.js';

// Public page from the SMS link. The single-use token is the only credential.
const CLOSED = {
  approved: { icon: CheckCircle2, tone: 'ok', title: 'Visitor approved', text: 'Security has been told to let them in.' },
  rejected: { icon: XCircle, tone: 'bad', title: 'Visit declined', text: 'Security has been told not to let them in.' },
  expired: { icon: Clock, tone: 'warn', title: 'This request expired', text: 'Ask the security desk to send a new link.' },
  superseded: { icon: LinkIcon, tone: 'warn', title: 'A newer request was sent', text: 'Open the latest message from the security desk.' },
  cancelled: { icon: X, tone: 'warn', title: 'Request cancelled', text: 'The visitor left before you replied. Nothing more to do.' },
  checked_out: { icon: CheckCircle2, tone: 'ok', title: 'This visit is over', text: 'The visitor has already left.' },
  force_checked_out: { icon: CheckCircle2, tone: 'ok', title: 'This visit is over', text: 'The visitor has already left.' },
};

export default function Approve() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [actionError, setActionError] = useState('');
  const [photoOk, setPhotoOk] = useState(true);
  useTitle('Visitor at the gate');
  useTick(1000);

  useEffect(() => {
    api(`/api/approvals/${token}`).then(setInfo).catch((e) => setLoadError(e.message));
  }, [token]);

  const decide = async (decision) => {
    setBusy(decision);
    setActionError('');
    try {
      const res = await api(`/api/approvals/${token}/decision`, { method: 'POST', body: { decision } });
      setResult(res.status);
    } catch (err) {
      // Closed in the meantime (cancelled, expired, newer link): show that state instead of an error.
      if (err.data?.state && CLOSED[err.data.state]) setResult(err.data.state);
      else setActionError(err.message);
    } finally {
      setBusy('');
    }
  };

  if (loadError) {
    return (
      <div className="approve-wrap">
        <Logo />
        <div className="approve-card"><div className="body"><div className="done-state">
          <div className="state-icon bad"><AlertTriangle /></div>
          <h1>Link not valid</h1>
          <p className="muted">This approval link is wrong or no longer exists. Ask the security desk to send a new one.</p>
        </div></div></div>
      </div>
    );
  }
  if (!info) return <div className="splash"><Spinner size={22} /></div>;

  const leftMs = new Date(info.expiresAt).getTime() - Date.now();
  const timedOut = !result && info.state === 'pending' && leftMs <= 0;
  const state = result || (timedOut ? 'expired' : info.state);
  const closed = state !== 'pending' ? CLOSED[state] : null;
  const left = `${Math.floor(Math.max(0, leftMs) / 60000)}:${String(Math.floor((Math.max(0, leftMs) % 60000) / 1000)).padStart(2, '0')}`;
  const name = `${info.firstName} ${info.lastName}`;

  return (
    <div className="approve-wrap">
      <div className="approve-brand"><Logo />{info.siteName && <span className="approve-site">{info.siteName}</span>}</div>
      <article className="approve-card">
        {photoOk && !['cancelled', 'expired', 'superseded'].includes(state) && (
          <img className="photo" src={info.photoUrl} alt={`Photo of ${name} taken at the gate`} onError={() => setPhotoOk(false)} />
        )}
        <div className="body">
          <div>
            <p className="muted" style={{ marginBottom: 4 }}>Hi {info.hostName.split(' ')[0]}, someone is at the gate for you</p>
            <h1>{name}</h1>
          </div>
          <div className="facts">
            <div className="fact"><Building2 /><span>Coming from</span><strong>{info.company}</strong></div>
            {info.purpose && <div className="fact"><Target /><span>Purpose</span><strong>{info.purpose}</strong></div>}
            <div className="fact"><Clock /><span>Arrived</span><strong className="num">{fmtTime(info.arrivedAt)}</strong></div>
            <div className="fact"><Hash /><span>Visitor ID</span><strong className="mono">{info.ref}</strong></div>
          </div>

          {closed ? (
            <div className="done-state" role="status">
              <div className={`state-icon ${closed.tone}`}><closed.icon /></div>
              <h2 style={{ fontSize: 20 }}>{closed.title}</h2>
              <p className="muted">{closed.text}</p>
            </div>
          ) : (
            <>
              {actionError && <div className="alert alert-bad" role="alert"><AlertTriangle /><span>{actionError}</span></div>}
              <div className="approve-actions">
                <button className="btn btn-success btn-xl btn-block" disabled={Boolean(busy)} onClick={() => decide('approve')}>
                  {busy === 'approve' ? <Spinner /> : <Check />}Let them in
                </button>
                <button className="btn btn-danger-outline btn-xl btn-block" disabled={Boolean(busy)} onClick={() => decide('reject')}>
                  {busy === 'reject' ? <Spinner /> : <X />}Decline
                </button>
              </div>
              <p className="timer" style={{ justifyContent: 'center' }}><Clock size={14} />This link expires in {left}</p>
            </>
          )}
        </div>
      </article>
      {!closed && <p className="approve-foot">Didn’t expect anyone? Decline, and security will not let them in. Your decision is recorded.</p>}
    </div>
  );
}
