import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertTriangle, ArrowDown, BadgeCheck, Bell, ChevronRight, Plus, LogIn, MessageCircle, Building2, CalendarCheck, ShieldAlert, Check, CheckCircle2, ChevronDown, Clock, CreditCard, History, KeyRound, LogOut,
  Mail, Package, PartyPopper, Printer, Siren, RotateCcw, ScanFace, ScanLine, Search, Send, ShieldCheck, UserPlus, UserRound, Users, X, XCircle,
} from 'lucide-react';
import { api, clock, fmtDate, fmtTime, fmtDuration, fmtUntil, minutesSince, passLabel, secondsSince, today } from '../api.js';
import { useLive, useTick } from '../lib/live.js';
import { cue } from '../lib/notify.js';
import { printEvacuation } from '../lib/evacuation.js';
import { Avatar, Empty, Logo, Spinner, useToast, useTitle, initials, PoweredBy } from '../components/ui.jsx';
import { PasswordDialog } from '../components/Account.jsx';
import HostPicker from '../components/HostPicker.jsx';
import Camera from '../components/Camera.jsx';
import MobileVerify from '../components/MobileVerify.jsx';
import DigitBoxes, { cleanMobile } from '../components/DigitBoxes.jsx';
import PassScanner from '../components/PassScanner.jsx';
import GroupGate from '../components/GroupGate.jsx';
import MaterialBoard from '../components/Material.jsx';
import CourierBoard from '../components/Couriers.jsx';
import { warmUp as warmUpMasking } from '../lib/aadhaarMask.js';
import { bandOf, compare, describePhoto, warmUp as warmUpFaces } from '../lib/faceMatch.js';
import { checkId, splitCardName } from '../lib/idMatch.js';

const DRAFT_KEY = 'vms-guard-draft';
const DISMISS_KEY = 'vms-guard-dismissed';
const AUTOPRINT_KEY = 'vms-guard-autoprint';
const EMPTY = { mobile: '', firstName: '', lastName: '', gender: '', email: '', company: '', purpose: '', validity: '8h', validUntilDay: '', idType: 'aadhaar', idTypeOther: '' };
// How long a pass lasts. Hours count from when the host lets the visitor in; days run to 11:59 pm on the last day.
const VALIDITY = [['2h', '2 hours'], ['4h', '4 hours'], ['8h', '8 hours'], ['today', 'Today'], ['3d', '3 days'], ['7d', '7 days'], ['10d', '10 days'], ['20d', '20 days'], ['30d', '30 days'], ['date', 'Pick a date']];
const VALIDITY_HOURS = { '2h': 2, '4h': 4, '8h': 8 };
const VALIDITY_DAYS = { today: 1, '3d': 3, '7d': 7, '10d': 10, '20d': 20, '30d': 30 };
const MAX_PASS_DAYS = 90;
const addDays = (ymd, n) => { const t = new Date(`${ymd}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dayLabel = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
// What the guard sees under the choices, before anyone approves.
function validityPreview(v, day) {
  if (VALIDITY_HOURS[v]) return `For ${VALIDITY_HOURS[v]} hours from when the host lets them in.`;
  if (v === 'today') return 'Until 11:59 pm today.';
  if (VALIDITY_DAYS[v]) return `Until ${dayLabel(addDays(today(), VALIDITY_DAYS[v] - 1))}, 11:59 pm. They can leave and come back on the same pass.`;
  if (v === 'date') return day ? `Until ${dayLabel(day)}, 11:59 pm.${day > today() ? ' They can leave and come back on the same pass.' : ''}` : 'Pick the last day of the pass.';
  return '';
}
const GENDERS = [['male', 'Male'], ['female', 'Female'], ['other', 'Other']];
// What the big button says while something is still missing: always the very next step.
const NEXT_LABEL = {
  mobile: 'Next: mobile number', firstName: 'Next: first name', lastName: 'Next: last name', gender: 'Next: gender',
  otp: 'Next: verify number', company: 'Next: company', email: 'Next: fix the email',
  host: 'Next: whom they meet', validUntilDay: 'Next: last day of pass', photo: 'Next: take photo', id: 'Next: scan ID card',
};
// The ID the visitor shows. Only Aadhaar is masked automatically (the law requires it); every card is checked against the name typed.
const ID_TYPES = [['aadhaar', 'Aadhaar'], ['pan', 'PAN card'], ['dl', 'Driving licence'], ['passport', 'Passport'], ['voter', 'Voter ID'], ['other', 'Other']];
const ID_LABEL = Object.fromEntries(ID_TYPES);
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
  const [whatsapp, setWhatsapp] = useState({}); // visit id -> wa.me link with the latest approval request typed in
  const [liveTick, setLiveTick] = useState(0); // bumps on every server event
  const openRef = useRef(null);
  openRef.current = open;
  const [printing, setPrinting] = useState(null); // visit whose pass is being printed
  const [groupId, setGroupId] = useState(null);    // a guest group open in the main column
  const [scanning, setScanning] = useState(false); // the pass scanner
  const [groups, setGroups] = useState([]);        // groups that can be let in today
  // The desk handles people or material; the choice is remembered on this device.
  const [mode, setMode] = useState(() => { try { const m = localStorage.getItem('vms.desk.mode'); return ['material', 'couriers'].includes(m) ? m : 'visitors'; } catch { return 'visitors'; } });
  const switchMode = (m) => { setMode(m); try { localStorage.setItem('vms.desk.mode', m); } catch { /* storage blocked */ } };
  const [autoPrint, setAutoPrint] = useState(() => { try { return localStorage.getItem(AUTOPRINT_KEY) === '1'; } catch { return false; } });
  const printingRef = useRef(null);
  printingRef.current = printing;
  const autoPrintRef = useRef(autoPrint);
  autoPrintRef.current = autoPrint;

  const refreshInside = useCallback(() => {
    api('/api/visits/inside').then(setInside).catch(() => {});
    api('/api/groups?scope=today').then((r) => setGroups(r.rows)).catch(() => {});
  }, []);
  const refreshQueue = useCallback(() => api('/api/visits/queue').then((d) => setQueue(d.rows)).catch(() => {}), []);
  const refreshOpen = useCallback(async (id) => {
    try {
      const v = await api(`/api/visits/${id}`);
      setOpen((cur) => (cur && cur.id === id ? { ...cur, ...v } : cur));
    } catch { /* keep last known state */ }
  }, []);

  // Events come in bursts (an event's guests scanned at several gates): lists reload once per burst. The open
  // visit still updates at once, so a host's decision lands on screen without delay.
  const burst = useRef(null);
  const connected = useLive((evt) => {
    const cur = openRef.current;
    if (cur && (!evt.visitId || evt.visitId === cur.id)) refreshOpen(cur.id);
    clearTimeout(burst.current);
    burst.current = setTimeout(() => { setLiveTick((t) => t + 1); refreshInside(); refreshQueue(); }, 300);
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
      else if (r.status === 'expired') { cue.expired(); toast(`No reply from ${host} for ${who}. Call the host, or press Resend.`, 'info'); }
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
  // A print click shows at once that something is happening: the system print dialog can take a moment, mostly on a Mac.
  const printPass = useCallback((v) => {
    if (printingRef.current?.id === v.id) return;
    toast(`Preparing pass ${v.dailyNumber}…`);
    setPrinting(v);
  }, [toast]);
  const toggleAutoPrint = () => setAutoPrint((on) => {
    const next = !on;
    try { localStorage.setItem(AUTOPRINT_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
    return next;
  });

  const act = {
    resend: async (v) => {
      try {
        const res = await api(`/api/visits/${v.id}/resend`, { method: 'POST' });
        setSentAt((m) => ({ ...m, [v.id]: Date.now() }));
        setWhatsapp((m) => ({ ...m, [v.id]: res.whatsapp || null }));
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
  // Fetch each approved visitor's photo as soon as the approval lands, so Print goes straight to the print dialog.
  useEffect(() => { for (const r of tray) if (r.status === 'approved') photoData(r.id); }, [tray]);
  const insideCount = inside?.count ?? 0;
  const needsAttention = tray.filter((r) => r.status !== 'pending').length;
  useTitle(needsAttention ? `(${needsAttention}) Guard desk` : 'Guard desk');

  return (
    <div className="app-guard">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Logo name="" />
          <div className="where">
            <strong><span className="frame-label">{user.gateName || 'Main gate'}</span></strong>
            <small>
              <span className={`live-dot ${connected ? '' : 'off'}`} />{connected ? 'Live' : 'Reconnecting'}
              <span className="sep">·</span>{insideCount} inside
              {waitingNow > 0 && <><span className="sep">·</span>{waitingNow} waiting</>}
            </small>
          </div>
        </div>
        <div className="desk-mode seg" role="tablist" aria-label="Desk">
          <button role="tab" aria-selected={mode === 'visitors'} aria-pressed={mode === 'visitors'} onClick={() => switchMode('visitors')}><Users size={15} /> Visitors</button>
          <button role="tab" aria-selected={mode === 'material'} aria-pressed={mode === 'material'} onClick={() => switchMode('material')}><Package size={15} /> Material</button>
          <button role="tab" aria-selected={mode === 'couriers'} aria-pressed={mode === 'couriers'} onClick={() => switchMode('couriers')}><Mail size={15} /> Couriers</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {mode === 'visitors' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setScanning(true)} title="Scan a pass to let someone out, or back in"><ScanLine /><span className="hide-narrow">Scan pass</span></button>}
          <UserMenu user={user} onLogout={onLogout} autoPrint={autoPrint} onToggleAutoPrint={toggleAutoPrint} />
        </div>
      </header>

      {mode === 'material' ? (
        <main className="guard-main"><MaterialBoard liveTick={liveTick} /></main>
      ) : mode === 'couriers' ? (
        <main className="guard-main"><CourierBoard liveTick={liveTick} /></main>
      ) : (
      <main className="guard-main">
        <div className="guard-split">
          <section className={tab === 'checkin' ? '' : 'hide-mobile'} aria-label="Check in">
            {groupId ? (
              <GroupGate groupId={groupId} liveTick={liveTick} onBack={() => setGroupId(null)} onScan={() => setScanning(true)} />
            ) : open ? (
              <Outcome
                visit={open}
                sentAt={sentAt[open.id]}
                whatsapp={whatsapp[open.id]}
                onNext={closeOpen}
                onResend={() => act.resend(open)}
                onCancel={() => act.cancel(open)}
                onReprint={() => act.reprint(open)}
                onPrint={() => printPass(open)}
              />
            ) : (
              <CheckInForm
                liveTick={liveTick}
                isAdmin={user.role === 'admin' || user.role === 'superadmin'}
                keepFullId={Boolean(user.fullId)}
                onOpenActive={openVisit}
                onSubmitted={(v) => {
                  setSentAt((m) => ({ ...m, [v.id]: Date.now() }));
                  if (v.whatsapp) setWhatsapp((m) => ({ ...m, [v.id]: v.whatsapp }));
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
              <WaitingTray rows={tray} loaded={Boolean(queue)} sentAt={sentAt} openId={open?.id} onOpen={openVisit} act={act} onDismiss={dismiss} onPrint={printPass} />
            </div>
            <div className={tab === 'inside' ? '' : 'hide-mobile'}>
              {groups.length > 0 && <TodaysGroups groups={groups} openId={groupId} onOpen={(id) => { setGroupId(id); setTab('checkin'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} onScan={() => setScanning(true)} />}
              <InsideList data={inside} onChanged={refreshInside} onPrint={printPass} onScan={() => setScanning(true)} onOpenGroup={(id) => { setGroupId(id); setTab('checkin'); }} />
            </div>
          </aside>
        </div>
      </main>

      )}
      <PassScanner open={scanning} onClose={() => setScanning(false)} onChanged={refreshInside} />
      {mode === 'visitors' && <nav className="tabbar" role="tablist" aria-label="Guard views">
        <button role="tab" aria-selected={tab === 'checkin'} onClick={() => setTab('checkin')}><UserPlus />Check in</button>
        <button role="tab" aria-selected={tab === 'waiting'} onClick={() => setTab('waiting')}>
          <Bell />Waiting
          {tray.length > 0 && <span className={`count ${tray.some((r) => r.status !== 'pending') ? 'hot' : ''}`}>{tray.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'inside'} onClick={() => setTab('inside')}>
          <Users />On premises
          {insideCount > 0 && <span className="count">{insideCount}</span>}
        </button>
      </nav>}

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
          <div className="who"><strong>{user.fullName}</strong><small>{user.role === 'superadmin' ? 'Super Admin' : user.role === 'admin' ? 'Administrator' : 'Security guard'} · {user.username}</small></div>
          <button role="menuitemcheckbox" aria-checked={autoPrint} onClick={onToggleAutoPrint}>
            <Printer />Print pass when approved<span className={`menu-state ${autoPrint ? 'on' : ''}`}>{autoPrint ? 'On' : 'Off'}</span>
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); setPw(true); }}><KeyRound />Change password</button>
          <button role="menuitem" onClick={onLogout}><LogOut />Sign out</button>
          <PoweredBy className="menu-powered" />
        </div>
      )}
      <PasswordDialog open={pw} onClose={() => setPw(false)} />
    </div>
  );
}

// ---------------------------------------------------------------- Check-in (single page)
function CheckInForm({ onSubmitted, onOpenActive, liveTick, isAdmin, keepFullId }) {
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
  const [showEmail, setShowEmail] = useState(false);
  const [lookedUp, setLookedUp] = useState(0); // bumps when a mobile number has been looked up, to move the guard on
  const rootRef = useRef(null);
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
  const idType = form.idType || 'aadhaar';
  const idLabel = idType === 'other' ? (form.idTypeOther?.trim() || 'ID card') : ID_LABEL[idType];
  // The card read against what was typed: name and gender. Recomputed as the guard types.
  const idCheck = useMemo(() => checkId(idInfo?.read, form), [idInfo, form.firstName, form.lastName, form.gender]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameFromCard = Boolean(idInfo?.filled && idInfo.filled.firstName === form.firstName && idInfo.filled.lastName === form.lastName);

  const update = (patch) => setForm((f) => { const next = { ...f, ...patch }; store.save(next); return next; });
  // A scanned card fills in the name (and gender) when the guard has not typed one, and corrects the ID type
  // when the card is another kind. Returns the card info, marked with the name it filled in.
  const fromCard = (info) => {
    const f = formRef.current;
    const patch = info.switched && info.idType ? { idType: info.idType } : {};
    const filled = info.read?.name && !f.firstName.trim() && !f.lastName.trim() ? splitCardName(info.read.name) : null;
    if (filled) Object.assign(patch, filled, info.read.gender && !f.gender ? { gender: info.read.gender } : {});
    if (Object.keys(patch).length) update(patch);
    return filled ? { ...info, filled } : info;
  };
  const takeCardDetails = (c) => {
    const filled = splitCardName(c.cardName);
    update({ ...filled, ...(c.cardGender ? { gender: c.cardGender } : {}) });
    setIdInfo((i) => ({ ...i, filled }));
  };
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
      if (!r.active && !r.blocked) setLookedUp((n) => n + 1);
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
    ['visitor', mobileOk, 'mobile number', 'mobile'],
    ['visitor', !active, ''], // explained by the warning above the fields, not in the list
    ['visitor', !blocked, ''],
    ['visitor', NAME_RE.test(form.firstName.trim()), 'first name', 'firstName'],
    ['visitor', NAME_RE.test(form.lastName.trim()), 'last name', 'lastName'],
    ['visitor', Boolean(form.gender), 'gender', 'gender'],
    ['visitor', otp.mode !== 'required' || Boolean(otp.verified) || verify === 'verified' || (isAdmin && verify === 'skipped'), 'verify the mobile number', 'otp'],
    ['visitor', form.company.trim().length > 0, 'company', 'company'],
    ['visitor', !form.email.trim() || EMAIL_RE.test(form.email.trim()), 'a valid email (or leave it empty)', 'email'],
    ['host', Boolean(host), 'whom to meet', 'host'],
    ['host', (form.validity || '8h') !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(form.validUntilDay || ''), 'the last day of the pass', 'validUntilDay'],
    ['capture', Boolean(photo), 'photo', 'photo'],
    ['capture', Boolean(idImage), 'ID card', 'id'],
  ];
  const missing = checks.filter(([, ok]) => !ok);
  const done = (s) => checks.every(([k, ok]) => k !== s || ok);
  const nextUp = missing.find(([, , label]) => label);

  // Takes the guard to what is still needed: the section scrolls into view and the field gets the cursor.
  const goTo = ([section, , , field], { scroll = true } = {}) => {
    if (field === 'photo') setCam('face');
    if (field === 'id') setCam('aadhaar');
    if (scroll) sec[section].current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const root = rootRef.current;
    const el = field === 'mobile' ? root?.querySelector('.mobile-boxes input')
      : field === 'host' ? sec.host.current?.querySelector('input')
        : root?.querySelector(`[data-field="${field}"]`);
    if (el) setTimeout(() => el.focus({ preventScroll: true }), scroll ? 380 : 0);
  };
  // Number typed and looked up: the cursor moves on by itself to the first thing still empty (the name for a new
  // visitor, whom to meet for one who was recognised), unless the guard has already moved somewhere else.
  useEffect(() => {
    if (!lookedUp || !document.activeElement?.closest?.('.mobile-boxes')) return;
    const next = missing.find(([, , label, field]) => label && field !== 'mobile');
    if (next && next[0] !== 'capture') goTo(next, { scroll: next[0] !== 'visitor' });
  }, [lookedUp]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => {
    store.clear();
    autofill.current = null;
    setForm(EMPTY); setHost(null); setPhoto(null); setIdImage(null); setIdInfo(null); setPhotoFace(null); setMatch(null); setVerify(null);
    setCam('face'); setTried(false); setError(''); setActive(null); setBlocked(null); setInvite(null); setShowEmail(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // A pass holder came back while the pass is valid: in again, no approval, straight to their pass.
  const reenter = async () => {
    setBusy(true);
    setError('');
    try {
      const v = await api(`/api/visits/${active.id}/reenter`, { method: 'POST' });
      store.clear();
      reset();
      onOpenActive(v);
    } catch (e) {
      if (e.status === 403 && e.data?.code === 'blocked') setBlocked({ message: e.message });
      setError(e.message);
    } finally {
      setBusy(false);
    }
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
          ...form, mobile: digits, hostId: host.id, photo, idImage, ...(keepFullId && idInfo?.full ? { idImageFull: idInfo.full } : {}),
          ...(verify === 'skipped' ? { otpSkip: true } : {}),
          ...(faces ? { faceMatch: faces.status, ...(faces.status === 'scored' ? { faceMatchScore: faces.score } : {}) } : {}), idMask: idInfo ? `${idInfo.method}${idInfo.manual ? '+manual' : ''}` : undefined, idType, ...(idType === 'other' && form.idTypeOther?.trim() ? { idTypeOther: form.idTypeOther.trim() } : {}),
          ...(idCheck ? { idCheck: { status: idCheck.status, source: idCheck.source, nameScore: idCheck.nameScore, gender: idCheck.gender, tamper: idCheck.tamper } } : {}), ...(invite && invite.host.id === host.id ? { inviteId: invite.id } : {}),
          validity: form.validity || '8h', ...(form.validity === 'date' ? { validUntilDay: form.validUntilDay } : {}) },
      });
      store.clear();
      onSubmitted({
        id: res.id, ref: res.ref, status: res.status, whatsapp: res.whatsapp || null, firstName: form.firstName.trim(), lastName: form.lastName.trim(),
        company: form.company.trim(), host: { name: host.name, unit: host.unit }, photo, createdAt: new Date().toISOString(),
        ...(res.status === 'approved' ? { dailyNumber: res.dailyNumber, decidedAt: new Date().toISOString(), validUntil: res.validUntil, passCode: res.passCode, expected: true } : {}),
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
    <div className="checkin" ref={rootRef}>
      <div className="step-title">
        <h1>New visitor</h1>
        <p>Fill in everything below, then send. The host gets a message to approve.</p>
      </div>

      <section className={flag('visitor')} ref={sec.visitor} aria-labelledby="sec-visitor">
        <SectionHead id="sec-visitor" n={1} title="Visitor" done={done('visitor')} />
        <div className="field">
          <span id="lbl-mobile">Mobile number</span>
          <div className="mobile-boxes" role="group" aria-labelledby="lbl-mobile">
            <span className="mobile-cc">+91</span>
            <DigitBoxes length={10} gapAfter={[4]} value={digits} clean={cleanMobile} label="Mobile number, 10 digits" autoFocus
              invalid={(digits.length === 10 || tried) && !mobileOk}
              onChange={(d) => update({ mobile: d })} />
          </div>
          {digits.length === 10 && !mobileOk && <span className="hint err">Indian mobile numbers start with 6, 7, 8 or 9.</span>}
        </div>
        {mobileOk && otp.mode !== 'off' && !active && !blocked && !otp.verified && (
          <MobileVerify mobile={digits} mode={otp.mode} canSkip={otp.mode === 'optional' || isAdmin} value={verify} onChange={setVerify} />
        )}
        {active && active.status === 'away' && (
          <div className="alert alert-ok" role="alert">
            <BadgeCheck />
            <span className="grow">{active.message}</span>
            <button type="button" className="btn btn-sm btn-success" disabled={busy} onClick={reenter}>{busy ? <Spinner /> : <><LogIn />Let in again</>}</button>
          </div>
        )}
        {active && active.status !== 'away' && (
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
          <label className="field"><span>First name</span><input className="input" data-field="firstName" aria-invalid={tried && !NAME_RE.test(form.firstName.trim())} value={form.firstName} onChange={(e) => update({ firstName: e.target.value })} autoComplete="off" autoCapitalize="words" maxLength={60} /></label>
          <label className="field"><span>Last name</span><input className="input" data-field="lastName" aria-invalid={tried && !NAME_RE.test(form.lastName.trim())} value={form.lastName} onChange={(e) => update({ lastName: e.target.value })} autoComplete="off" autoCapitalize="words" maxLength={60} /></label>
        </div>
        <div className="field">
          <span id="lbl-gender">Gender</span>
          <div className="chips" role="radiogroup" aria-labelledby="lbl-gender" aria-invalid={tried && !form.gender}>
            {GENDERS.map(([key, label], i) => (
              <button type="button" role="radio" data-field={i === 0 ? 'gender' : undefined} aria-checked={form.gender === key} key={key} className="chip" aria-pressed={form.gender === key} onClick={() => update({ gender: form.gender === key ? '' : key })}>{label}</button>
            ))}
          </div>
        </div>
        <label className="field"><span>Company or coming from</span><input className="input" data-field="company" aria-invalid={tried && !form.company.trim()} value={form.company} onChange={(e) => update({ company: e.target.value })} autoComplete="off" maxLength={100} placeholder="e.g. Blue Dart, Infosys, Personal" /></label>
        {!showEmail && !form.email ? (
          <button type="button" className="link-add" onClick={() => { setShowEmail(true); setTimeout(() => rootRef.current?.querySelector('[data-field="email"]')?.focus(), 0); }}>
            <Plus />Add email <span className="faint">· optional</span>
          </button>
        ) : (
        <label className="field">
          <span>Email <span className="faint">· optional</span></span>
          <input className="input" data-field="email" type="email" inputMode="email" value={form.email} onChange={(e) => update({ email: e.target.value })} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={120} aria-invalid={Boolean(form.email.trim()) && !EMAIL_RE.test(form.email.trim())} />
          {Boolean(form.email.trim()) && !EMAIL_RE.test(form.email.trim()) && <span className="hint err">That email address does not look right. Fix it or clear it.</span>}
        </label>
        )}
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
        <div className="field">
          <span id="lbl-validity">Pass valid for</span>
          <div className="chips" role="radiogroup" aria-labelledby="lbl-validity">
            {VALIDITY.map(([key, label]) => (
              <button type="button" role="radio" key={key} className="chip" aria-checked={(form.validity || '8h') === key} aria-pressed={(form.validity || '8h') === key}
                onClick={() => update({ validity: key, ...(key === 'date' && !form.validUntilDay ? { validUntilDay: addDays(today(), 1) } : {}) })}>{label}</button>
            ))}
          </div>
          {form.validity === 'date' && (
            <input className="input" data-field="validUntilDay" type="date" style={{ maxWidth: 220 }} aria-label="Last day of the pass"
              min={today()} max={addDays(today(), MAX_PASS_DAYS)} value={form.validUntilDay || ''}
              aria-invalid={tried && !/^\d{4}-\d{2}-\d{2}$/.test(form.validUntilDay || '')}
              onChange={(e) => update({ validUntilDay: e.target.value })} />
          )}
          <span className="hint">{validityPreview(form.validity || '8h', form.validUntilDay)}</span>
        </div>
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
            <span id="lbl-idtype">ID card <span className="faint">· {idType === 'aadhaar' ? 'first 8 digits blacked out' : 'front of the card'}</span></span>
            <div className="chips id-types" role="radiogroup" aria-labelledby="lbl-idtype">
              {ID_TYPES.map(([key, label]) => (
                <button type="button" role="radio" aria-checked={idType === key} key={key} className="chip" aria-pressed={idType === key}
                  onClick={() => { if (key === idType) return; update({ idType: key }); if (idImage) { setIdImage(null); setIdInfo(null); setCam('aadhaar'); } }}>{label}</button>
              ))}
            </div>
            {idType === 'other' && (
              <input className="input" placeholder="Which ID? e.g. company ID" aria-label="Which ID" maxLength={40}
                value={form.idTypeOther || ''} onChange={(e) => update({ idTypeOther: e.target.value })} />
            )}
            {idImage || cam === 'aadhaar'
              ? <Camera mode="aadhaar" idType={idType} idLabel={idLabel} key={idType} keepFull={keepFullId} captured={idImage} info={idInfo} onCapture={(p, info) => { setIdImage(p); setIdInfo(fromCard(info)); setCam(null); }} onEdit={(p, how) => { setIdImage(p); setIdInfo((i) => ({ ...i, manual: Boolean(how?.manual) })); }} onRetake={() => { setIdImage(null); setIdInfo(null); setCam('aadhaar'); }} />
              : <CamTile icon={CreditCard} label={`Scan ${idLabel}`} onClick={() => setCam('aadhaar')} />}
          </div>
        </div>
        <IdCheck check={idCheck} idLabel={idLabel} filled={nameFromCard} onUse={takeCardDetails} />
        <FaceMatch match={match} />
      </section>

      {error && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{error}</span></div>}

      <div className="footer-bar">
        <div className="inner">
          {(tried || digits.length === 10) && missing.some(([, , l]) => l) && !blocked && !active && (
            <p className={`need${tried ? "" : " quiet"}`}>Still needed: {missing.map(([, , l]) => l).filter(Boolean).join(', ')}</p>
          )}
          <button type="button" className="btn btn-xl" onClick={reset} disabled={busy}>Clear</button>
          {blocked ? (
            <button type="button" className="btn btn-danger btn-xl" disabled><ShieldAlert />Do not admit</button>
          ) : active ? (
            <button type="button" className="btn btn-primary btn-xl" disabled>{active.status === 'away' ? 'Use “Let in again” above' : 'Already here: see the message above'}</button>
          ) : nextUp && !busy ? (
            <button type="button" className="btn btn-primary btn-xl" onClick={() => goTo(nextUp)}><ArrowDown />{NEXT_LABEL[nextUp[3]] || `Next: ${nextUp[2]}`}</button>
          ) : (
            <button type="button" className="btn btn-primary btn-xl" disabled={busy} onClick={submit}>
              {busy ? <><Spinner />Sending</> : invite && host && invite.host.id === host.id ? <><CheckCircle2 />Let in: expected visitor</> : <><Send />Send for approval</>}
            </button>
          )}
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

// The card against what was typed. Advice for the guard, like the face match: the visit goes ahead either way.
const GENDER_WORD = { male: 'Male', female: 'Female', other: 'Transgender' };
function IdCheck({ check, idLabel, filled, onUse }) {
  if (!check) return null;
  const from = check.source === 'qr' ? 'Aadhaar QR' : idLabel;
  if (check.status === 'unread') {
    return <div className="alert id-check" role="status"><ScanFace /><span className="grow">Could not read the name on the {idLabel}. Compare it by eye.</span></div>;
  }
  const tone = { match: 'alert-ok', partial: 'alert-warn', mismatch: 'alert-bad' }[check.status];
  const lines = [];
  if (check.tamper) lines.push('The QR does not belong to this card, check it carefully');
  if (check.name === 'match' && filled) lines.push(`Name filled in from the ${from}${check.source === 'qr' ? '' : ', check the spelling'}`);
  else if (check.name === 'match') lines.push(`Name matches the ${from}`);
  else if (check.name === 'partial') lines.push(check.cardName ? `Name only partly matches. Card: ${check.cardName}` : `Only part of the name was found on the ${idLabel}`);
  else if (check.name === 'mismatch') lines.push(check.cardName ? `Name does not match. Card: ${check.cardName}` : `Name not found on the ${idLabel}`);
  if (check.gender === 'match') lines.push('gender matches');
  else if (check.gender === 'mismatch') lines.push(`gender does not match: card says ${GENDER_WORD[check.cardGender]}`);
  const canUse = check.cardName && (check.name !== 'match' || check.gender === 'mismatch');
  return (
    <div className={`alert id-check ${tone}`} role="status">
      {check.status === 'match' ? <CheckCircle2 /> : <AlertTriangle />}
      <span className="grow"><strong>{lines[0][0].toUpperCase() + lines[0].slice(1)}</strong>{lines.length > 1 && <>{', '}{lines.slice(1).join(', ')}</>}.</span>
      {canUse && <button type="button" className="btn btn-sm" onClick={() => onUse(check)}>Use card details</button>}
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
function Outcome({ visit, sentAt, whatsapp, onNext, onResend, onCancel, onReprint, onPrint }) {
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
          {visit.smsStatus === 'email' && (
            <p className="muted" style={{ margin: 0 }}>Sent to {hostFirst} by email. Call them if no reply soon.</p>
          )}
          <div className="outcome-actions">
            {whatsapp && <a className="btn btn-whatsapp btn-lg" href={whatsapp} target="_blank" rel="noopener noreferrer"><MessageCircle />Send to {hostFirst} on WhatsApp</a>}
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
              {visit.validUntil && <div className="pass-valid"><Clock size={14} />Valid till <strong>{fmtUntil(visit.validUntil)}</strong></div>}
              {visit.passCode && (
                <div className="pass-code">
                  <QrImage value={visit.passCode} />
                  <div>
                    <strong className="mono">{showCode(visit.passCode)}</strong>
                    <small>Scanned at the gate to let them out, or back in. No printer? They can take a photo of this code.</small>
                  </div>
                </div>
              )}
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
          <div><h1>No reply from {hostFirst}</h1><p className="lead" style={{ margin: '6px auto 0' }}>Call {hostFirst}, or send the request again. If {visit.firstName} has left, cancel the visit.</p></div>
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

function QrImage({ value }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    passQr(value).then((d) => live && setSrc(d));
    return () => { live = false; };
  }, [value]);
  return src ? <img className="pass-qr" src={src} alt={`Pass code ${showCode(value)}`} /> : <span className="pass-qr" />;
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
.logos { display: flex; align-items: center; justify-content: center; gap: 4mm; margin-bottom: 1mm; }
.logos img { display: block; height: 11mm; width: auto; }
.logos img + span { width: .25mm; height: 10mm; background: #000; }
.logos img:last-child { height: 14mm; }
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
.valid { border: .5mm solid #000; padding: 1.5mm 2mm; margin: 0 0 3mm; font-size: 9pt; letter-spacing: .06em; }
.valid strong { display: block; font-size: 13pt; letter-spacing: 0; margin-top: .5mm; }
.qr { display: block; width: 32mm; height: 32mm; margin: 0 auto 1mm; image-rendering: pixelated; }
.code { font: 700 12pt ui-monospace, Consolas, monospace; letter-spacing: .1em; }
.scan { font-size: 8pt; letter-spacing: .12em; margin-top: .5mm; }
`;
const escHtml = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The photo as a data URL, so the print page needs no further request. Never waits long: a pass without a photo still prints.
// The pass code as a QR for the printed pass: crisp black squares, no margin (the slip has its own).
const passQr = (code) => (code ? QRCode.toDataURL(code, { margin: 0, width: 256, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).catch(() => '') : Promise.resolve(''));
const showCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c || '');

// Photos for the printed pass, kept for the session so a print never waits on the network twice.
const photoCache = new Map(); // visit id -> Promise<data URL or ''>
function photoData(id, known) {
  if (typeof known === 'string' && known.startsWith('data:')) return Promise.resolve(known); // taken on this device
  if (!photoCache.has(id)) {
    if (photoCache.size > 100) photoCache.clear();
    photoCache.set(id, fetchPhoto(id).then((d) => { if (!d) photoCache.delete(id); return d; }));
  }
  return photoCache.get(id);
}

async function fetchPhoto(id) {
  try {
    const res = await fetch(`/api/visits/${id}/photo`, { credentials: 'same-origin', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return '';
    const blob = await res.blob();
    return await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => resolve(''); r.readAsDataURL(blob); });
  } catch { return ''; }
}

function passHtml(visit, siteName, photo, qr) {
  const name = `${visit.firstName} ${visit.lastName}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Visitor pass ${escHtml(visit.dailyNumber)}</title><style>${PASS_CSS}</style></head><body>
<div class="logos"><img src="${location.origin}/brand/marquis-print.png" alt="Marriott Marquis"><span></span><img src="${location.origin}/brand/stregis-print.png" alt="St. Regis"></div>
<div class="title">VISITOR PASS</div>
<div class="no">${escHtml(visit.dailyNumber)}</div>
<div class="date">${escHtml(fmtDate(visit.decidedAt))} · ${escHtml(fmtTime(visit.decidedAt))}</div>
${visit.validUntil ? `<div class="valid">VALID TILL<strong>${escHtml(fmtUntil(visit.validUntil))}</strong></div>` : ''}
${photo ? `<img class="photo" src="${photo}" alt="">` : ''}
<div class="name">${escHtml(name)}</div>
<div class="company">${escHtml(visit.company)}</div>
<div class="rule"></div>
<div class="row"><span>Meeting</span><strong>${escHtml(visit.host?.name)}</strong></div>
<div class="row"><span>Flat / dept</span><strong>${escHtml(visit.host?.unit)}</strong></div>
<div class="row"><span>Visitor ID</span><strong>${escHtml(visit.ref)}</strong></div>
<div class="rule"></div>
${qr ? `<img class="qr" src="${qr}" alt=""><div class="code">${escHtml(showCode(visit.passCode))}</div><div class="scan">SCAN AT THE GATE</div><div class="rule"></div>` : ''}
<div class="foot">${visit.validUntil && new Date(visit.validUntil) - new Date(visit.decidedAt || Date.now()) > 86400e3 ? 'Show this pass at any gate each time you come in or go out.' : 'Wear this pass. Show it at the gate when you leave.'}</div>
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
      const [photo, qr] = await Promise.all([photoData(visit.id, visit.photo), passQr(visit.passCode)]);
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
        // Wait for the photo and both logos (never long: a pass prints even if an image is slow).
        const imgs = [...win.document.images].filter((im) => !im.complete);
        let left = imgs.length;
        if (!left) go();
        else { imgs.forEach((im) => { im.onload = im.onerror = () => { left -= 1; if (!left) go(); }; }); setTimeout(go, 1500); }
        setTimeout(finish, 5 * 60e3); // browsers that never report the end of printing
      };
      frame.srcdoc = passHtml(visit, siteName, photo, qr);
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
          <h1>{rows.some((r) => r.status === 'pending') || !rows.length ? 'Waiting for host' : 'Ready for their pass'}</h1>
          <p className="muted">{rows.length ? 'A pass number means the host said yes: print the pass and let them in. A timer means the host has not replied yet.' : 'Nobody is waiting right now.'}</p>
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
                {v.status === 'rejected' && <button className="btn btn-sm" onClick={() => onDismiss(v.id)}><Check />Done</button>}
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
  if (v.smsStatus === 'email') return <span className="tray-state wait"><span className="live-dot" />Emailed · {clock(secondsSince(v.createdAt))}</span>;
  return <span className="tray-state wait"><span className="live-dot" />{clock(secondsSince(v.createdAt))}</span>;
}

// ---------------------------------------------------------------- On premises
function InsideList({ data, onChanged, onPrint, onOpenGroup, onScan }) {
  const toast = useToast();
  useTick(30000);
  const [q, setQ] = useState('');
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const term = q.trim().toLowerCase();
  const match = (v) => !term || `${v.firstName} ${v.lastName} ${v.company} ${v.host?.name} ${v.host?.unit} ${v.dailyNumber} ${v.ref}`.toLowerCase().includes(term);
  const rows = (data?.visits || []).filter(match).slice().reverse();
  // People who should have left: their pass ended (or, for old passes, they have been in far too long). They come
  // first, oldest first, with a plain instruction, so nobody stays on the list by mistake.
  const overdue = (v) => v.passExpired || (!v.validUntil && minutesSince(v.lastIn?.at || v.decidedAt) >= data.staleAfterHours * 60);
  const late = rows.filter(overdue).reverse();
  const current = rows.filter((v) => !overdue(v));
  const away = (data?.away || []).filter(match);

  // Two taps for anything that changes a visit: the first arms the button, the second does it.
  const run = async (v, key, path, done) => {
    if (confirmId !== `${key}:${v.id}`) return setConfirmId(`${key}:${v.id}`);
    setBusyId(v.id);
    try {
      const r = await api(`/api/visits/${v.id}/${path}`, { method: 'POST' });
      done(r);
      setConfirmId(null);
      onChanged();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusyId(null);
    }
  };
  const name = (v) => `${v.firstName} ${v.lastName}`;
  const checkout = (v) => run(v, 'out', 'checkout', (r) => toast(r.status === 'away'
    ? `${name(v)} is out. The pass stays valid till ${fmtUntil(r.validUntil)}, so they can come back on it.`
    : `${name(v)} checked out.`));
  const letIn = (v) => run(v, 'in', 'reenter', () => toast(`${name(v)} let in again on pass ${v.dailyNumber}.`, 'ok'));
  const endPass = (v) => run(v, 'end', 'end-pass', () => toast(`${name(v)}’s pass has ended. It can no longer be used.`));
  const armed = (key, v) => confirmId === `${key}:${v.id}`;
  const disarm = (key, v) => setConfirmId((c) => (c === `${key}:${v.id}` ? null : c));

  const row = (v, isLate) => {
    const since = v.lastIn?.at || v.decidedAt;
    const mins = minutesSince(since);
    const day = since && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(since)) !== today() ? `${fmtDate(since)}, ` : '';
    return (
      <div className={`visitor-item${isLate ? ' is-expired' : ''}`} key={v.id}>
        <Avatar src={`/api/visits/${v.id}/photo`} name={name(v)} size={48} square />
        <div style={{ minWidth: 0 }}>
          <div className="top"><span className="pass-chip" title={`Pass number ${v.dailyNumber}`}>{v.dailyNumber}</span><span className="name">{name(v)}</span></div>
          <div className="meta"><Building2 size={13} style={{ verticalAlign: -2 }} /> {v.company} · to {v.host?.name}, {v.host?.unit}</div>
          <div className="time">
            In {day}{fmtTime(since)}{v.lastIn?.gate ? ` · ${v.lastIn.gate}` : ''} · {fmtDuration(mins)}
            {v.passExpired
              ? <span className="badge badge-bad">Pass ended {fmtUntil(v.validUntil)}</span>
              : v.validUntil ? <span className="badge">Valid till {fmtUntil(v.validUntil)}</span> : isLate && <span className="badge badge-warn">Inside a long time</span>}
          </div>
        </div>
        <div className="row-actions">
          <button type="button" className="btn btn-sm btn-icon btn-ghost" onClick={() => onPrint(v)} aria-label={`Print pass ${v.dailyNumber} again`} title="Print the pass again"><Printer /></button>
          <button type="button" className={`btn btn-sm ${armed('out', v) ? 'btn-danger' : isLate ? 'btn-primary' : ''}`} disabled={busyId === v.id} onClick={() => checkout(v)} onBlur={() => disarm('out', v)}>
            {busyId === v.id ? <Spinner /> : armed('out', v) ? <><CheckCircle2 />Tap again to confirm</> : <><LogOut />Check out</>}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="list-head">
        <div>
          <h1>On premises</h1>
          <p className="muted">{data ? `${data.count} ${data.count === 1 ? 'person' : 'people'} inside${data.away?.length ? ` · ${data.away.length} pass ${data.away.length === 1 ? 'holder' : 'holders'} out` : ''}` : 'Loading…'}</p>
        </div>
        <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => printEvacuation({ onError: (m) => toast(m, 'bad') })} title="Print everyone on the premises"><Siren /><span className="hide-narrow">Evacuation list</span></button>
      </div>
      <button type="button" className="scan-cta" onClick={onScan}>
        <ScanLine />
        <span className="grow"><strong>Someone leaving or coming back?</strong><small>Scan their pass. No need to search the list.</small></span>
        <ChevronRight />
      </button>
      {data?.groups?.length > 0 && (
        <div className="group-chips">
          {data.groups.map((g) => (
            <button type="button" key={g.id} className="group-chip" onClick={() => onOpenGroup?.(g.id)}>
              <PartyPopper /><span className="grow">{g.name}</span><strong className="num">{g.inside}</strong><span className="faint">inside</span>
            </button>
          ))}
        </div>
      )}
      <div className="input-group">
        <Search />
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, pass number, flat" aria-label="Search visitors" />
      </div>
      <div className="visitor-list">
        {!data && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 74, borderRadius: 16 }} />)}
        {data && rows.length === 0 && (
          <div className="panel">
            <Empty icon={data.count === 0 ? ShieldCheck : Search} title={data.count === 0 ? 'Nobody inside' : (data.visits || []).length === 0 ? 'Only event guests inside' : 'No match'}>
              {data.count === 0 ? 'Approved visitors appear here until they leave.' : (data.visits || []).length === 0 ? 'Tap an event above to see its guests.' : 'Try a pass number or flat.'}
            </Empty>
          </div>
        )}
        {late.length > 0 && (
          <div className="list-section bad">
            <strong><AlertTriangle />Pass ended: {late.length === 1 ? 'check this person out' : `check these ${late.length} people out`}</strong>
            <span>If they have left, press Check out. If they are still here, call their host.</span>
          </div>
        )}
        {late.map((v) => row(v, true))}
        {late.length > 0 && current.length > 0 && <div className="list-section"><strong>Inside now</strong></div>}
        {current.map((v) => row(v, false))}
      </div>

      {data && away.length > 0 && (
        <>
          <div className="list-head" style={{ marginTop: 8 }}>
            <div>
              <h2 className="side-title">Outside, pass still valid</h2>
              <p className="muted">They left but their pass runs for more days. When they come back, press Let in: no new approval is needed.</p>
            </div>
          </div>
          <div className="visitor-list">
            {away.map((v) => (
              <div className="visitor-item is-away" key={v.id}>
                <Avatar src={`/api/visits/${v.id}/photo`} name={name(v)} size={48} square />
                <div style={{ minWidth: 0 }}>
                  <div className="top"><span className="pass-chip">{passLabel(v)}</span><span className="name">{name(v)}</span></div>
                  <div className="meta"><Building2 size={13} style={{ verticalAlign: -2 }} /> {v.company} · to {v.host?.name}, {v.host?.unit}</div>
                  <div className="time">
                    {v.exit ? `Out ${fmtDate(v.exit.at)}, ${fmtTime(v.exit.at)}${v.exit.gate ? ` · ${v.exit.gate}` : ''}` : 'Outside'}
                    <span className="badge badge-ok">Valid till {fmtUntil(v.validUntil)}</span>
                  </div>
                </div>
                <div className="row-actions">
                  <button type="button" className={`btn btn-sm ${armed('end', v) ? 'btn-danger' : 'btn-ghost'}`} disabled={busyId === v.id} onClick={() => endPass(v)} onBlur={() => disarm('end', v)}>
                    {armed('end', v) ? <><CheckCircle2 />End pass?</> : <><X />End pass</>}
                  </button>
                  <button type="button" className={`btn btn-sm ${armed('in', v) ? 'btn-success' : 'btn-primary'}`} disabled={busyId === v.id} onClick={() => letIn(v)} onBlur={() => disarm('in', v)}>
                    {busyId === v.id ? <Spinner /> : armed('in', v) ? <><CheckCircle2 />Confirm</> : <><LogIn />Let in</>}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Groups that can be let in today
function TodaysGroups({ groups, openId, onOpen, onScan }) {
  return (
    <div className="todays-groups">
      <div className="list-head">
        <div>
          <h2 className="side-title">Today’s events</h2>
          <p className="muted">Scan their pass with the Scan pass button, or tap the event to find a guest by name.</p>
        </div>

      </div>
      <div className="visitor-list">
        {groups.map((g) => (
          <button type="button" key={g.id} className={`group-card${openId === g.id ? ' is-open' : ''}`} onClick={() => onOpen(g.id)}>
            <PartyPopper />
            <span className="grow">
              <strong>{g.name}</strong>
              <span className="faint">{g.days}{g.host ? ` · ${g.host.name}` : ''}</span>
            </span>
            <span className="group-card-n"><span className="num"><strong>{g.arrived}</strong>/{g.guests}</span><small>arrived</small></span>
          </button>
        ))}
      </div>
    </div>
  );
}
