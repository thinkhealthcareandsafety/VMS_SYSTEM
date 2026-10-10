import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Bell, Building2, CalendarCheck, ShieldAlert, Check, CheckCircle2, ChevronDown, Clock, CreditCard, History, KeyRound, LogOut,
  Printer, RotateCcw, ScanFace, Search, Send, ShieldCheck, UserPlus, UserRound, Users, X, XCircle,
} from 'lucide-react';
import { api, clock, fmtDate, fmtTime, fmtDuration, minutesSince, passLabel, secondsSince } from '../api.js';
import { useLive, useTick } from '../lib/live.js';
import { cue } from '../lib/notify.js';
import { Avatar, Empty, Logo, Spinner, useToast, useTitle, initials } from '../components/ui.jsx';
import { PasswordDialog } from '../components/Account.jsx';
import HostPicker from '../components/HostPicker.jsx';
import Camera from '../components/Camera.jsx';
import MobileVerify from '../components/MobileVerify.jsx';
import { warmUp as warmUpMasking } from '../lib/aadhaarMask.js';
import { bandOf, compare, describePhoto, warmUp as warmUpFaces } from '../lib/faceMatch.js';

const DRAFT_KEY = 'vms-guard-draft';
const DISMISS_KEY = 'vms-guard-dismissed';
const AUTOPRINT_KEY = 'vms-guard-autoprint';
const EMPTY = { mobile: '', firstName: '', lastName: '', gender: '', email: '', company: '', purpose: '' };
const GENDERS = [['male', 'Male'], ['female', 'Female'], ['other', 'Other']];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L} .'-]{1,60}$/u;
const MOBILE_RE = /^[6-9]\d{9}$/;
const PURPOSES = ['Delivery', 'Meeting', 'Interview', 'Service / repair', 'Guest'];
const RESEND_AFTER = 30; // seconds; the server enforces the same gap

const store = {
  load() { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') }; } catch { return EMPTY; } },
  save(v) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch { /* storage blocked */ } },
  clear() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked */ } },
};
// Decisions the guard has acknowledged ("Done") stay out of the waiting list for this browser session.
const dismissedStore = {
  load() { try { return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '[]')); } catch { return new Set(); } },
  save(set) { try { sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...set].slice(-300))); } catch { /* storage blocked */ } },
};

// Needs attention first: approvals to hand a pass for, declines, no-replies; then everyone still waiting, longest first.
const RANK = { approved: 0, rejected: 1, expired: 2, pending: 3 };
const sortTray = (rows) => rows.slice().sort((a, b) => (RANK[a.status] - RANK[b.status])
  || (a.status === 'pending' ? new Date(a.createdAt) - new Date(b.createdAt) : new Date(b.decidedAt || b.createdAt) - new Date(a.decidedAt || a.createdAt)));

export default function GuardDesk({ user, onLogout }) {
  const toast = useToast();
  const [tab, setTab] = useState('checkin');
  const [inside, setInside] = useState(null);
  const [queue, setQueue] = useState(null);
  const [dismissed, setDismissed] = useState(dismissedStore.load);
  const [open, setOpen] = useState(null); // visit shown in the main column; null = check-in form
  const [sentAt, setSentAt] = useState({}); // visit id -> when this device last sent its request
  const [liveTick, setLiveTick] = useState(0); // bumps on every server event
  const openRef = useRef(null);
  openRef.current = open;
  const [printing, setPrinting] = useState(null); // visit whose pass is being printed
  const [autoPrint, setAutoPrint] = useState(() => { try { return localStorage.getItem(AUTOPRINT_KEY) === '1'; } catch { return false; } });
  const printingRef = useRef(null);
  printingRef.current = printing;
  const autoPrintRef = useRef(autoPrint);
  autoPrintRef.current = autoPrint;

  const refreshInside = useCallback(() => api('/api/visits/inside').then(setInside).catch(() => {}), []);
  const refreshQueue = useCallback(() => api('/api/visits/queue').then((d) => setQueue(d.rows)).catch(() => {}), []);
  const refreshOpen = useCallback(async (id) => {
    try {
      const v = await api(`/api/visits/${id}`);
      setOpen((cur) => (cur && cur.id === id ? { ...cur, ...v } : cur));
    } catch { /* keep last known state */ }
  }, []);

  const connected = useLive((evt) => {
    setLiveTick((t) => t + 1);
    refreshInside();
    refreshQueue();
    const cur = openRef.current;
    if (cur && (!evt.visitId || evt.visitId === cur.id)) refreshOpen(cur.id);
  });

  useEffect(() => { refreshInside(); refreshQueue(); }, [refreshInside, refreshQueue]);

  // Safety net in case the live stream drops; faster while someone is still waiting for a host.
  const waitingNow = (queue || []).filter((r) => r.status === 'pending').length;
  useEffect(() => {
    const ms = connected ? 30000 : waitingNow ? 5000 : 15000;
    const t = setInterval(() => {
      refreshInside();
      refreshQueue();
      if (openRef.current) refreshOpen(openRef.current.id);
    }, ms);
    return () => clearInterval(t);
  }, [connected, waitingNow, refreshInside, refreshQueue, refreshOpen]);

  // Every decision that lands gets a sound, a vibration and a toast, even for visitors the guard has moved past.
  const seen = useRef(null);
  useEffect(() => {
    if (!queue) return;
    const prev = seen.current;
    seen.current = new Map(queue.map((r) => [r.id, r.status]));
    if (!prev) return;
    for (const r of queue) {
      const was = prev.get(r.id);
      if (!was || was === r.status) continue;
      const who = `${r.firstName} ${r.lastName}`;
      const host = r.host?.name || 'The host';
      if (r.status === 'approved') {
        cue.approved();
        toast(`${host} let ${who} in · Pass ${r.dailyNumber}`, 'ok');
        if (autoPrintRef.current && !printingRef.current) setPrinting(r);
      }
      else if (r.status === 'rejected') { cue.rejected(); toast(`${host} declined ${who}. Do not let them in.`, 'bad'); }
      else if (r.status === 'expired') { cue.expired(); toast(`No reply from ${host} for ${who}. Resend or cancel.`, 'info'); }
    }
  }, [queue, toast]);

  const dismiss = useCallback((id) => setDismissed((s) => {
    const n = new Set(s);
    n.add(id);
    dismissedStore.save(n);
    return n;
  }), []);

  // Printing the pass IS the handover: once it goes to the printer, the visitor leaves the waiting list by itself.
  const donePrinting = useCallback(() => {
    const v = printingRef.current;
    setPrinting(null);
    if (!v) return;
    dismiss(v.id);
    api(`/api/visits/${v.id}/printed`, { method: 'POST' }).catch(() => {});
    toast(`Pass ${v.dailyNumber} sent to the printer.`);
  }, [dismiss, toast]);
  const toggleAutoPrint = () => setAutoPrint((on) => {
    const next = !on;
    try { localStorage.setItem(AUTOPRINT_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
    return next;
  });

  const act = {
    resend: async (v) => {
      try {
        await api(`/api/visits/${v.id}/resend`, { method: 'POST' });
        setSentAt((m) => ({ ...m, [v.id]: Date.now() }));
        toast(`New request sent to ${v.host?.name}.`);
        refreshQueue();
        if (openRef.current?.id === v.id) refreshOpen(v.id);
      } catch (e) { toast(e.message, 'bad'); }
    },
    cancel: async (v) => {
      try {
        await api(`/api/visits/${v.id}/cancel`, { method: 'POST' });
        toast(`${v.firstName} ${v.lastName}’s visit was cancelled. The host’s link no longer works.`);
        dismiss(v.id);
        refreshQueue();
        if (openRef.current?.id === v.id) setOpen(null);
      } catch (e) { toast(e.message, 'bad'); }
    },
    reprint: async (v) => {
      try { await api(`/api/visits/${v.id}/reprint`, { method: 'POST' }); toast('Sticker sent to the printer.'); refreshOpen(v.id); } catch (e) { toast(e.message, 'bad'); }
    },
  };

  const openVisit = (v) => {
    setOpen(v);
    setTab('checkin');
    refreshOpen(v.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const closeOpen = () => {
    if (open && ['approved', 'rejected', 'cancelled'].includes(open.status)) dismiss(open.id);
    setOpen(null);
    refreshInside();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const tray = useMemo(() => sortTray((queue || []).filter((r) => !dismissed.has(r.id))), [queue, dismissed]);
  const insideCount = inside?.count ?? 0;
  const needsAttention = tray.filter((r) => r.status !== 'pending').length;
  useTitle(needsAttention ? `(${needsAttention}) Guard desk` : 'Guard desk');

  return (
    <div className="app-guard">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Logo name="" />
          <div className="where">
            <strong>{user.gateName || 'Main gate'}</strong>
            <small>
              <span className={`live-dot ${connected ? '' : 'off'}`} />{connected ? 'Live' : 'Reconnecting'}
              <span className="sep">·</span>{insideCount} inside
              {waitingNow > 0 && <><span className="sep">·</span>{waitingNow} waiting</>}
            </small>
          </div>
        </div>
        <UserMenu user={user} onLogout={onLogout} autoPrint={autoPrint} onToggleAutoPrint={toggleAutoPrint} />
      </header>

      <main className="guard-main">
        <div className="guard-split">
          <section className={tab === 'checkin' ? '' : 'hide-mobile'} aria-label="Check in">
            {open ? (
              <Outcome
                visit={open}
                sentAt={sentAt[open.id]}
                onNext={closeOpen}
                onResend={() => act.resend(open)}
                onCancel={() => act.cancel(open)}
                onReprint={() => act.reprint(open)}
                onPrint={() => setPrinting(open)}
              />
            ) : (
              <CheckInForm
                liveTick={liveTick}
                isAdmin={user.role === 'admin'}
                onOpenActive={openVisit}
                onSubmitted={(v) => {
                  setSentAt((m) => ({ ...m, [v.id]: Date.now() }));
                  if (v.status === 'approved') {
                    cue.approved();
                    toast(`Expected visitor: ${v.firstName} ${v.lastName} let in · Pass ${v.dailyNumber}`, 'ok');
                    if (autoPrintRef.current && !printingRef.current) setPrinting(v);
                  }
                  setOpen(v);
                  refreshQueue();
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            )}
          </section>
          <aside className={`guard-side ${tab === 'checkin' ? 'hide-mobile' : ''}`} aria-label="Waiting and on premises">
            <div className={tab === 'waiting' ? '' : 'hide-mobile'}>
              <WaitingTray rows={tray} loaded={Boolean(queue)} sentAt={sentAt} openId={open?.id} onOpen={openVisit} act={act} onDismiss={dismiss} onPrint={setPrinting} />
            </div>
            <div className={tab === 'inside' ? '' : 'hide-mobile'}>
              <InsideList data={inside} onChanged={refreshInside} onPrint={setPrinting} />
            </div>
          </aside>
        </div>
      </main>

      <nav className="tabbar" role="tablist" aria-label="Guard views">
        <button role="tab" aria-selected={tab === 'checkin'} onClick={() => setTab('checkin')}><UserPlus />Check in</button>
        <button role="tab" aria-selected={tab === 'waiting'} onClick={() => setTab('waiting')}>
          <Bell />Waiting
          {tray.length > 0 && <span className={`count ${tray.some((r) => r.status !== 'pending') ? 'hot' : ''}`}>{tray.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'inside'} onClick={() => setTab('inside')}>
          <Users />On premises
          {insideCount > 0 && <span className="count">{insideCount}</span>}
        </button>
      </nav>

      <PrintSheet visit={printing} siteName={user.siteName} onDone={donePrinting} />
    </div>
  );
}

function UserMenu({ user, onLogout, autoPrint, onToggleAutoPrint }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
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
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" aria-label="Account" style={{ paddingLeft: 4 }}>
        <Avatar name={user.fullName} size={30} />
        <ChevronDown />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="who"><strong>{user.fullName}</strong><small>{user.role === 'admin' ? 'Administrator' : 'Security guard'} · {user.username}</small></div>
          <button role="menuitemcheckbox" aria-checked={autoPrint} onClick={onToggleAutoPrint}>
            <Printer />Print pass when approved<span className={`menu-state ${autoPrint ? 'on' : ''}`}>{autoPrint ? 'On' : 'Off'}</span>
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); setPw(true); }}><KeyRound />Change password</button>
          <button role="menuitem" onClick={onLogout}><LogOut />Sign out</button>
        </div>
      )}
      <PasswordDialog open={pw} onClose={() => setPw(false)} />
    </div>
  );
}

// ---------------------------------------------------------------- Check-in (single page)
function CheckInForm({ onSubmitted, onOpenActive, liveTick, isAdmin }) {
  const [form, setForm] = useState(store.load);
  const [host, setHost] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [idImage, setIdImage] = useState(null);
  const [idInfo, setIdInfo] = useState(null); // how the Aadhaar was masked: auto, already, guide (+ manual touch-ups); also the face found on the card
  const [photoMirrored, setPhotoMirrored] = useState(false); // the front camera saves its preview flipped
  const [photoFace, setPhotoFace] = useState(null); // the face found in the live photo, for the match: { of: photo, face }
  const [match, setMatch] = useState(null); // { status, score } or 'working'
  const [cam, setCam] = useState('face'); // which camera is live; only one at a time (phones cannot run two)
  const [returning, setReturning] = useState(null);
  const [active, setActive] = useState(null); // this person is already inside or waiting
  const [blocked, setBlocked] = useState(null); // on the admin's blocked list: do not admit
  const [invite, setInvite] = useState(null); // expected today: let in without waiting for the host
  const [otp, setOtp] = useState({ mode: 'off', verified: null }); // number verification: how this gate is set up, and whether this number is already proven
  const [verify, setVerify] = useState(null); // null | 'verified' | 'skipped': what the guard did for this number
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);
  const autofill = useRef(null); // what the returning-visitor lookup filled in, and for which number

  // Load the on-device Aadhaar reader while the guard is still typing, so the scan is quick.
  useEffect(() => { const t = setTimeout(warmUpMasking, 1200); return () => clearTimeout(t); }, []);
  // The face engine follows a little later, so the two loads do not fight on a slow phone.
  useEffect(() => { const t = setTimeout(warmUpFaces, 3000); return () => clearTimeout(t); }, []);
  const formRef = useRef(form);
  formRef.current = form;

  // Live photo taken: find the face in it (on this device). The card's face is found when the card is scanned.
  useEffect(() => {
    setPhotoFace(null);
    if (!photo) return undefined;
    let live = true;
    describePhoto(photo, { mirrored: photoMirrored })
      .then((face) => live && setPhotoFace({ of: photo, face }))
      .catch(() => live && setPhotoFace({ of: photo, face: 'unavailable' }));
    return () => { live = false; };
  }, [photo, photoMirrored]);

  // Both faces known: compare them. Only the resulting score is kept; the descriptors stay in memory on this device.
  const matchDone = useRef(Promise.resolve());
  useEffect(() => {
    const cardFace = idInfo?.face;
    if (!photo || !idImage || !photoFace || photoFace.of !== photo || cardFace === undefined) { setMatch(photo && idImage ? 'working' : null); return undefined; }
    let live = true;
    matchDone.current = (async () => {
      let next;
      if (photoFace.face === 'unavailable' || cardFace === 'unavailable') next = { status: 'unavailable' };
      else if (!photoFace.face) next = { status: 'no_photo_face' };
      else if (!cardFace) next = { status: 'no_card_face' };
      else {
        try { next = { status: 'scored', score: await compare(photoFace.face, cardFace) }; } catch { next = { status: 'unavailable' }; }
      }
      if (live) setMatch(next);
      return next;
    })();
    return () => { live = false; };
  }, [photo, idImage, idInfo, photoFace]);
  const sec = { visitor: useRef(null), host: useRef(null), capture: useRef(null) };

  const update = (patch) => setForm((f) => { const next = { ...f, ...patch }; store.save(next); return next; });
  const digits = form.mobile.replace(/\D/g, '');
  const mobileOk = MOBILE_RE.test(digits);

  useEffect(() => {
    setReturning(null);
    setActive(null);
    setBlocked(null);
    setInvite(null);
    setOtp((o) => ({ mode: o.mode, verified: null }));
    setVerify(null);
    // Number corrected after an autofill: the filled-in name belonged to someone else, so take it back out.
    const a = autofill.current;
    if (a && a.mobile !== digits) {
      autofill.current = null;
      setForm((f) => {
        if (f.firstName !== a.firstName || f.lastName !== a.lastName) return f;
        const next = {
          ...f, firstName: '', lastName: '', company: f.company === a.company ? '' : f.company,
          gender: f.gender === a.gender ? '' : f.gender, email: f.email === a.email ? '' : f.email,
        };
        store.save(next);
        return next;
      });
    }
    if (!MOBILE_RE.test(digits)) return undefined;
    let live = true;
    api(`/api/visits/lookup?mobile=${digits}`).then((r) => {
      if (!live) return;
      setActive(r.active || null);
      setBlocked(r.blocked || null);
      setOtp(r.otp || { mode: 'off', verified: null });
      if (r.invite && !r.blocked) {
        // Expected visitor: fill in what the admin entered and pick the host, ready to let in.
        setInvite(r.invite);
        const f = formRef.current;
        const filled = {
          firstName: f.firstName.trim() || r.invite.firstName, lastName: f.lastName.trim() || r.invite.lastName,
          company: f.company.trim() || r.invite.company, purpose: f.purpose || r.invite.purpose,
        };
        autofill.current = { mobile: digits, firstName: filled.firstName, lastName: filled.lastName, company: filled.company, gender: '', email: '' };
        update(filled);
        setHost((h) => h || r.invite.host);
        return;
      }
      if (!r.found) return;
      const f = formRef.current;
      if (f.firstName.trim() || f.lastName.trim()) { setReturning({ ...r, filled: false }); return; }
      const filled = { firstName: r.firstName, lastName: r.lastName, company: f.company || r.company, gender: f.gender || r.gender || '', email: f.email || r.email || '' };
      // gender and email are only taken back out if they came from the lookup, never if the guard had already chosen them
      autofill.current = { mobile: digits, ...filled, gender: f.gender ? null : filled.gender, email: f.email ? null : filled.email };
      setReturning({ ...r, filled: true });
      update(filled);
    }).catch(() => {});
    return () => { live = false; };
  }, [digits]);

  // The person's status can change while the guard types (host approves, someone checks them out).
  useEffect(() => {
    const d = formRef.current.mobile.replace(/\D/g, '');
    if (!liveTick || !MOBILE_RE.test(d)) return undefined;
    let live = true;
    api(`/api/visits/lookup?mobile=${d}`).then((r) => { if (live) { setActive(r.active || null); setBlocked(r.blocked || null); } }).catch(() => {});
    return () => { live = false; };
  }, [liveTick]);

  const checks = [
    ['visitor', mobileOk, 'mobile number'],
    ['visitor', !active, ''], // explained by the warning above the fields, not in the list
    ['visitor', !blocked, ''],
    ['visitor', NAME_RE.test(form.firstName.trim()), 'first name'],
    ['visitor', NAME_RE.test(form.lastName.trim()), 'last name'],
    ['visitor', Boolean(form.gender), 'gender'],
    ['visitor', otp.mode !== 'required' || Boolean(otp.verified) || verify === 'verified' || (isAdmin && verify === 'skipped'), 'verify the mobile number'],
    ['visitor', form.company.trim().length > 0, 'company'],
    ['visitor', !form.email.trim() || EMAIL_RE.test(form.email.trim()), 'a valid email (or leave it empty)'],
    ['host', Boolean(host), 'whom to meet'],
    ['capture', Boolean(photo), 'photo'],
    ['capture', Boolean(idImage), 'Aadhaar'],
  ];
  const missing = checks.filter(([, ok]) => !ok);
  const done = (s) => checks.every(([k, ok]) => k !== s || ok);

  const reset = () => {
    store.clear();
    autofill.current = null;
    setForm(EMPTY); setHost(null); setPhoto(null); setIdImage(null); setIdInfo(null); setPhotoFace(null); setMatch(null); setVerify(null);
    setCam('face'); setTried(false); setError(''); setActive(null); setBlocked(null); setInvite(null);
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
      const faces = await Promise.race([matchDone.current, new Promise((r) => setTimeout(() => r(null), 8000))]); // the comparison is quick; never hold up a visitor for it
      const res = await api('/api/visits', {
        method: 'POST',
        body: {
          ...form, mobile: digits, hostId: host.id, photo, idImage,
          ...(verify === 'skipped' ? { otpSkip: true } : {}),
          ...(faces ? { faceMatch: faces.status, ...(faces.status === 'scored' ? { faceMatchScore: faces.score } : {}) } : {}), idMask: idInfo ? `${idInfo.method}${idInfo.manual ? '+manual' : ''}` : undefined, ...(invite && invite.host.id === host.id ? { inviteId: invite.id } : {}) },
      });
      store.clear();
      onSubmitted({
        id: res.id, ref: res.ref, status: res.status, firstName: form.firstName.trim(), lastName: form.lastName.trim(),
        company: form.company.trim(), host: { name: host.name, unit: host.unit }, photo, createdAt: new Date().toISOString(),
        ...(res.status === 'approved' ? { dailyNumber: res.dailyNumber, decidedAt: new Date().toISOString(), expected: true } : {}),
      });
    } catch (e) {
      if (e.status === 403 && e.data?.code === 'blocked') {
        setBlocked({ message: e.message });
        sec.visitor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (e.status === 409 && e.data?.code === 'already_active') {
        setActive({ ...e.data.visit, message: e.message });
        sec.visitor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const flag = (s) => (tried && !done(s) ? 'card needs' : 'card');

  return (
    <div className="checkin">
      <div className="step-title">
        <h1>New visitor</h1>
        <p>Fill in everything below, then send. The host gets a message to approve.</p>
      </div>

      <section className={flag('visitor')} ref={sec.visitor} aria-labelledby="sec-visitor">
        <SectionHead id="sec-visitor" n={1} title="Visitor" done={done('visitor')} />
        <label className="field">
          <span>Mobile number</span>
          <div className="input-group">
            <span className="prefix">+91</span>
            <input className="input num" inputMode="numeric" autoComplete="off" maxLength={11} placeholder="98765 43210"
              aria-invalid={digits.length === 10 && !mobileOk}
              value={digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits}
              onChange={(e) => update({ mobile: e.target.value.replace(/\D/g, '').slice(0, 10) })} autoFocus />
          </div>
          {digits.length === 10 && !mobileOk && <span className="hint err">Indian mobile numbers start with 6, 7, 8 or 9.</span>}
        </label>
        {mobileOk && otp.mode !== 'off' && !active && !blocked && !otp.verified && (
          <MobileVerify mobile={digits} mode={otp.mode} canSkip={otp.mode === 'optional' || isAdmin} value={verify} onChange={setVerify} />
        )}
        {active && (
          <div className="alert alert-warn" role="alert">
            <AlertTriangle />
            <span className="grow">{active.message}</span>
            <button type="button" className="btn btn-sm" onClick={() => onOpenActive({ ...active, firstName: active.name.split(' ')[0], lastName: active.name.split(' ').slice(1).join(' ') })}>View</button>
          </div>
        )}
        {blocked && (
          <div className="alert alert-bad alert-strong" role="alert">
            <ShieldAlert />
            <span className="grow">{blocked.message}</span>
          </div>
        )}
        {invite && !blocked && !active && (
          <div className="expected">
            <CalendarCheck />
            <span className="grow">
              <strong>Expected today</strong>, pre-approved to meet {invite.host.name} ({invite.host.unit}).
              {host && host.id !== invite.host.id ? ' You picked a different host, so this will go to them for approval.' : ' They get their pass straight away.'}
              {invite.note && <span className="expected-note">Note from admin: {invite.note}</span>}
            </span>
          </div>
        )}
        {returning && !active && !invite && !blocked && (
          <div className="returning">
            <History />
            <span className="grow">
              Returning visitor · {returning.visits} {returning.visits === 1 ? 'visit' : 'visits'}, last on {fmtDate(returning.lastVisit)}.
              {returning.filled ? ' Details filled in.' : ''}
            </span>
          </div>
        )}
        <div className="grid-2">
          <label className="field"><span>First name</span><input className="input" value={form.firstName} onChange={(e) => update({ firstName: e.target.value })} autoComplete="off" autoCapitalize="words" maxLength={60} /></label>
          <label className="field"><span>Last name</span><input className="input" value={form.lastName} onChange={(e) => update({ lastName: e.target.value })} autoComplete="off" autoCapitalize="words" maxLength={60} /></label>
        </div>
        <div className="field">
          <span id="lbl-gender">Gender</span>
          <div className="chips" role="radiogroup" aria-labelledby="lbl-gender" aria-invalid={tried && !form.gender}>
            {GENDERS.map(([key, label]) => (
              <button type="button" role="radio" aria-checked={form.gender === key} key={key} className="chip" aria-pressed={form.gender === key} onClick={() => update({ gender: form.gender === key ? '' : key })}>{label}</button>
            ))}
          </div>
        </div>
        <label className="field"><span>Company or coming from</span><input className="input" value={form.company} onChange={(e) => update({ company: e.target.value })} autoComplete="off" maxLength={100} placeholder="e.g. Blue Dart, Infosys, Personal" /></label>
        <label className="field">
          <span>Email <span className="faint">· optional</span></span>
          <input className="input" type="email" inputMode="email" value={form.email} onChange={(e) => update({ email: e.target.value })} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={120} aria-invalid={Boolean(form.email.trim()) && !EMAIL_RE.test(form.email.trim())} />
          {Boolean(form.email.trim()) && !EMAIL_RE.test(form.email.trim()) && <span className="hint err">That email address does not look right.</span>}
        </label>
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
        <SectionHead id="sec-capture" n={3} title="Photo and ID" done={done('capture')} />
        <div className="capture-grid">
          <div className="field">
            <span>Live photo <span className="faint">· no mask or cap</span></span>
            {photo || cam === 'face'
              ? <Camera mode="face" captured={photo} onCapture={(p, how) => { setPhotoMirrored(Boolean(how?.mirrored)); setPhoto(p); setCam(idImage ? null : 'aadhaar'); }} onRetake={() => { setPhoto(null); setCam('face'); }} />
              : <CamTile icon={UserRound} label="Take photo" onClick={() => setCam('face')} />}
          </div>
          <div className="field">
            <span>Aadhaar card <span className="faint">· first 8 digits blacked out</span></span>
            {idImage || cam === 'aadhaar'
              ? <Camera mode="aadhaar" captured={idImage} info={idInfo} onCapture={(p, info) => { setIdImage(p); setIdInfo(info); setCam(null); }} onEdit={(p, how) => { setIdImage(p); setIdInfo((i) => ({ ...i, manual: Boolean(how?.manual) })); }} onRetake={() => { setIdImage(null); setIdInfo(null); setCam('aadhaar'); }} />
              : <CamTile icon={CreditCard} label="Scan Aadhaar" onClick={() => setCam('aadhaar')} />}
          </div>
        </div>
        <FaceMatch match={match} />
      </section>

      {error && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{error}</span></div>}

      <div className="footer-bar">
        <div className="inner">
          {tried && missing.some(([, , l]) => l) && <p className="need">Still needed: {missing.map(([, , l]) => l).filter(Boolean).join(', ')}</p>}
          <button type="button" className="btn btn-xl" onClick={reset} disabled={busy}>Clear</button>
          <button type="button" className="btn btn-primary btn-xl" disabled={busy} onClick={submit}>
            {busy ? <><Spinner />Sending</> : invite && host && invite.host.id === host.id && !blocked ? <><CheckCircle2 />Let in: expected visitor</> : <><Send />Send for approval</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// Live photo against the face on the Aadhaar card, compared on this device. Just the number: advice for the guard, never a decision.
const MATCH_NOTE = {
  no_card_face: 'No face found on the card',
  no_photo_face: 'No face found in the photo',
  unavailable: 'Face match not available',
};
function FaceMatch({ match }) {
  if (!match) return null;
  if (match === 'working') return <div className="alert face-match" role="status"><Spinner /><span className="grow">Face match…</span></div>;
  if (match.status !== 'scored') return <div className="alert face-match" role="status"><ScanFace /><span className="grow">{MATCH_NOTE[match.status]}</span></div>;
  const tone = { strong: 'alert-ok', possible: 'alert-warn', weak: 'alert-bad' }[bandOf(match.score)];
  return (
    <div className={`alert face-match ${tone}`} role="status" aria-label={`Face match ${match.score} percent`}>
      <span className="pct num">{match.score}%</span>
      <span className="grow"><strong>Face match</strong></span>
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

// ---------------------------------------------------------------- One visit, after sending
function Outcome({ visit, sentAt, onNext, onResend, onCancel, onReprint, onPrint }) {
  useTick(1000);
  const name = `${visit.firstName} ${visit.lastName}`;
  const hostFirst = visit.host?.name?.split(' ')[0] || 'the host';
  const secs = secondsSince(visit.createdAt);
  const sinceSend = sentAt ? Math.round((Date.now() - sentAt) / 1000) : secs;
  const wait = Math.max(0, RESEND_AFTER - sinceSend);
  const photo = visit.photo || `/api/visits/${visit.id}/photo`;

  return (
    <div className="card outcome" aria-live="polite">
      {visit.status === 'pending' && (
        <>
          <div className="wait-ring"><Avatar src={photo} name={name} size={84} /></div>
          <div>
            <h1>Waiting for {visit.host?.name || hostFirst}’s approval</h1>
            <p className="lead" style={{ margin: '6px auto 0' }}><strong>{name}</strong> · {visit.host?.unit}</p>
          </div>
          <span className="timer"><Clock size={15} />Waiting {clock(secs)}</span>
          {visit.smsStatus === 'failed' && (
            <div className="alert alert-bad" role="alert" style={{ textAlign: 'left' }}>
              <AlertTriangle /><span className="grow">Not delivered. Call {hostFirst} or resend.</span>
            </div>
          )}
          <div className="outcome-actions">
            <button className="btn btn-primary btn-lg" onClick={onNext}><UserPlus />Check in next visitor</button>
            <div className="row">
              <button className="btn" onClick={onResend} disabled={wait > 0}><RotateCcw />{wait > 0 ? `Resend in ${wait}s` : 'Resend request'}</button>
              <button className="btn btn-ghost" onClick={onCancel}><X />Cancel visit</button>
            </div>
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
                <span className="avatar" style={{ '--s': '48px', borderRadius: 12 }}>{photo ? <img src={photo} alt="" /> : initials(name)}</span>
                <div><strong>{name}</strong><span className="muted">{visit.company}</span></div>
              </div>
              <div className="pass-row">
                <div><small>Meeting</small>{visit.host?.name}</div>
                <div><small>Flat / dept</small>{visit.host?.unit}</div>
                <div><small>Entry</small><span className="num">{fmtTime(visit.decidedAt)}</span></div>
                <div><small>Visitor ID</small><span className="mono">{visit.ref}</span></div>
              </div>
            </div>
            <div className="pass-perf" />
            <div className="pass-foot">
              <PrintStatus status={visit.printStatus} />
              <span className="pass-foot-actions">
                {visit.printStatus && visit.printStatus !== 'off' && <button className="btn btn-sm" onClick={onReprint}><Printer />Label</button>}
                <button className="btn btn-sm btn-primary" onClick={onPrint}><Printer />Print pass</button>
              </span>
            </div>
          </div>
          <p className="lead">
            {visit.expected ? `Expected by ${visit.host?.name}` : `Approved by ${visit.host?.name}`}
          </p>
          <button className="btn btn-primary btn-xl btn-block" style={{ maxWidth: 340 }} onClick={onNext}><UserPlus />Next visitor</button>
        </>
      )}

      {visit.status === 'rejected' && (
        <>
          <div className="state-icon bad"><XCircle /></div>
          <div><h1>Declined</h1><p className="lead" style={{ margin: '6px auto 0' }}>Do not let {visit.firstName} in.</p></div>
          <button className="btn btn-primary btn-xl btn-block" style={{ maxWidth: 340 }} onClick={onNext}>Done</button>
        </>
      )}

      {visit.status === 'expired' && (
        <>
          <div className="state-icon warn"><Clock /></div>
          <div><h1>No reply from {hostFirst}</h1></div>
          <div style={{ display: 'grid', gap: 8, width: '100%', maxWidth: 340 }}>
            <button className="btn btn-primary btn-xl" onClick={onResend} disabled={wait > 0}><RotateCcw />{wait > 0 ? `Resend in ${wait}s` : 'Resend request'}</button>
            <button className="btn" onClick={onCancel}><X />Visitor left: cancel visit</button>
            <button className="btn btn-ghost" onClick={onNext}>Back to check-in</button>
          </div>
        </>
      )}

      {visit.status === 'cancelled' && (
        <>
          <div className="state-icon"><X /></div>
          <div><h1>Cancelled</h1></div>
          <button className="btn btn-primary btn-xl btn-block" style={{ maxWidth: 340 }} onClick={onNext}>Done</button>
        </>
      )}

      {['checked_out', 'force_checked_out'].includes(visit.status) && (
        <>
          <div className="state-icon ok"><CheckCircle2 /></div>
          <div><h1>Checked out</h1></div>
          <button className="btn btn-primary btn-xl btn-block" style={{ maxWidth: 340 }} onClick={onNext}>Done</button>
        </>
      )}
    </div>
  );
}

function PrintStatus({ status }) {
  if (!status) return null;
  if (status === 'off') return null;
  if (status === 'sent') return <span className="badge badge-ok">Sticker printed</span>;
  if (status === 'failed') return <span className="badge badge-bad">Printer failed</span>;
  return <span className="badge badge-warn">Printing…</span>;
}

// ---------------------------------------------------------------- Printable pass
// Printed from a tiny hidden page of its own (80 mm receipt layout; on A4 it prints as a small slip), so the
// print dialog opens at once on every computer, Macs included, instead of rendering the whole app first.
const PASS_CSS = `
@page { size: 80mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body { width: 72mm; margin: 0 auto; padding: 4mm 0 8mm; color: #000; font: 10pt/1.3 -apple-system, "Segoe UI", Arial, sans-serif; text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.site { font-size: 11pt; font-weight: 600; letter-spacing: .04em; }
.title { font-size: 9pt; letter-spacing: .22em; margin-top: 1mm; }
.no { font-size: 64pt; font-weight: 700; line-height: 1; margin: 3mm 0 1mm; letter-spacing: -.03em; }
.date { font-size: 10pt; margin-bottom: 3mm; }
.photo { display: block; width: 30mm; height: 30mm; object-fit: cover; margin: 0 auto 3mm; filter: grayscale(1) contrast(1.15); border: .4mm solid #000; }
.name { font-size: 15pt; font-weight: 700; line-height: 1.15; }
.company { font-size: 10pt; margin-top: .5mm; }
.rule { border-top: .35mm dashed #000; margin: 3mm 0; }
.row { display: flex; justify-content: space-between; gap: 4mm; font-size: 10pt; text-align: left; padding: .6mm 0; }
.row strong { text-align: right; font-weight: 600; }
.foot { font-size: 8.5pt; }
`;
const escHtml = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The photo as a data URL, so the print page needs no further request. Never waits long: a pass without a photo still prints.
async function photoData(id) {
  try {
    const res = await fetch(`/api/visits/${id}/photo`, { credentials: 'same-origin', signal: AbortSignal.timeout(4000) });
    if (!res.ok) return '';
    const blob = await res.blob();
    return await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => resolve(''); r.readAsDataURL(blob); });
  } catch { return ''; }
}

function passHtml(visit, siteName, photo) {
  const name = `${visit.firstName} ${visit.lastName}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Visitor pass ${escHtml(visit.dailyNumber)}</title><style>${PASS_CSS}</style></head><body>
<div class="site">${escHtml(siteName || 'Visitor Desk')}</div>
<div class="title">VISITOR PASS</div>
<div class="no">${escHtml(visit.dailyNumber)}</div>
<div class="date">${escHtml(fmtDate(visit.decidedAt))} · ${escHtml(fmtTime(visit.decidedAt))}</div>
${photo ? `<img class="photo" src="${photo}" alt="">` : ''}
<div class="name">${escHtml(name)}</div>
<div class="company">${escHtml(visit.company)}</div>
<div class="rule"></div>
<div class="row"><span>Meeting</span><strong>${escHtml(visit.host?.name)}</strong></div>
<div class="row"><span>Flat / dept</span><strong>${escHtml(visit.host?.unit)}</strong></div>
<div class="row"><span>Visitor ID</span><strong>${escHtml(visit.ref)}</strong></div>
<div class="rule"></div>
<div class="foot">Wear this pass. Return it when you leave.</div>
</body></html>`;
}

function PrintSheet({ visit, siteName, onDone }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!visit) return undefined;
    let cancelled = false;
    let frame = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setTimeout(() => { frame?.remove(); }, 500);
      if (!cancelled) doneRef.current();
    };
    (async () => {
      const photo = await photoData(visit.id);
      if (cancelled) return;
      frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      // Rendered but out of sight: some browsers will not print a frame that is display:none.
      Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0', pointerEvents: 'none' });
      frame.onload = () => {
        const win = frame.contentWindow;
        win.addEventListener('afterprint', finish, { once: true });
        let printed = false;
        const go = () => { if (printed) return; printed = true; try { win.focus(); win.print(); } catch { finish(); } };
        const img = win.document.querySelector('img');
        if (img && !img.complete) { img.onload = go; img.onerror = go; setTimeout(go, 1500); } else go();
        setTimeout(finish, 5 * 60e3); // browsers that never report the end of printing
      };
      frame.srcdoc = passHtml(visit, siteName, photo);
      document.body.appendChild(frame);
    })();
    return () => { cancelled = true; frame?.remove(); };
  }, [visit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

// ---------------------------------------------------------------- Waiting for host
function WaitingTray({ rows, loaded, sentAt, openId, onOpen, act, onDismiss, onPrint }) {
  useTick(1000);
  return (
    <div className={`tray ${rows.length ? '' : 'tray-empty'}`}>
      <div className="list-head">
        <div>
          <h1>Waiting for host</h1>
          <p className="muted">{rows.length ? 'Updates live. You’ll hear a chime on every reply.' : 'Nobody is waiting right now.'}</p>
        </div>
      </div>
      {!loaded && <div className="skeleton" style={{ height: 74, borderRadius: 16 }} />}
      {loaded && rows.length === 0 && (
        <div className="panel"><Empty icon={Bell} title="Nobody waiting">Visitors you send for approval appear here until the host replies.</Empty></div>
      )}
      <div className="visitor-list">
        {rows.map((v) => {
          const name = `${v.firstName} ${v.lastName}`;
          const sinceSend = sentAt[v.id] ? Math.round((Date.now() - sentAt[v.id]) / 1000) : secondsSince(v.createdAt);
          const canResend = sinceSend >= RESEND_AFTER;
          return (
            <div key={v.id} className={`tray-item is-${v.status} ${openId === v.id ? 'is-open' : ''}`}>
              <button type="button" className="tray-main" onClick={() => onOpen(v)}>
                <Avatar src={`/api/visits/${v.id}/photo`} name={name} size={44} square />
                <span className="grow">
                  <span className="name">{name}</span>
                  <span className="meta">for {v.host?.name} · {v.host?.unit}</span>
                </span>
                <TrayState v={v} />
              </button>
              <div className="tray-actions">
                {(v.status === 'pending' || v.status === 'expired') && (
                  <>
                    <button className="btn btn-sm" disabled={!canResend} onClick={() => act.resend(v)}><RotateCcw />{canResend ? 'Resend' : `${RESEND_AFTER - sinceSend}s`}</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => act.cancel(v)}><X />Cancel</button>
                  </>
                )}
                {v.status === 'approved' && (
                  <>
                    <button className="btn btn-sm btn-primary" onClick={() => onPrint(v)}><Printer />Print pass</button>
                    <button className="btn btn-sm btn-ghost btn-icon" onClick={() => onDismiss(v.id)} aria-label="Dismiss without printing" title="Dismiss without printing"><X /></button>
                  </>
                )}
                {v.status === 'rejected' && <button className="btn btn-sm" onClick={() => onDismiss(v.id)}><Check />Got it</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrayState({ v }) {
  if (v.status === 'approved') return <span className="tray-state ok"><span className="pass-chip">{passLabel(v)}</span>Let in</span>;
  if (v.status === 'rejected') return <span className="tray-state bad"><XCircle />Declined</span>;
  if (v.status === 'expired') return <span className="tray-state warn"><Clock />No reply</span>;
  if (v.smsStatus === 'failed') return <span className="tray-state bad"><AlertTriangle />Not delivered</span>;
  return <span className="tray-state wait"><span className="live-dot" />{clock(secondsSince(v.createdAt))}</span>;
}

// ---------------------------------------------------------------- On premises
function InsideList({ data, onChanged, onPrint }) {
  const toast = useToast();
  useTick(30000);
  const [q, setQ] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const term = q.trim().toLowerCase();
  const rows = (data?.visits || [])
    .filter((v) => !term || `${v.firstName} ${v.lastName} ${v.company} ${v.host?.name} ${v.host?.unit} ${v.dailyNumber} ${v.ref}`.toLowerCase().includes(term))
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
                <div className="top"><span className="pass-chip">{passLabel(v)}</span><span className="name">{v.firstName} {v.lastName}</span></div>
                <div className="meta"><Building2 size={13} style={{ verticalAlign: -2 }} /> {v.company} · to {v.host?.name}, {v.host?.unit}</div>
                <div className="time">In {fmtTime(v.decidedAt)} · {fmtDuration(mins)}{long && <span className="badge badge-warn">Long stay</span>}</div>
              </div>
              <div className="row-actions">
              <button type="button" className="btn btn-sm btn-icon" onClick={() => onPrint(v)} aria-label={`Print pass ${v.dailyNumber}`} title="Print pass"><Printer /></button>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
