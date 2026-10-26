import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, DoorOpen, Flame, ListChecks, Megaphone, PenLine, Phone, Printer, Search, Send, ShieldAlert, Siren, X,
} from 'lucide-react';
import { api, fmtMobile, fmtTime } from '../api.js';
import { printEvacuation } from '../lib/evacuation.js';
import { cue } from '../lib/notify.js';
import { Modal, Spinner, useToast } from './ui.jsx';

// Emergencies: pick a template (fire, evacuate, drill...), choose visitors, their hosts or both, change the words if
// needed, send. The first message starts an emergency with a roll call of everyone inside; staff tick people off at
// the assembly point; "All clear" ends it. The same emergency shows on every guard desk and admin screen.
const ICON = { fire: Flame, evacuate: DoorOpen, gas: AlertTriangle, shelter: ShieldAlert, drill: Siren, allclear: CheckCircle2, custom: PenLine };
const CHANNEL = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', telegram: 'Telegram' };
const AUDIENCE = { visitors: 'Visitors inside', hosts: 'Their hosts', both: 'Visitors and hosts' };

// The emergency going on, kept fresh by live events and a 20-second safety poll.
// A new emergency sounds the alarm on every screen that did not start it.
export function useEmergency(liveTick) {
  const [active, setActiveRaw] = useState(null);
  const known = useRef(undefined); // undefined until the first load, so an emergency already going on does not sound again
  const setActive = useCallback((em) => {
    const next = em && em.status === 'active' ? em : null;
    if (known.current !== undefined && next && next.id !== known.current) cue.overstay();
    known.current = next?.id || null;
    setActiveRaw(next);
  }, []);
  const mine = useCallback((em) => { known.current = em?.status === 'active' ? em.id : null; setActive(em); }, [setActive]);
  const load = useCallback(() => api('/api/emergency/active').then((r) => setActive(r.active)).catch(() => {}), [setActive]);
  useEffect(() => { load(); }, [load, liveTick]);
  useEffect(() => { const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  return [active, mine, load];
}

export function EmergencyBar({ active, onOpen }) {
  if (!active) return null;
  const left = active.total - active.safe;
  return (
    <button type="button" className="emergency-bar" onClick={onOpen}>
      <Siren />
      <span className="grow">
        <strong>Emergency: {active.title}</strong>
        <small>{active.total ? `${active.safe} of ${active.total} accounted for${left ? ` · ${left} still to find` : ' · everyone found'}` : 'Nobody was inside'} · started {fmtTime(active.startedAt)} by {active.startedBy}</small>
      </span>
      <span className="emergency-open">Open roll call</span>
    </button>
  );
}

export function EmergencyDialog({ open, onClose, active, onChanged, siteName }) {
  const [setup, setSetup] = useState(null);
  const [tab, setTab] = useState('send');
  const [preset, setPreset] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    setTab(active ? 'roll' : 'send');
    setPreset(null);
    api('/api/emergency/setup').then(setSetup).catch((e) => setErr(e.message));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open={open} onClose={onClose} className="dialog dialog-wide emergency" label="Emergency">
      <div className="dialog-head emergency-head">
        <div className="grow">
          <h2><Siren /> {active ? `Emergency: ${active.title}` : 'Emergency message'}</h2>
          <p>{active ? `Started ${fmtTime(active.startedAt)} by ${active.startedBy}${active.gate ? ` at ${active.gate}` : ''}.` : 'Choose what happened, who gets it, check the words, send. Everyone inside goes on a roll call.'}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      {active && (
        <div className="seg emergency-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'roll'} aria-pressed={tab === 'roll'} onClick={() => setTab('roll')}><ListChecks size={15} /> Roll call · {active.safe}/{active.total}</button>
          <button type="button" role="tab" aria-selected={tab === 'send'} aria-pressed={tab === 'send'} onClick={() => setTab('send')}><Megaphone size={15} /> Send a message</button>
        </div>
      )}
      {err && <div className="dialog-body"><div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div></div>}
      {!setup && !err && <div className="dialog-body"><div className="skeleton" style={{ height: 220, borderRadius: 12 }} /></div>}
      {setup && (tab === 'roll' && active
        ? <RollCall em={active} siteName={siteName} onChanged={onChanged} onAllClear={() => { setPreset('allclear'); setTab('send'); }} />
        : <Composer key={preset || 'none'} setup={setup} active={active} preset={preset} onSent={(em) => { onChanged(em); setTab('roll'); if (em.status === 'closed') onClose(); }} />)}
    </Modal>
  );
}

// ----------------------------------------------------------------------------- write and send
function Composer({ setup, active, preset, onSent }) {
  const toast = useToast();
  const choices = setup.templates.filter((t) => (active ? true : t.id !== 'allclear'));
  const [tpl, setTpl] = useState(() => setup.templates.find((t) => t.id === preset) || null);
  const [text, setText] = useState(() => setup.templates.find((t) => t.id === preset)?.text || '');
  const [audience, setAudience] = useState('both');
  const [allHosts, setAllHosts] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = (t) => { setTpl(t); setText(t.text); setArmed(false); setErr(''); if (t.id === 'allclear') setAudience('both'); };

  const c = setup.counts;
  const ch = Object.entries(setup.channels).filter(([, on]) => on).map(([k]) => CHANNEL[k]);
  const hosts = allHosts ? c.allHosts : c.theirHosts;
  const reach = (audience !== 'hosts' ? c.visitors : 0) + (audience !== 'visitors' ? hosts : 0);
  const send = async () => {
    if (!armed) { setArmed(true); return; }
    setBusy(true); setErr('');
    try {
      const em = await api('/api/emergency/send', { method: 'POST', body: { template: tpl.id, text, audience, allHosts } });
      toast(em.status === 'closed' ? 'All clear sent. The emergency is over.' : `Sent to ${em.sent.visitors} visitors and ${em.sent.hosts} hosts.`, 'ok');
      onSent(em);
    } catch (e) { setErr(e.message); setArmed(false); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="dialog-body">
        <div className="field">
          <span>1. What is happening</span>
          <div className="emergency-templates">
            {choices.map((t) => {
              const Icon = ICON[t.id] || Megaphone;
              return (
                <button type="button" key={t.id} className={`emergency-tpl tone-${t.tone || 'plain'}`} aria-pressed={tpl?.id === t.id} onClick={() => pick(t)}>
                  <Icon /><span>{t.title}</span>
                </button>
              );
            })}
          </div>
        </div>
        {tpl && (
          <>
            <div className="field">
              <span>2. Who gets it</span>
              <div className="seg" role="radiogroup" aria-label="Who gets it">
                {[['visitors', `Visitors (${c.visitors})`], ['hosts', `Hosts (${hosts})`], ['both', 'Both']].map(([k, l]) => (
                  <button type="button" key={k} role="radio" aria-checked={audience === k} aria-pressed={audience === k} onClick={() => { setAudience(k); setArmed(false); }}>{l}</button>
                ))}
              </div>
              {audience !== 'visitors' && (
                <label className="checkbox" style={{ fontSize: 14, marginTop: 6 }}>
                  <input type="checkbox" checked={allHosts} onChange={(e) => { setAllHosts(e.target.checked); setArmed(false); }} />
                  <span>All {c.allHosts} hosts on the list, not only the {c.theirHosts} with visitors inside</span>
                </label>
              )}
            </div>
            <label className="field">
              <span>3. The message <span className="faint">· change anything you need</span></span>
              <textarea className="textarea" rows={5} value={text} maxLength={setup.maxText} onChange={(e) => { setText(e.target.value); setArmed(false); }} placeholder="What should people do, and where should they go?" />
              <span className="hint">{text.length}/{setup.maxText}{audience !== 'visitors' ? ' · Hosts also get a line naming their visitors who are inside.' : ''}</span>
            </label>
            {!setup.assemblyPoint && tpl.text.includes('assembly point staff direct you to') && <div className="alert alert-warn"><AlertTriangle /><span className="grow">No assembly point is set. An admin can add it in Settings, or write it in the message above.</span></div>}
            {ch.length === 0
              ? <div className="alert alert-bad"><AlertTriangle /><span className="grow">No message channel is switched on, so nobody will receive this. Use the PA system and the printed list. The roll call still starts.</span></div>
              : <div className="alert"><Send /><span className="grow">Goes by {ch.join(', ')} to {reach} {reach === 1 ? 'person' : 'people'}.{setup.channels.sms ? '' : ' SMS is off: visitors who have not messaged the hotel’s WhatsApp number may not get it.'}</span></div>}
            {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
          </>
        )}
      </div>
      <div className="dialog-foot">
        {!tpl && <span className="faint foot-hint">Pick what is happening to continue.</span>}
        <button type="button" className={`btn ${tpl?.id === 'allclear' ? 'btn-success' : 'btn-danger'} emergency-send`} disabled={!tpl || busy || text.trim().length < 10} onClick={send} onBlur={() => setArmed(false)}>
          {busy ? <Spinner /> : <Send />}{armed ? `Tap again to send to ${reach}` : tpl?.id === 'allclear' ? 'Send all clear' : active ? 'Send update' : 'Send and start roll call'}
        </button>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------- roll call at the assembly point
function RollCall({ em, siteName, onChanged, onAllClear }) {
  const toast = useToast();
  const [show, setShow] = useState('missing');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const [ending, setEnding] = useState(false);
  const term = q.trim().toLowerCase();
  const missing = em.people.filter((p) => !p.safeAt);
  const list = (show === 'missing' ? missing : show === 'safe' ? em.people.filter((p) => p.safeAt) : em.people)
    .filter((p) => !term || `${p.name} ${p.company} ${p.host} ${p.hostUnit} ${p.pass} ${p.group}`.toLowerCase().includes(term));
  const mark = async (p) => {
    setBusy(p.visitId);
    try { onChanged(await api(`/api/emergency/${em.id}/safe`, { method: 'POST', body: { visitId: p.visitId, safe: !p.safeAt } })); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(null); }
  };
  const end = async () => {
    if (!ending) { setEnding(true); return; }
    try { onChanged(await api(`/api/emergency/${em.id}/close`, { method: 'POST' })); toast('Emergency ended without an all-clear message.'); } catch (e) { toast(e.message, 'bad'); }
  };
  const pct = em.total ? Math.round((em.safe / em.total) * 100) : 100;

  return (
    <>
      <div className="dialog-body">
        <div className="roll-progress">
          <div><strong className="num">{em.safe}</strong> of <strong className="num">{em.total}</strong> accounted for{missing.length ? <span className="tone-bad"> · {missing.length} still to find</span> : <span className="tone-ok"> · everyone found</span>}</div>
          <div className="roll-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="roll-tools">
          <div className="seg" role="tablist">
            {[['missing', `Still to find (${missing.length})`], ['safe', `Safe (${em.safe})`], ['all', 'All']].map(([k, l]) => (
              <button type="button" key={k} role="tab" aria-selected={show === k} aria-pressed={show === k} onClick={() => setShow(k)}>{l}</button>
            ))}
          </div>
          <div className="input-group"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, pass, host" aria-label="Search the roll call" /></div>
        </div>
        <ul className="roll-list">
          {list.length === 0 && <li className="faint" style={{ padding: 12 }}>{show === 'missing' && !term ? 'Everyone is accounted for.' : 'Nobody here.'}</li>}
          {list.map((p) => (
            <li key={p.visitId} className={p.safeAt ? 'is-safe' : ''}>
              {p.pass != null && <span className="pass-chip">{p.pass}</span>}
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>
                <small>{[p.company, p.group || (p.host && `to ${p.host}${p.hostUnit ? `, ${p.hostUnit}` : ''}`)].filter(Boolean).join(' · ')}{p.safeAt ? ` · safe ${fmtTime(p.safeAt)} (${p.safeBy})` : ''}</small>
              </span>
              {p.mobile && !p.safeAt && <a className="btn btn-sm btn-icon" href={`tel:${p.mobile}`} aria-label={`Call ${p.name}, ${fmtMobile(p.mobile)}`} title={`Call ${fmtMobile(p.mobile)}`}><Phone /></a>}
              <button type="button" className={`btn btn-sm ${p.safeAt ? 'btn-ghost' : 'btn-success'}`} disabled={busy === p.visitId} onClick={() => mark(p)}>
                {busy === p.visitId ? <Spinner /> : p.safeAt ? <X /> : <CheckCircle2 />}{p.safeAt ? 'Undo' : 'Safe'}
              </button>
            </li>
          ))}
        </ul>
        {em.messages.length > 0 && (
          <details className="more-fields">
            <summary><Megaphone size={15} /> Messages sent ({em.messages.length})</summary>
            <ol className="sent-list">
              {em.messages.map((m, i) => (
                <li key={i}>
                  <div><strong>{fmtTime(m.at)} · {m.title}</strong> <span className="faint">to {AUDIENCE[m.audience].toLowerCase()} · by {m.by}</span></div>
                  <p>{m.text}</p>
                  <div className="faint">{Object.entries(m.delivery || {}).map(([k, d]) => `${CHANNEL[k] || k}: ${d.sent} sent${d.queued ? `, ${d.queued} sending` : ''}${d.failed ? `, ${d.failed} failed` : ''}`).join(' · ') || 'No channel was on'}</div>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => printEvacuation({ siteName, onError: (m) => toast(m, 'bad') })}><Printer />Print list</button>
        <span className="spacer-x" />
        <button type="button" className={`btn ${ending ? 'btn-danger' : 'btn-ghost'}`} onClick={end} onBlur={() => setEnding(false)}>{ending ? 'Tap again: end without a message' : 'End emergency'}</button>
        <button type="button" className="btn btn-success" onClick={onAllClear}><CheckCircle2 />Send all clear</button>
      </div>
    </>
  );
}
