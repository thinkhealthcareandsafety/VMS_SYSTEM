import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Building2, Check, ChevronDown, Clock, CreditCard, History, LogOut, Printer,
  RotateCcw, Search, Send, ShieldCheck, UserPlus, UserRound, Users, XCircle, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { api, fmtDate, fmtTime, fmtDuration, minutesSince } from '../api.js';
import { useLive, useTick } from '../lib/live.js';
import { Avatar, Empty, Logo, Spinner, useToast, initials } from '../components/ui.jsx';
import HostPicker from '../components/HostPicker.jsx';
import Camera from '../components/Camera.jsx';

const DRAFT_KEY = 'vms-guard-draft';
const EMPTY = { mobile: '', firstName: '', lastName: '', company: '', purpose: '' };
const NAME_RE = /^[\p{L} .'-]{1,60}$/u;
const PURPOSES = ['Delivery', 'Meeting', 'Interview', 'Service / repair', 'Guest'];

const store = {
  load() { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') }; } catch { return EMPTY; } },
  save(v) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch { /* storage blocked */ } },
  clear() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked */ } },
};

export default function GuardDesk({ user, onLogout }) {
  const toast = useToast();
  const [tab, setTab] = useState('checkin');
  const [inside, setInside] = useState(null);
  const [visit, setVisit] = useState(null); // submitted visit being tracked
  const visitRef = useRef(null);
  visitRef.current = visit;

  const refreshInside = useCallback(() => api('/api/visits/inside').then(setInside).catch(() => {}), []);
  const refreshVisit = useCallback(async (id) => {
    try {
      const v = await api(`/api/visits/${id}`);
      setVisit((cur) => (cur && cur.id === id ? { ...cur, ...v } : cur));
    } catch { /* keep last known state */ }
  }, []);

  const connected = useLive((evt) => {
    refreshInside();
    if (visitRef.current && evt.visitId === visitRef.current.id) refreshVisit(evt.visitId);
  });

  useEffect(() => {
    refreshInside();
    const t = setInterval(refreshInside, 30000); // safety net if the live stream drops
    return () => clearInterval(t);
  }, [refreshInside]);

  // Fallback poll while waiting, in case an event is missed.
  useEffect(() => {
    if (!visit || !['pending', 'approved'].includes(visit.status)) return undefined;
    const t = setInterval(() => refreshVisit(visit.id), connected ? 15000 : 4000);
    return () => clearInterval(t);
  }, [visit?.id, visit?.status, connected, refreshVisit]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = inside?.count ?? 0;

  return (
    <div className="app-guard">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Logo name="" />
          <div className="where">
            <strong>Main gate</strong>
            <small><span className={`live-dot ${connected ? '' : 'off'}`} />{connected ? 'Live' : 'Reconnecting'} · {count} on premises</small>
          </div>
        </div>
        <UserMenu user={user} onLogout={onLogout} />
      </header>

      <main className="guard-main">
        <div className="guard-split">
          <section className={tab === 'checkin' ? '' : 'hide-mobile'} aria-label="Check in">
            {visit ? (
              <Outcome
                visit={visit}
                connected={connected}
                onNext={() => { setVisit(null); refreshInside(); }}
                onResend={async () => {
                  try { await api(`/api/visits/${visit.id}/resend`, { method: 'POST' }); toast('New approval SMS sent.'); refreshVisit(visit.id); } catch (e) { toast(e.message, 'bad'); }
                }}
                onReprint={async () => {
                  try { await api(`/api/visits/${visit.id}/reprint`, { method: 'POST' }); toast('Sticker sent to the printer.'); refreshVisit(visit.id); } catch (e) { toast(e.message, 'bad'); }
                }}
              />
            ) : (
              <CheckInForm onSubmitted={(v) => { setVisit(v); refreshInside(); }} />
            )}
          </section>
          <aside className={tab === 'inside' ? '' : 'hide-mobile'} aria-label="On premises">
            <InsideList data={inside} onChanged={refreshInside} />
          </aside>
        </div>
      </main>

      <nav className="tabbar" role="tablist" aria-label="Guard views">
        <button role="tab" aria-selected={tab === 'checkin'} onClick={() => setTab('checkin')}><UserPlus />Check in</button>
        <button role="tab" aria-selected={tab === 'inside'} onClick={() => setTab('inside')}>
          <Users />On premises
          {count > 0 && <span className="count">{count}</span>}
        </button>
      </nav>
    </div>
  );
}

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" style={{ paddingLeft: 4 }}>
        <Avatar name={user.fullName} size={30} />
        <ChevronDown />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="who"><strong>{user.fullName}</strong><small>Security guard · {user.username}</small></div>
          <button role="menuitem" onClick={onLogout}><LogOut />Sign out</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Check-in (single page)
function CheckInForm({ onSubmitted }) {
  const [form, setForm] = useState(store.load);
  const [host, setHost] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [idImage, setIdImage] = useState(null);
  const [idConfirmed, setIdConfirmed] = useState(false);
  const [cam, setCam] = useState('face'); // which camera is live; only one at a time (phones cannot run two)
  const [returning, setReturning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);
  const sec = { visitor: useRef(null), host: useRef(null), capture: useRef(null) };

  const update = (patch) => setForm((f) => { const next = { ...f, ...patch }; store.save(next); return next; });
  const digits = form.mobile.replace(/\D/g, '');

  // Returning visitor: fill name and company straight away if the guard has not typed them.
  useEffect(() => {
    setReturning(null);
    if (digits.length !== 10) return undefined;
    let live = true;
    api(`/api/visits/lookup?mobile=${digits}`).then((r) => {
      if (!live || !r.found) return;
      setReturning(r);
      setForm((f) => {
        if (f.firstName.trim() || f.lastName.trim()) return f;
        const next = { ...f, firstName: r.firstName, lastName: r.lastName, company: f.company || r.company };
        store.save(next);
        return next;
      });
    }).catch(() => {});
    return () => { live = false; };
  }, [digits]);

  const checks = [
    ['visitor', digits.length === 10, '10-digit mobile'],
    ['visitor', NAME_RE.test(form.firstName.trim()), 'first name'],
    ['visitor', NAME_RE.test(form.lastName.trim()), 'last name'],
    ['visitor', form.company.trim().length > 0, 'company'],
    ['host', Boolean(host), 'host'],
    ['capture', Boolean(photo), 'photo'],
    ['capture', Boolean(idImage), 'Aadhaar'],
    ['capture', !idImage || idConfirmed, 'Aadhaar mask check'],
  ];
  const missing = checks.filter(([, ok]) => !ok);
  const done = (s) => checks.every(([k, ok]) => k !== s || ok);

  const reset = () => {
    store.clear();
    setForm(EMPTY); setHost(null); setPhoto(null); setIdImage(null); setIdConfirmed(false);
    setCam('face'); setTried(false); setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async () => {
    setTried(true);
    if (missing.length) {
      sec[missing[0][0]].current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api('/api/visits', {
        method: 'POST',
        body: { ...form, mobile: digits, hostId: host.id, photo, idImage, idMaskConfirmed: idConfirmed },
      });
      store.clear();
      onSubmitted({ id: res.id, ref: res.ref, status: res.status, firstName: form.firstName.trim(), lastName: form.lastName.trim(), company: form.company.trim(), host: { name: host.name, unit: host.unit }, photo, createdAt: new Date().toISOString() });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const flag = (s) => (tried && !done(s) ? 'card needs' : 'card');

  return (
    <div className="checkin">
      <div className="step-title">
        <h1>New visitor</h1>
        <p>Fill in everything below, then send. The host gets an SMS to approve.</p>
      </div>

      <section className={flag('visitor')} ref={sec.visitor} aria-labelledby="sec-visitor">
        <SectionHead id="sec-visitor" n={1} title="Visitor" done={done('visitor')} />
        <label className="field">
          <span>Mobile number</span>
          <div className="input-group">
            <span className="prefix">+91</span>
            <input className="input num" inputMode="numeric" autoComplete="off" maxLength={11} placeholder="98765 43210"
              value={digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits}
              onChange={(e) => update({ mobile: e.target.value.replace(/\D/g, '').slice(0, 10) })} autoFocus />
          </div>
        </label>
        {returning && (
          <div className="returning">
            <History />
            <span className="grow">Returning visitor, {returning.visits} {returning.visits === 1 ? 'visit' : 'visits'}, last on {fmtDate(returning.lastVisit)}. Details filled in.</span>
          </div>
        )}
        <div className="grid-2">
          <label className="field"><span>First name</span><input className="input" value={form.firstName} onChange={(e) => update({ firstName: e.target.value })} autoComplete="off" autoCapitalize="words" maxLength={60} /></label>
          <label className="field"><span>Last name</span><input className="input" value={form.lastName} onChange={(e) => update({ lastName: e.target.value })} autoComplete="off" autoCapitalize="words" maxLength={60} /></label>
        </div>
        <label className="field"><span>Company or coming from</span><input className="input" value={form.company} onChange={(e) => update({ company: e.target.value })} autoComplete="off" maxLength={100} placeholder="e.g. Blue Dart, Infosys, Personal" /></label>
        <div className="field">
          <span>Purpose <span className="faint">· optional</span></span>
          <div className="chips" role="group" aria-label="Purpose">
            {PURPOSES.map((p) => (
              <button type="button" key={p} className="chip" aria-pressed={form.purpose === p} onClick={() => update({ purpose: form.purpose === p ? '' : p })}>{p}</button>
            ))}
          </div>
        </div>
      </section>

      <section className={flag('host')} ref={sec.host} aria-labelledby="sec-host">
        <SectionHead id="sec-host" n={2} title="Whom to meet" done={done('host')} />
        <HostPicker value={host} onChange={setHost} />
      </section>

      <section className={flag('capture')} ref={sec.capture} aria-labelledby="sec-capture">
        <SectionHead id="sec-capture" n={3} title="Photo and Aadhaar" done={done('capture')} />
        <div className="capture-grid">
          <div className="field">
            <span>Live photo <span className="faint">· no mask or cap</span></span>
            {photo || cam === 'face'
              ? <Camera mode="face" captured={photo} onCapture={(p) => { setPhoto(p); if (!idImage) setCam('aadhaar'); else setCam(null); }} onRetake={() => { setPhoto(null); setCam('face'); }} />
              : <CamTile icon={UserRound} label="Take photo" onClick={() => setCam('face')} />}
          </div>
          <div className="field">
            <span>Aadhaar card <span className="faint">· first 8 digits blacked out</span></span>
            {idImage || cam === 'aadhaar'
              ? <Camera mode="aadhaar" captured={idImage} onCapture={(p) => { setIdImage(p); setCam(null); }} onRetake={() => { setIdImage(null); setIdConfirmed(false); setCam('aadhaar'); }} />
              : <CamTile icon={CreditCard} label="Scan Aadhaar" onClick={() => setCam('aadhaar')} />}
          </div>
        </div>
        {idImage && (
          <label className={`checkbox attest ${idConfirmed ? 'checked' : ''}`}>
            <input type="checkbox" checked={idConfirmed} onChange={(e) => setIdConfirmed(e.target.checked)} />
            <span><strong>The first 8 digits are fully hidden.</strong><br /><span className="muted">If any digit shows, retake with the card inside the frame.</span></span>
          </label>
        )}
      </section>

      {error && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{error}</span></div>}

      <div className="footer-bar">
        <div className="inner">
          {tried && missing.length > 0 && <p className="need">Still needed: {missing.map(([, , l]) => l).join(', ')}</p>}
          <button type="button" className="btn btn-xl" onClick={reset} disabled={busy}>Clear</button>
          <button type="button" className="btn btn-primary btn-xl" disabled={busy} onClick={submit}>
            {busy ? <><Spinner />Sending</> : <><Send />Send for approval</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionHead({ id, n, title, done }) {
  return (
    <div className="sec-head">
      <span className={`sec-n ${done ? 'done' : ''}`} aria-hidden="true">{done ? <Check /> : n}</span>
      <h2 id={id}>{title}</h2>
    </div>
  );
}

function CamTile({ icon: Icon, label, onClick }) {
  return (
    <button type="button" className="cam-tile" onClick={onClick}>
      <Icon />
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------- After submit
function Outcome({ visit, onNext, onResend, onReprint }) {
  useTick(1000);
  const name = `${visit.firstName} ${visit.lastName}`;
  const secs = Math.max(0, Math.round((Date.now() - new Date(visit.createdAt).getTime()) / 1000));
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="card outcome" aria-live="polite">
      {visit.status === 'pending' && (
        <>
          <div className="wait-ring"><Avatar name={visit.host.name} size={84} /></div>
          <div>
            <h1>Waiting for {visit.host.name.split(' ')[0]}</h1>
            <p className="lead" style={{ margin: '6px auto 0' }}>An SMS was sent to {visit.host.name} ({visit.host.unit}). This screen updates the moment they respond.</p>
          </div>
          <span className="timer"><Clock size={15} />Waiting {elapsed}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn" onClick={onResend} disabled={secs < 30}><RotateCcw />{secs < 30 ? `Resend in ${30 - secs}s` : 'Resend SMS'}</button>
            <button className="btn btn-ghost" onClick={onNext}>Check in someone else</button>
          </div>
        </>
      )}

      {visit.status === 'approved' && (
        <>
          <div className="pass" role="img" aria-label={`Visitor pass number ${visit.dailyNumber} for ${name}`}>
            <div className="pass-top">
              <div><small>Visitor pass · {fmtDate(visit.decidedAt || new Date())}</small><span className="pass-no">{visit.dailyNumber}</span></div>
              <Logo name="" dark />
            </div>
            <div className="pass-body">
              <div className="who">
                <span className="avatar" style={{ '--s': '48px', borderRadius: 12 }}>{visit.photo ? <img src={visit.photo} alt="" /> : initials(name)}</span>
                <div><strong>{name}</strong><span className="muted">{visit.company}</span></div>
              </div>
              <div className="pass-row">
                <div><small>Meeting</small>{visit.host.name}</div>
                <div><small>Flat / dept</small>{visit.host.unit}</div>
                <div><small>Entry</small><span className="num">{fmtTime(visit.decidedAt)}</span></div>
                <div><small>Visitor ID</small><span className="mono">{visit.ref}</span></div>
              </div>
            </div>
            <div className="pass-perf" />
            <div className="pass-foot">
              <PrintStatus status={visit.printStatus} />
              <button className="btn btn-sm" onClick={onReprint}><Printer />Reprint</button>
            </div>
          </div>
          <p className="lead">Approved by {visit.host.name}. Hand over the sticker and let the visitor in.</p>
          <button className="btn btn-primary btn-xl btn-block" style={{ maxWidth: 340 }} onClick={onNext}><UserPlus />Next visitor</button>
        </>
      )}

      {visit.status === 'rejected' && (
        <>
          <div className="state-icon bad"><XCircle /></div>
          <div><h1>Entry declined</h1><p className="lead" style={{ margin: '6px auto 0' }}>{visit.host.name} declined this visit. Do not let {visit.firstName} in.</p></div>
          <button className="btn btn-primary btn-xl btn-block" style={{ maxWidth: 340 }} onClick={onNext}>Done</button>
        </>
      )}

      {visit.status === 'expired' && (
        <>
          <div className="state-icon warn"><Clock /></div>
          <div><h1>No response yet</h1><p className="lead" style={{ margin: '6px auto 0' }}>{visit.host.name} did not respond in time. Send a fresh link, or ask the visitor to call them.</p></div>
          <div style={{ display: 'grid', gap: 8, width: '100%', maxWidth: 340 }}>
            <button className="btn btn-primary btn-xl" onClick={onResend}><RotateCcw />Resend approval SMS</button>
            <button className="btn btn-ghost" onClick={onNext}>Cancel and start over</button>
          </div>
        </>
      )}
    </div>
  );
}

function PrintStatus({ status }) {
  if (status === 'sent') return <span className="badge badge-ok">Sticker printed</span>;
  if (status === 'failed') return <span className="badge badge-bad">Printer failed</span>;
  return <span className="badge badge-warn">Printing…</span>;
}

// ---------------------------------------------------------------- On premises
function InsideList({ data, onChanged }) {
  const toast = useToast();
  useTick(30000);
  const [q, setQ] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const rows = (data?.visits || [])
    .filter((v) => `${v.firstName} ${v.lastName} ${v.company} ${v.host?.name} ${v.host?.unit} ${v.dailyNumber}`.toLowerCase().includes(q.trim().toLowerCase()))
    .slice()
    .reverse();

  const checkout = async (v) => {
    if (confirmId !== v.id) return setConfirmId(v.id);
    setBusyId(v.id);
    try {
      await api(`/api/visits/${v.id}/checkout`, { method: 'POST' });
      toast(`${v.firstName} ${v.lastName} checked out.`);
      setConfirmId(null);
      onChanged();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="list-head">
        <div>
          <h1>On premises</h1>
          <p className="muted">{data ? `${data.count} ${data.count === 1 ? 'visitor' : 'visitors'} inside` : 'Loading…'}</p>
        </div>
      </div>
      <div className="input-group">
        <Search />
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, pass number, flat" aria-label="Search visitors" />
      </div>
      <div className="visitor-list">
        {!data && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 74, borderRadius: 16 }} />)}
        {data && rows.length === 0 && (
          <div className="panel">
            <Empty icon={data.count === 0 ? ShieldCheck : Search} title={data.count === 0 ? 'Nobody inside' : 'No match'}>
              {data.count === 0 ? 'Approved visitors appear here until they leave.' : 'Try a pass number or flat.'}
            </Empty>
          </div>
        )}
        {rows.map((v) => {
          const mins = minutesSince(v.decidedAt);
          const long = mins >= data.staleAfterHours * 60;
          const confirming = confirmId === v.id;
          return (
            <div className="visitor-item" key={v.id}>
              <Avatar src={`/api/visits/${v.id}/photo`} name={`${v.firstName} ${v.lastName}`} size={48} square />
              <div style={{ minWidth: 0 }}>
                <div className="top"><span className="pass-chip">{v.dailyNumber}</span><span className="name">{v.firstName} {v.lastName}</span></div>
                <div className="meta"><Building2 size={13} style={{ verticalAlign: -2 }} /> {v.company} · to {v.host?.name}, {v.host?.unit}</div>
                <div className="time">In {fmtTime(v.decidedAt)} · {fmtDuration(mins)}{long && <span className="badge badge-warn">Long stay</span>}</div>
              </div>
              <button
                type="button"
                className={`btn btn-sm ${confirming ? 'btn-danger' : ''}`}
                disabled={busyId === v.id}
                onClick={() => checkout(v)}
                onBlur={() => setConfirmId((c) => (c === v.id ? null : c))}
              >
                {busyId === v.id ? <Spinner /> : confirming ? <><CheckCircle2 />Confirm</> : <><LogOut />Check out</>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
