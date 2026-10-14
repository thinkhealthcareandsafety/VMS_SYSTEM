import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Building2, CalendarDays, Check, CheckCircle2, Package, Target, Truck, X, XCircle } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { Lockup, Spinner, useTitle, PoweredBy } from '../components/ui.jsx';

// The head of department's page for one material gate pass, opened from WhatsApp or Telegram. No login: the
// single-use link is the credential. They see exactly what is leaving, then approve or decline.
const CLOSED = {
  approved: { icon: CheckCircle2, tone: 'ok', title: 'Approved', text: 'Security can let this material out.' },
  rejected: { icon: XCircle, tone: 'bad', title: 'Declined', text: 'Security will not let this material out.' },
  cancelled: { icon: XCircle, tone: 'bad', title: 'Cancelled', text: 'This pass was cancelled.' },
  superseded: { icon: AlertTriangle, tone: 'warn', title: 'A newer request was sent', text: 'Use the latest message for this pass.' },
  expired: { icon: AlertTriangle, tone: 'warn', title: 'This link has expired', text: 'Ask security to send the request again.' },
};

export default function ApproveMaterial() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [actionError, setActionError] = useState('');
  useTitle(info ? `Gate pass ${info.number}` : 'Gate pass');

  useEffect(() => { api(`/api/material-approvals/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  const decide = async (decision) => {
    setBusy(decision); setActionError('');
    try { await api(`/api/material-approvals/${encodeURIComponent(token)}/decision`, { method: 'POST', body: { decision } }); setResult(decision === 'approve' ? 'approved' : 'rejected'); } catch (e) { setActionError(e.message); if (e.data?.state) setResult(e.data.state); } finally { setBusy(''); }
  };

  if (error) {
    return (
      <div className="approve-wrap"><div className="approve-brand"><Lockup /></div>
        <div className="approve-card"><div className="body"><div className="done-state"><div className="state-icon bad"><AlertTriangle /></div><h1>Link not valid</h1><p className="muted">This link is wrong or no longer exists. Ask security to send it again.</p></div></div></div>
      </div>
    );
  }
  if (!info) return <div className="splash"><Spinner size={22} /></div>;
  const state = result || info.state;
  const closed = state !== 'pending' ? (CLOSED[state] || { icon: CheckCircle2, tone: 'ok', title: info.statusLabel, text: '' }) : null;
  const party = [info.party?.name, info.party?.company].filter(Boolean).join(', ');

  return (
    <div className="approve-wrap">
      <div className="approve-brand"><Lockup /></div>
      <article className="approve-card">
        <div className="body">
          <div>
            <p className="muted" style={{ marginBottom: 4 }}>Hi {info.approverName?.split(' ')[0]}, material is waiting at the gate</p>
            <h1>Gate pass {info.number}</h1>
            <p className="muted">{info.kindLabel}{info.returnBy ? ` · must come back by ${fmtDate(`${info.returnBy}T12:00:00+05:30`)}` : ''}</p>
          </div>
          <table className="table items-table">
            <thead><tr><th>Item</th><th className="r">Qty</th><th>Serial / tag</th></tr></thead>
            <tbody>{info.items.map((i) => <tr key={i.id}><td>{i.name}</td><td className="r num">{i.qty} {i.unit}</td><td className="mono">{i.serial || '—'}</td></tr>)}</tbody>
          </table>
          <div className="facts">
            <div className="fact"><Building2 /><span>Going to</span><strong>{party || '—'}</strong></div>
            {info.department && <div className="fact"><Package /><span>Department</span><strong>{info.department}</strong></div>}
            {info.purpose && <div className="fact"><Target /><span>Purpose</span><strong>{info.purpose}</strong></div>}
            {info.vehicle?.number && <div className="fact"><Truck /><span>Vehicle</span><strong className="mono">{info.vehicle.number}</strong></div>}
            {info.returnBy && <div className="fact"><CalendarDays /><span>Back by</span><strong>{fmtDate(`${info.returnBy}T12:00:00+05:30`)}</strong></div>}
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
                <button className="btn btn-success btn-xl btn-block" disabled={Boolean(busy)} onClick={() => decide('approve')}>{busy === 'approve' ? <Spinner /> : <Check />}Approve</button>
                <button className="btn btn-danger-outline btn-xl btn-block" disabled={Boolean(busy)} onClick={() => decide('reject')}>{busy === 'reject' ? <Spinner /> : <X />}Decline</button>
              </div>
            </>
          )}
        </div>
      </article>
      {!closed && <p className="approve-foot">Your decision is recorded with your name. Security lets the material out only after you approve.</p>}
      <PoweredBy className="public-powered" />
    </div>
  );
}
