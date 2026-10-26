import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, LogOut, Siren, TimerReset, X } from 'lucide-react';
import { api, fmtDuration, fmtTime, fmtUntil, passLabel, today } from '../api.js';
import { useTick } from '../lib/live.js';
import { cue } from '../lib/notify.js';
import { Avatar, Modal, Spinner, useToast } from './ui.jsx';

// ----------------------------------------------------------------------------- extend a pass
const EXTEND = [['1h', '+1 hour', 1], ['2h', '+2 hours', 2], ['4h', '+4 hours', 4], ['8h', '+8 hours', 8], ['today', 'Till tonight'], ['date', 'Pick a date']];
const MAX_DAYS = 90;
const addDays = (ymd, n) => { const t = new Date(`${ymd}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const NOTES = ['Host asked for more time', 'Meeting running late', 'Work not finished'];

// The new end, as the server will work it out: hours from the later of now and the current end.
function preview(visit, by, day) {
  const hours = EXTEND.find(([k]) => k === by)?.[2];
  if (hours) return new Date(Math.max(Date.now(), visit.validUntil ? new Date(visit.validUntil).getTime() : 0) + hours * 3600e3).toISOString();
  if (by === 'today') return `${today()}T23:59:00+05:30`;
  if (by === 'date' && day) return `${day}T23:59:00+05:30`;
  return null;
}

export function ExtendPassDialog({ visit, onClose, onDone }) {
  const toast = useToast();
  const [by, setBy] = useState('2h');
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (visit) { setBy('2h'); setDay(addDays(today(), 1)); setNote(''); setErr(''); } }, [visit]);
  if (!visit) return <Modal open={false} onClose={onClose} label="Extend pass" />;
  const until = preview(visit, by, day);
  const notLonger = until && visit.validUntil && new Date(until) <= new Date(visit.validUntil);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const v = await api(`/api/visits/${visit.id}/extend`, { method: 'POST', body: { by, ...(by === 'date' ? { day } : {}), note } });
      toast(`${visit.firstName} ${visit.lastName}’s pass now runs till ${fmtUntil(v.validUntil)}.`, 'ok');
      onDone?.(v);
      onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} label="Extend pass">
      <form onSubmit={save}>
        <div className="dialog-head">
          <h2>Extend {visit.firstName}’s pass</h2>
          <p>{visit.validUntil ? `Now valid till ${fmtUntil(visit.validUntil)}.` : 'No end set.'} Recorded with your name.</p>
        </div>
        <div className="dialog-body">
          <div className="field">
            <span id="ext-lbl">How much longer</span>
            <div className="chips" role="radiogroup" aria-labelledby="ext-lbl">
              {EXTEND.map(([k, l]) => <button type="button" key={k} role="radio" className="chip" aria-checked={by === k} aria-pressed={by === k} onClick={() => setBy(k)}>{l}</button>)}
            </div>
          </div>
          {by === 'date' && (
            <label className="field" style={{ maxWidth: 240 }}><span>Last day of the pass</span>
              <input className="input" type="date" min={today()} max={addDays(today(), MAX_DAYS)} value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
          )}
          <div className="field">
            <span>Reason <span className="faint">· optional</span></span>
            <div className="chips">{NOTES.map((n) => <button type="button" key={n} className="chip" aria-pressed={note === n} onClick={() => setNote(note === n ? '' : n)}>{n}</button>)}</div>
          </div>
          {until && <div className={`alert ${notLonger ? 'alert-warn' : 'alert-ok'}`}>{notLonger ? <AlertTriangle /> : <CheckCircle2 />}<span className="grow">{notLonger ? 'The pass already runs past that. Pick a longer time.' : `New end: ${fmtUntil(until)}`}</span></div>}
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !until || notLonger}>{busy ? <Spinner /> : <TimerReset />}Extend pass</button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- still inside after the pass ended
// A red bar while anyone is past their pass, and a pop-up that opens by itself: on the guard desk until each person
// is acknowledged (closing it only snoozes it for 2 minutes); on the admin console for each new one and each escalation.
const SNOOZE_MS = 2 * 60e3;
const ACK_NOTES = ['Calling the host', 'Going to check', 'Host says they are still in the meeting'];
const seenKey = (r) => `${r.id}:${r.escalatedAt ? 'e' : 'o'}`;

export function OverstayAlert({ admin = false, liveTick = 0, onChanged }) {
  const toast = useToast();
  useTick(30000);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [extend, setExtend] = useState(null);
  const [acking, setAcking] = useState(null);
  const [confirmOut, setConfirmOut] = useState(null);
  const [busy, setBusy] = useState(null);
  const snoozed = useRef(0);
  const seen = useRef(new Set());   // what has already opened the pop-up (and played the sound) on this screen

  const load = useCallback(() => api('/api/visits/overstays').then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load, liveTick]);
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]); // a pass can end with no event

  const rows = data?.rows || [];
  const unacked = rows.filter((r) => !r.ack);
  const escalated = rows.filter((r) => r.escalatedAt);
  useEffect(() => {
    if (!data) return;
    const due = admin ? rows.filter((r) => !r.ack || r.escalatedAt) : unacked;
    const fresh = due.filter((r) => !seen.current.has(seenKey(r)));
    fresh.forEach((r) => seen.current.add(seenKey(r)));
    if (fresh.length) { cue.overstay(); setOpen(true); return; }
    if (!admin && unacked.length && Date.now() > snoozed.current) setOpen(true);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && !rows.length) setOpen(false); }, [open, rows.length]);

  const close = () => { snoozed.current = Date.now() + SNOOZE_MS; setOpen(false); };
  const after = () => { load(); onChanged?.(); };
  const ack = async (r, note = '') => {
    setBusy(r.id);
    try { await api(`/api/visits/${r.id}/overstay-ack`, { method: 'POST', body: { note } }); setAcking(null); toast(`Acknowledged: ${r.firstName} ${r.lastName}.`, 'ok'); after(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(null); }
  };
  const checkout = async (r) => {
    if (confirmOut !== r.id) return setConfirmOut(r.id);
    setBusy(r.id);
    try { await api(`/api/visits/${r.id}/checkout`, { method: 'POST', body: { final: true } }); setConfirmOut(null); toast(`${r.firstName} ${r.lastName} checked out.`); after(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(null); }
  };

  if (!rows.length) return null;
  const minsOver = (r) => Math.max(0, Math.round((Date.now() - new Date(r.validUntil).getTime()) / 60000));
  const minsToEscalate = (r) => Math.max(0, Math.round((new Date(r.escalatesAt).getTime() - Date.now()) / 60000));

  return (
    <>
      <button type="button" className={`overstay-bar ${escalated.length ? 'is-escalated' : ''}`} onClick={() => setOpen(true)}>
        <Siren />
        <span className="grow">
          <strong>{rows.length === 1 ? '1 person is' : `${rows.length} people are`} still inside after the pass ended</strong>
          <small>{escalated.length ? `${escalated.length} escalated · ` : ''}{unacked.length ? `${unacked.length} not acknowledged · ` : ''}Tap to see and act</small>
        </span>
      </button>
      <Modal open={open} onClose={close} className="dialog dialog-wide" label="Pass ended, still inside">
        <div className="dialog-head">
          <h2>Pass ended, still inside</h2>
          <p>{admin ? 'Escalated an hour after the pass ends: the host and your escalation contacts are told.' : 'Acknowledge each person, then check them out if they have left, or extend the pass. After an hour it is escalated to the manager.'}</p>
        </div>
        <div className="dialog-body overstay-list">
          {rows.map((r) => {
            const name = `${r.firstName} ${r.lastName}`;
            return (
              <div key={r.id} className={`overstay-item ${r.escalatedAt ? 'is-escalated' : !r.ack ? 'is-new' : ''}`}>
                <Avatar src={`/api/visits/${r.id}/photo`} name={name} size={52} square />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="top">{r.dailyNumber != null && <span className="pass-chip">{passLabel(r)}</span>}<strong>{name}</strong></div>
                  <div className="meta">{r.company}{r.host ? ` · to ${r.host.name}, ${r.host.unit}` : ''}{r.lastIn?.gate ? ` · came in at ${r.lastIn.gate}` : ''}</div>
                  <div className="over"><Clock size={14} />Pass ended {fmtUntil(r.validUntil)} · <strong>{fmtDuration(minsOver(r))} over</strong></div>
                  <div className="state">
                    {r.escalatedAt ? <span className="badge badge-bad">Escalated {fmtTime(r.escalatedAt)}: host and manager told</span> : <span className="badge badge-warn">Escalates in {fmtDuration(minsToEscalate(r))} if still inside</span>}
                    {r.ack ? <span className="badge badge-ok">Seen by {r.ack.by} {fmtTime(r.ack.at)}{r.ack.note ? ` · ${r.ack.note}` : ''}</span> : <span className="badge badge-bad">Not acknowledged</span>}
                  </div>
                  {acking === r.id && (
                    <div className="chips" style={{ marginTop: 8 }}>
                      <button type="button" className="chip" disabled={busy === r.id} onClick={() => ack(r)}>Seen</button>
                      {ACK_NOTES.map((n) => <button type="button" key={n} className="chip" disabled={busy === r.id} onClick={() => ack(r, n)}>{n}</button>)}
                    </div>
                  )}
                </div>
                <div className="overstay-actions">
                  {!r.ack && acking !== r.id && <button type="button" className="btn btn-sm btn-primary" onClick={() => setAcking(r.id)}><CheckCircle2 />Acknowledge</button>}
                  {acking === r.id && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAcking(null)}><X />Cancel</button>}
                  <button type="button" className="btn btn-sm" onClick={() => setExtend({ ...r, id: r.id })}><TimerReset />Extend</button>
                  <button type="button" className={`btn btn-sm ${confirmOut === r.id ? 'btn-danger' : ''}`} disabled={busy === r.id} onClick={() => checkout(r)} onBlur={() => setConfirmOut((c) => (c === r.id ? null : c))}>
                    {busy === r.id ? <Spinner /> : <LogOut />}{confirmOut === r.id ? 'Tap again: they left' : 'Check out'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={close}>{!admin && unacked.length ? 'Remind me in 2 minutes' : 'Close'}</button>
        </div>
      </Modal>
      <ExtendPassDialog visit={extend} onClose={() => setExtend(null)} onDone={after} />
    </>
  );
}
