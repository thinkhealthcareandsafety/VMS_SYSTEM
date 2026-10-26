import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Building2, Check, CheckCircle2, Clock, Package, Truck, X, XCircle } from 'lucide-react';
import { api, fmtDateTime } from '../api.js';
import ImageViewer from '../components/ImageViewer.jsx';
import { Lockup, Spinner, useTitle, PoweredBy } from '../components/ui.jsx';

// The recipient's page for one parcel, opened from WhatsApp, Telegram or email. No login: the link is the
// credential. They see the photos security took, then say whether it is theirs.
const CLOSED = {
  accepted: { icon: CheckCircle2, tone: 'ok', title: 'You accepted it', text: 'Collect it from security, or send someone. They give their name and number at the desk.' },
  declined: { icon: XCircle, tone: 'bad', title: 'You declined it', text: 'Security will return it to the courier.' },
  superseded: { icon: AlertTriangle, tone: 'warn', title: 'A newer message was sent', text: 'Use the latest message for this parcel.' },
  expired: { icon: Clock, tone: 'warn', title: 'This link has expired', text: 'Call security about this parcel.' },
};

export default function ParcelResponse() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [actionError, setActionError] = useState('');
  const [zoom, setZoom] = useState(null);
  useTitle(info ? `Parcel ${info.number}` : 'Parcel');

  useEffect(() => { api(`/api/parcel-responses/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  const answer = async (decision) => {
    setBusy(decision); setActionError('');
    try {
      const r = await api(`/api/parcel-responses/${encodeURIComponent(token)}/decision`, { method: 'POST', body: { decision } });
      setResult(r.state);
    } catch (e) { setActionError(e.message); if (e.data?.state) setResult(e.data.state); } finally { setBusy(''); }
  };

  if (error) {
    return (
      <div className="approve-wrap"><div className="approve-brand"><Lockup /></div>
        <div className="approve-card"><div className="body"><div className="done-state"><div className="state-icon bad"><AlertTriangle /></div><h1>Link not valid</h1><p className="muted">This link is wrong or no longer exists. Call security about your parcel.</p></div></div></div>
      </div>
    );
  }
  if (!info) return <div className="splash"><Spinner size={22} /></div>;
  const state = result || info.state;
  const closed = state !== 'pending' ? (CLOSED[state] || { icon: Package, tone: 'ok', title: info.statusLabel, text: 'Nothing more to do here.' }) : null;
  const from = [info.sender?.company, info.sender?.name].filter(Boolean).join(', ');

  return (
    <div className="approve-wrap">
      <div className="approve-brand"><Lockup /></div>
      <article className="approve-card">
        <div className="body">
          <div>
            <p className="muted" style={{ marginBottom: 4 }}>Hi {info.recipientName?.split(' ')[0] || 'there'}, a parcel is at security for you</p>
            <h1>Parcel {info.number}</h1>
            <p className="muted">{info.pieces > 1 ? `${info.pieces} pieces · ` : ''}{info.typeLabel} · arrived {fmtDateTime(info.arrivedAt)}</p>
          </div>
          {info.photos.length > 0 && (
            <div className="parcel-photos">
              {info.photos.map((src, i) => <button type="button" key={src} onClick={() => setZoom(src)} aria-label={`Photo ${i + 1}, open full size`}><img src={src} alt="" /></button>)}
            </div>
          )}
          <div className="facts">
            <div className="fact"><Truck /><span>Courier</span><strong>{info.carrier}{info.awb ? ` · ${info.awb}` : ''}</strong></div>
            {from && <div className="fact"><Building2 /><span>From</span><strong>{from}</strong></div>}
            {info.note && <div className="fact"><Package /><span>Note</span><strong>{info.note}</strong></div>}
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
                <button className="btn btn-success btn-xl btn-block" disabled={Boolean(busy)} onClick={() => answer('accept')}>{busy === 'accept' ? <Spinner /> : <Check />}Accept, it is mine</button>
                <button className="btn btn-danger-outline btn-xl btn-block" disabled={Boolean(busy)} onClick={() => answer('decline')}>{busy === 'decline' ? <Spinner /> : <X />}Decline, not mine</button>
              </div>
            </>
          )}
        </div>
      </article>
      {!closed && <p className="approve-foot">Whoever collects it gives their name and number at the desk and is photographed. You will get a message saying who took it.</p>}
      <PoweredBy className="public-powered" />
      <ImageViewer open={Boolean(zoom)} onClose={() => setZoom(null)} src={zoom} alt="Parcel photo" title={`Parcel ${info.number}`} />
    </div>
  );
}
