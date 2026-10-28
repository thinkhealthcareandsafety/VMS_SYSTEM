import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Building2, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, ExternalLink,
  Eye, FileSpreadsheet, FolderArchive, History, LayoutDashboard, LogIn, LogOut, MessageSquare, Plus, Printer,
  RotateCcw, ScrollText, Search, ShieldCheck, Upload, UserPlus, Users, X, XCircle, KeyRound, UserCog, Info, Send,
  CalendarCheck, Ban, Settings as SettingsIcon, Save, Maximize2, PartyPopper, Siren, Package, Mail, Menu, CornerDownLeft, ChevronDown, TimerReset, Trash2,
} from 'lucide-react';
import { api, cardLabel, fmtDate, fmtDateTime, fmtDuration, fmtMobile, fmtTime, fmtUntil, minutesSince, passLabel, today } from '../api.js';
import QRCode from 'qrcode';
import HostPicker from '../components/HostPicker.jsx';
import ImageViewer from '../components/ImageViewer.jsx';
import { PasswordDialog, SecretBox } from '../components/Account.jsx';
import { useLive, useTick } from '../lib/live.js';
import { printEvacuation } from '../lib/evacuation.js';
import { printDailyReport, REPORT_PARTS } from '../lib/dailyReport.js';
import GroupsPage from './Groups.jsx';
import MaterialBoard from '../components/Material.jsx';
import CourierBoard from '../components/Couriers.jsx';
import { ExtendPassDialog, OverstayAlert } from '../components/Overstay.jsx';
import { EmergencyBar, EmergencyDialog, useEmergency } from '../components/Emergency.jsx';
import { LicenseBar, LicensePanel } from '../components/License.jsx';
import BulkImport from '../components/BulkImport.jsx';
import { Avatar, Empty, Logo, Modal, Spinner, StatusBadge, STATUS, useToast, useTitle, PoweredBy } from '../components/ui.jsx';

const TZ = 'Asia/Kolkata';
// Badges say what needs someone: a red one needs action now, a grey one is a count.
const NAV = [
  { group: 'Today', items: [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'inside', label: 'On premises', icon: Users, n: (s) => s.inside },
    { id: 'expected', label: 'Expected', icon: CalendarCheck, n: (s) => s.expectedToday },
    { id: 'groups', label: 'Events', icon: PartyPopper, n: (s) => s.groupsToday },
  ] },
  { group: 'Gate', items: [
    { id: 'material', label: 'Material in', icon: Package, n: (s) => s.materialAtGate },
    { id: 'couriers', label: 'Couriers', icon: Mail, n: (s) => s.parcelsWaiting, alert: (s) => s.parcelsOld > 0 || s.parcelsDeclined > 0 },
  ] },
  { group: 'Records', items: [
    { id: 'history', label: 'Visit history', icon: History },
    { id: 'audit', label: 'Audit log', icon: ScrollText },
  ] },
  { group: 'Setup', items: [
    { id: 'hosts', label: 'Hosts', icon: Building2 },
    { id: 'staff', label: 'Staff', icon: UserCog },
    { id: 'blocked', label: 'Blocked', icon: Ban },
    { id: 'settings', label: 'Settings', icon: SettingsIcon, n: (s) => s.printFailed + s.smsFailed, alert: () => true },
  ] },
];
// Page titles. "messages" has no menu entry: it opens from the failure alert and from Settings.
const TITLES = {
  overview: 'Overview', inside: 'On premises', history: 'Visit history', messages: 'Messages and prints', audit: 'Audit log',
  hosts: 'Hosts', staff: 'Staff accounts', expected: 'Expected visitors', groups: 'Events', material: 'Material inward register',
  couriers: 'Couriers', blocked: 'Blocked visitors', settings: 'Settings',
};

// ---------- date helpers (site timezone) ----------
const dayStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const daysAgo = (n) => dayStr(new Date(Date.now() - n * 86400e3));
const monthStart = () => `${dayStr(new Date()).slice(0, 8)}01`;
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const fmtHour = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const photoUrl = (id) => `/api/visits/${id}/photo`;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export default function Admin({ user, onLogout }) {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const section = TITLES[params.get('s')] ? params.get('s') : 'overview';
  const [navOpen, setNavOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  // Something a page should do once it opens (find a host, open an event, start an import), sent from the search box.
  const [intent, setIntent] = useState(null);
  const go = (s, extra = {}, then = null) => {
    setParams(s === 'overview' ? {} : { s, ...extra });
    setNavOpen(false);
    if (then) setIntent({ ...then, section: s, n: Date.now() });
    window.scrollTo(0, 0);
  };
  const [stats, setStats] = useState(null);
  const [tick, setTick] = useState(0); // bumps on every live event; pages reload on change
  const [visitId, setVisitId] = useState(null);
  const [exportOpts, setExportOpts] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [sos, setSos] = useState(false);

  // Ctrl+K (⌘K on a Mac) or "/" opens search from anywhere, unless the admin is typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!navOpen) return undefined;
    const esc = (e) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [navOpen]);

  const loadStats = useCallback(() => api('/api/admin/stats').then(setStats).catch(() => {}), []);
  const timer = useRef(null);
  const connected = useLive(() => {
    clearTimeout(timer.current); // coalesce bursts (create + sms.sent + print.sent)
    timer.current = setTimeout(() => { setTick((t) => t + 1); loadStats(); }, 250);
  });
  useEffect(() => {
    loadStats();
    const t = setInterval(() => { loadStats(); setTick((n) => n + 1); }, 60000); // safety net
    return () => clearInterval(t);
  }, [loadStats]);
  const refresh = () => { setTick((t) => t + 1); loadStats(); };
  const [emergency, setEmergency] = useEmergency(tick);

  const title = TITLES[section];
  useTitle(title);
  const myIntent = intent?.section === section ? intent : null;
  const page = { tick, refresh, go, openVisit: setVisitId, toast, stats, openExport: setExportOpts, params, intent: myIntent };
  const alerts = stats ? (stats.printFailed + stats.smsFailed + stats.overstayEscalated + stats.parcelsDeclined + (stats.parcelsOld ? 1 : 0)) : 0;

  return (
    <div className="console">
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Admin navigation">
        <Logo />
        <button type="button" className="find-btn" onClick={() => { setNavOpen(false); setFindOpen(true); }}>
          <Search /><span className="grow">Search</span><kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        {NAV.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <span className="group">{g.group}</span>
            {g.items.map(({ id, label, icon: Icon, n, alert }) => {
              const count = stats && n ? n(stats) || 0 : 0;
              const red = count > 0 && alert?.(stats);
              return (
                <button key={id} className="nav-item" aria-current={section === id || (id === 'settings' && section === 'messages') ? 'page' : undefined} onClick={() => go(id)}>
                  <Icon /><span className="grow">{label}</span>
                  {count > 0 && <span className={`n ${red ? 'alert-n' : ''}`}>{count}</span>}
                </button>
              );
            })}
          </div>
        ))}
        <span className="spacer" />
        <div className="me">
          <Avatar name={user.fullName} size={32} />
          <span className="grow"><strong>{user.fullName}</strong><small>{user.role === 'superadmin' ? 'Super Admin' : 'Administrator'}</small></span>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setPwOpen(true)} aria-label="Change password" title="Change password"><KeyRound /></button>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut /></button>
        </div>
        <PoweredBy className="side-powered" />
      </aside>

      <main className="admin-main">
        <header className="page-head">
          <div className="page-title">
            <button type="button" className="btn btn-ghost btn-icon nav-toggle" onClick={() => setNavOpen(true)} aria-label="Menu" aria-expanded={navOpen}>
              <Menu />{alerts > 0 && <span className="dot-alert" aria-hidden="true" />}
            </button>
            <div>
              {section === 'messages' && <button className="btn btn-ghost btn-sm back-link" onClick={() => go('settings')}><ChevronLeft />Settings</button>}
              <h1>{title}</h1>
            </div>
          </div>
          <div className="right">
            <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setSos(true)} title="Send an emergency message and start a roll call"><Siren />Emergency</button>
            <span className={`conn ${connected ? '' : 'off'}`} title={connected ? 'Updates as it happens' : 'Reconnecting'}><span className={`live-dot ${connected ? '' : 'off'}`} />{connected ? 'Live' : 'Reconnecting'}</span>
            <button type="button" className="btn btn-ghost btn-icon find-icon" onClick={() => setFindOpen(true)} aria-label="Search"><Search /></button>
          </div>
        </header>
        <div className="overstay-slot"><LicenseBar admin onOpen={() => go('settings')} /></div>
        <div className="overstay-slot"><EmergencyBar active={emergency} onOpen={() => setSos(true)} /></div>
        <div className="overstay-slot"><OverstayAlert admin liveTick={tick} onChanged={refresh} /></div>
        <EmergencyDialog open={sos} onClose={() => setSos(false)} active={emergency} onChanged={setEmergency} siteName={stats?.siteName} />
        <div className="page">
          {section === 'overview' && <Overview {...page} />}
          {section === 'inside' && <InsidePage {...page} />}
          {section === 'history' && <HistoryPage {...page} />}
          {section === 'messages' && <MessagesPage {...page} />}
          {section === 'audit' && <AuditPage {...page} />}
          {section === 'hosts' && <HostsPage {...page} />}
          {section === 'staff' && <StaffPage {...page} user={user} />}
          {section === 'expected' && <ExpectedPage {...page} />}
          {section === 'groups' && <GroupsPage {...page} />}
          {section === 'material' && <MaterialBoard admin liveTick={tick} lanyard={Boolean(user.checkin?.lanyardCards)} />}
          {section === 'couriers' && <CourierBoard admin liveTick={tick} />}
          {section === 'blocked' && <BlockedPage {...page} />}
          {section === 'settings' && <SettingsPage {...page} superAdmin={user.role === 'superadmin'} />}
        </div>
      </main>

      <QuickFind open={findOpen} onClose={() => setFindOpen(false)} go={go} openVisit={setVisitId} openExport={setExportOpts} stats={stats} toast={toast} />
      <VisitDrawer id={visitId} tick={tick} superAdmin={user.role === 'superadmin'} onClose={() => setVisitId(null)} onChanged={refresh} />
      <ExportDialog opts={exportOpts} onClose={() => setExportOpts(null)} />
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

// ================================================================= Search everything
// One box for the whole console: a visitor by name, mobile, visitor ID or today's pass number; a host; an event;
// a staff member; or a page and the common actions. Arrow keys and Enter, or tap.
const ACTIONS_QUICK = [
  { label: 'Add an expected visitor', icon: CalendarCheck, to: ['expected', {}, { action: 'add' }] },
  { label: 'Import expected visitors from a sheet', icon: Upload, to: ['expected', {}, { action: 'import' }] },
  { label: 'Add a host', icon: UserPlus, to: ['hosts', {}, { action: 'add' }] },
  { label: 'Import hosts from a sheet', icon: Upload, to: ['hosts', {}, { action: 'import' }] },
  { label: 'Add a staff account', icon: UserCog, to: ['staff', {}, { action: 'add' }] },
  { label: 'New event or group', icon: PartyPopper, to: ['groups', {}, { action: 'add' }] },
  { label: 'Download visitor data', icon: Download, run: ({ openExport }) => openExport({}) },
  { label: 'Print the evacuation list', icon: Siren, run: ({ toast }) => printEvacuation({ onError: (m) => toast(m, 'bad') }) },
  { label: "Print today's report: material, parcels in and out", icon: Printer, run: ({ toast }) => printDailyReport({ day: today(), parts: REPORT_PARTS.map((p) => p.key), onError: (m) => toast(m, 'bad') }) },
];
function QuickFind({ open, onClose, go, openVisit, openExport, toast }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef(null);
  useEffect(() => { if (open) { setQ(''); setFound(null); setActive(0); } }, [open]);

  const term = q.trim();
  useEffect(() => {
    if (!open || !term) { setFound(null); setLoading(false); return undefined; }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api(`/api/admin/search?q=${encodeURIComponent(term)}`)
        .then((r) => live && setFound(r)).catch(() => live && setFound({ visits: [], hosts: [], groups: [], staff: [] }))
        .finally(() => live && setLoading(false));
    }, 160);
    return () => { live = false; clearTimeout(t); };
  }, [term, open]);

  // Everything the admin can pick, in the order shown. Pages and actions match on their words.
  const items = useMemo(() => {
    const low = term.toLowerCase();
    const has = (label) => !low || label.toLowerCase().includes(low);
    const pages = NAV.flatMap((g) => g.items).filter((p) => has(p.label) || has(TITLES[p.id]))
      .map((p) => ({ key: `p:${p.id}`, group: 'Go to', icon: p.icon, title: TITLES[p.id], pick: () => go(p.id) }));
    const actions = ACTIONS_QUICK.filter((a) => has(a.label))
      .map((a) => ({ key: `a:${a.label}`, group: 'Do', icon: a.icon, title: a.label, pick: () => (a.run ? a.run({ openExport, toast }) : go(...a.to)) }));
    const f = found || { visits: [], hosts: [], groups: [], staff: [] };
    const visits = f.visits.map((v) => ({
      key: `v:${v.id}`, group: 'Visitors', photo: photoUrl(v.id), title: v.name,
      sub: `${v.ref}${v.dailyNumber != null ? ` · pass ${passLabel(v)}` : ''} · ${v.host}${v.unit ? `, ${v.unit}` : ''} · ${fmtDate(v.createdAt)}`,
      badge: v.status, pick: () => openVisit(v.id),
    }));
    const hosts = f.hosts.map((h) => ({ key: `h:${h.id}`, group: 'Hosts', icon: Building2, title: h.name, sub: `${h.unit}${h.active ? '' : ' · does not receive visitors'}`, pick: () => go('hosts', {}, { action: 'find', value: h.name }) }));
    const groups = f.groups.map((g) => ({ key: `g:${g.id}`, group: 'Events', icon: PartyPopper, title: g.name, sub: g.status === 'cancelled' ? 'Cancelled' : g.days, pick: () => go('groups', {}, { action: 'open', value: g.id }) }));
    const staff = f.staff.map((u) => ({ key: `u:${u.id}`, group: 'Staff', icon: UserCog, title: u.name, sub: `${u.username} · ${ROLE_INFO[u.role]?.[0] || u.role}${u.active ? '' : ' · switched off'}`, pick: () => go('staff', {}, { action: 'find', value: u.username }) }));
    return term ? [...visits, ...hosts, ...groups, ...staff, ...pages, ...actions] : [...actions.slice(0, 6), ...pages];
  }, [term, found, go, openVisit, openExport, toast]);

  useEffect(() => { setActive(0); }, [found, term]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const pick = (it) => { onClose(); it.pick(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); pick(items[active]); }
  };

  let lastGroup = null;
  return (
    <Modal open={open} onClose={onClose} label="Search" className="dialog finder">
      <div className="finder-input">
        <Search />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Visitor, mobile, pass number, host, event, staff…"
          aria-label="Search everything" role="combobox" aria-expanded="true" aria-controls="finder-list" aria-activedescendant={items[active] ? `fi-${active}` : undefined} autoComplete="off" spellCheck={false} />
        {loading ? <Spinner /> : <kbd>Esc</kbd>}
      </div>
      <div className="finder-list" id="finder-list" role="listbox" ref={listRef}>
        {term && found && !loading && items.length === 0 && <div className="finder-none">Nothing matches “{term}”. Try a mobile number or visitor ID.</div>}
        {items.map((it, i) => {
          const head = it.group !== lastGroup ? it.group : null;
          lastGroup = it.group;
          return (
            <div key={it.key}>
              {head && <div className="finder-group">{head}</div>}
              <button type="button" id={`fi-${i}`} role="option" aria-selected={i === active} className="finder-item" onMouseMove={() => setActive(i)} onClick={() => pick(it)}>
                {it.photo ? <Avatar src={it.photo} name={it.title} size={30} square /> : <span className="finder-icon"><it.icon /></span>}
                <span className="grow"><span className="t">{it.title}</span>{it.sub && <span className="s">{it.sub}</span>}</span>
                {it.badge && <StatusBadge status={it.badge} />}
                {i === active && <CornerDownLeft className="finder-enter" />}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ================================================================= Overview
// One line per thing that needs someone, most urgent first. Nothing to do: the list is not shown at all.
function Attention({ stats, go }) {
  const items = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (stats.smsFailed || stats.printFailed) {
    items.push({ tone: 'bad', icon: AlertTriangle, to: ['messages'], text: `${[stats.smsFailed && plural(stats.smsFailed, 'message', 'messages'), stats.printFailed && plural(stats.printFailed, 'sticker print', 'sticker prints')].filter(Boolean).join(' and ')} failed`, hint: 'Check the settings or the printer, then retry' });
  }
  const bk = stats.backup;
  if (bk && ['failed', 'stale'].includes(bk.state)) {
    items.push({ tone: 'bad', icon: AlertTriangle, to: ['settings'], text: bk.state === 'failed' ? `Last backup failed: ${bk.error}` : `No backup since ${bk.at ? fmtDateTime(bk.at) : 'the system started'}`, hint: 'Check the backup drive is plugged in to the server PC, then call GateSmartX' });
  }
  if (stats.disk?.low) items.push({ tone: 'bad', icon: AlertTriangle, to: ['settings'], text: `The server PC has only ${stats.disk.freeGb} GB of space left`, hint: 'Call GateSmartX before it fills up: new photos cannot be saved on a full disk' });
  if (stats.idMismatchToday) items.push({ tone: 'bad', icon: ShieldCheck, to: ['history', { idCheck: 'mismatch' }], text: `${plural(stats.idMismatchToday, 'visitor', 'visitors')} today with an ID that does not match the name or gender typed`, hint: 'Look at the card and the photo' });
  // People past their pass are not repeated here: the red bar at the top of every page lists them, with the actions.
  if (stats.parcelsDeclined) items.push({ tone: 'warn', icon: Mail, to: ['couriers'], text: `${plural(stats.parcelsDeclined, 'parcel was', 'parcels were')} declined by the recipient`, hint: 'Return it to the courier' });
  if (stats.parcelsOld) items.push({ tone: 'warn', icon: Mail, to: ['couriers'], text: `${plural(stats.parcelsOld, 'parcel has', 'parcels have')} waited more than 3 days`, hint: 'Call the recipient or return it' });
  if (!items.length) return null;
  return (
    <section className="panel attention" aria-labelledby="att-h">
      <div className="panel-head"><h2 id="att-h">Needs attention</h2><span className="sub num">{items.length}</span></div>
      <ul>
        {items.map((it) => (
          <li key={it.text}>
            <button className={`att-row ${it.tone}`} onClick={() => go(...it.to)}>
              <it.icon /><span className="grow"><strong>{it.text}</strong><small>{it.hint}</small></span><ArrowRight />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Overview({ stats, tick, go, openVisit, toast, refresh }) {
  const [pending, setPending] = useState(null);
  const [inside, setInside] = useState(null);
  useTick(30000);
  useEffect(() => {
    api('/api/admin/visits?status=pending&limit=20').then((r) => setPending(r.rows)).catch(() => setPending([]));
    api('/api/visits/inside').then(setInside).catch(() => {});
  }, [tick]);

  const resend = async (v) => {
    try { await api(`/api/visits/${v.id}/resend`, { method: 'POST' }); toast(`New request sent to ${v.host}.`); refresh(); } catch (e) { toast(e.message, 'bad'); }
  };
  const cancel = async (v) => {
    try { await api(`/api/visits/${v.id}/cancel`, { method: 'POST' }); toast(`${v.name}’s visit was cancelled.`); refresh(); } catch (e) { toast(e.message, 'bad'); }
  };

  if (!stats) return <div className="skeleton" style={{ height: 120, borderRadius: 14 }} />;
  const left = stats.checkedOutToday + stats.forceToday;
  const peak = stats.byHour.reduce((b, n, h) => (n > stats.byHour[b] ? h : b), 0);

  return (
    <>
      <Attention stats={stats} go={go} />

      <section className="panel kpis" aria-label="Today in numbers">
        <Kpi icon={Users} label="On premises" value={stats.inside} note={stats.staleInside ? `${stats.staleInside} past their pass` : 'Right now'} onClick={() => go('inside')} />
        <Kpi icon={LogIn} label="Arrivals today" value={stats.arrivalsToday} note={stats.arrivalsToday ? `Busiest ${fmtHour(peak)}–${fmtHour((peak + 1) % 24)}` : 'None yet'} onClick={() => go('history', { range: 'today' })} />
        <Kpi icon={Clock} label="Awaiting host" value={stats.pending} note={stats.pending ? 'Request sent, no reply yet' : 'Nobody waiting'} onClick={stats.pending ? () => document.getElementById('pend-h')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : undefined} />
        <Kpi icon={LogOut} label="Left today" value={left} note={stats.forceToday ? `${stats.forceToday} checked out by admin` : 'Checked out at the gate'} onClick={() => go('history', { range: 'today', status: 'checked_out' })} />
      </section>
      <GateStrip stats={stats} go={go} />

      <div className="overview-grid">
        <section className="panel" aria-labelledby="chart-h">
          <div className="panel-head">
            <div><h2 id="chart-h">Arrivals by hour</h2><span className="sub">Every visitor registered today</span></div>
          </div>
          <div className="panel-body"><HourChart byHour={stats.byHour} /></div>
        </section>

        <section className="panel" aria-labelledby="pend-h">
          <div className="panel-head">
            <h2 id="pend-h">Awaiting host</h2>
            <span className="sub num">{pending ? pending.length : ''}</span>
          </div>
          {!pending ? <ListSkeleton /> : pending.length === 0 ? (
            <Empty icon={CheckCircle2} title="Nobody waiting">Visitors waiting for a host reply show up here.</Empty>
          ) : (
            <div className="pending-list">
              {pending.map((v) => (
                <div className="pending-item" key={v.id}>
                  <Avatar src={photoUrl(v.id)} name={v.name} size={36} square />
                  <button className="grow link-row" onClick={() => openVisit(v.id)}>
                    <span className="name">{v.name}</span>
                    <span className="meta">to {v.host}, {v.unit} · waiting {fmtDuration(minutesSince(v.createdAt))}</span>
                  </button>
                  <button className="btn btn-sm" onClick={() => resend(v)} title="Send the host a fresh approval link"><RotateCcw />Resend</button>
                  <button className="btn btn-sm btn-ghost btn-icon" onClick={() => cancel(v)} aria-label={`Cancel ${v.name}’s visit`} title="Visitor left: cancel"><X /></button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="in-h">
        <div className="panel-head">
          <div><h2 id="in-h">On premises now</h2><span className="sub">Longest stay first</span></div>
          <button className="btn btn-ghost btn-sm" onClick={() => go('inside')}>View all<ArrowRight /></button>
        </div>
        {!inside ? <ListSkeleton /> : inside.count === 0 ? (
          <Empty icon={ShieldCheck} title="Nobody inside">Approved visitors appear here until they check out.</Empty>
        ) : (
          <InsideTable rows={inside.visits.slice(0, 6)} staleAfter={inside.staleAfterHours} openVisit={openVisit} compact />
        )}
      </section>
    </>
  );
}

// The rest of today's gate work on one quiet line, and only what has a number: nothing to do, nothing shown.
function GateStrip({ stats, go }) {
  const bits = [
    stats.expectedToday > 0 && { icon: CalendarCheck, text: `${stats.expectedToday} expected today`, to: 'expected' },
    stats.groupsToday > 0 && { icon: PartyPopper, text: `${stats.groupsToday} ${stats.groupsToday === 1 ? 'event' : 'events'} today`, to: 'groups' },
    stats.materialAtGate > 0 && { icon: Package, text: `${stats.materialAtGate} ${stats.materialAtGate === 1 ? 'vendor' : 'vendors'} inside with goods`, to: 'material' },
    stats.parcelsWaiting > 0 && { icon: Mail, text: `${stats.parcelsWaiting} ${stats.parcelsWaiting === 1 ? 'parcel' : 'parcels'} to collect`, to: 'couriers' },
  ].filter(Boolean);
  if (!bits.length) return null;
  return (
    <nav className="gate-strip" aria-label="Also today">
      {bits.map((b) => (
        <button type="button" key={b.to} className="gate-bit" onClick={() => go(b.to)}><b.icon />{b.text}<ChevronRight /></button>
      ))}
    </nav>
  );
}

function Kpi({ icon: Icon, label, value, note, onClick }) {
  const body = (
    <>
      <span className="k"><Icon />{label}</span>
      <span className="v">{value}</span>
      <span className="d">{note}</span>
    </>
  );
  return onClick ? <button type="button" className="kpi kpi-link" onClick={onClick}>{body}</button> : <div className="kpi">{body}</div>;
}

function ListSkeleton() {
  return <div style={{ padding: 18, display: 'grid', gap: 10 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 36 }} />)}</div>;
}

// Single-series column chart: one hue, 4px rounded caps square at the baseline, hover tooltip per hour.
function HourChart({ byHour }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const now = hourNow();
  const active = byHour.map((n, h) => (n ? h : null)).filter((h) => h !== null);
  const from = Math.min(8, ...active);
  const to = Math.max(20, now, ...active);
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(...hours.map((h) => byHour[h]));
  const top = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const ticks = [0, top / 2, top];

  const H = 190, padL = 30, padB = 24, padT = 8;
  const plotH = H - padT - padB;
  const band = width > padL ? (width - padL) / hours.length : 0;
  const barW = Math.max(4, Math.min(24, band * 0.62));
  const labelEvery = band < 26 ? 3 : band < 40 ? 2 : 1;
  const y = (v) => padT + plotH - (v / top) * plotH;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Arrivals per hour today">
          <g className="grid">{ticks.map((t) => <line key={t} x1={padL} x2={width} y1={y(t)} y2={y(t)} />)}</g>
          <g className="axis">
            {ticks.map((t) => <text key={t} x={padL - 8} y={y(t) + 4} textAnchor="end">{t}</text>)}
            {hours.map((h, i) => (i % labelEvery === 0
              ? <text key={h} x={padL + i * band + band / 2} y={H - 6} textAnchor="middle">{fmtHour(h).replace(' ', '')}</text>
              : null))}
          </g>
          {hours.map((h, i) => {
            const v = byHour[h];
            const x = padL + i * band + (band - barW) / 2;
            const yt = y(v);
            const ht = padT + plotH - yt;
            const r = Math.min(4, ht, barW / 2);
            return (
              <g key={h} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={h <= now ? 0 : -1}>
                <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
                {v > 0 && (
                  <path
                    className={`bar ${hover !== null && hover !== i ? 'dim' : ''}`}
                    d={`M${x},${yt + ht} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${yt + ht} Z`}
                  />
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && band > 0 && (() => {
        const h = hours[hover];
        return (
          <div className="chart-tip" style={{ left: padL + hover * band + band / 2, top: y(byHour[h]) }}>
            <strong className="num">{byHour[h]} {byHour[h] === 1 ? 'arrival' : 'arrivals'}</strong>
            <small>{fmtHour(h)} to {fmtHour((h + 1) % 24)}{h > now ? ' · later today' : ''}</small>
          </div>
        );
      })()}
      <table className="sr-only">
        <caption>Arrivals per hour today</caption>
        <tbody>{hours.map((h) => <tr key={h}><th>{fmtHour(h)}</th><td>{byHour[h]}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ================================================================= On premises
// Past the pass, or (passes from before validity existed) inside longer than the site allows.
const overstaying = (v, staleAfter) => v.passExpired || (!v.validUntil && minutesSince(v.lastIn?.at || v.decidedAt) >= staleAfter * 60);

function InsidePage({ tick, openVisit, refresh, toast, intent, stats }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [force, setForce] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [sweep, setSweep] = useState(false);
  const [extending, setExtending] = useState(null);
  useTick(30000);
  useEffect(() => { api('/api/visits/inside?all=1').then(setData).catch(() => {}); }, [tick]);
  // Someone who left (or was checked out elsewhere) drops out of the selection.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.visits.map((v) => v.id));
    setPicked((s) => (([...s].every((id) => ids.has(id))) ? s : new Set([...s].filter((id) => ids.has(id)))));
  }, [data]);

  const term = q.trim().toLowerCase();
  const rows = (data?.visits || []).filter((v) => !term || `${v.firstName} ${v.lastName} ${v.company} ${v.host?.name} ${v.host?.unit} ${v.dailyNumber} ${v.ref} ${v.mobile} card ${v.card?.no || ''}`.toLowerCase().includes(term));
  const over = (data?.visits || []).filter((v) => overstaying(v, data.staleAfterHours));
  // Arrived from the "still inside after the pass ended" alert: those people are ticked, ready to check out.
  const applied = useRef(null);
  useEffect(() => {
    if (intent?.action !== 'overstay' || !data || applied.current === intent.n) return;
    applied.current = intent.n;
    setPicked(new Set(over.map((v) => v.id)));
  }, [intent, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShown = rows.length > 0 && rows.every((v) => picked.has(v.id));
  const toggleAll = () => setPicked((s) => {
    const n = new Set(s);
    rows.forEach((v) => (allShown ? n.delete(v.id) : n.add(v.id)));
    return n;
  });
  const chosen = (data?.visits || []).filter((v) => picked.has(v.id));

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="input-group field wide">
          <Search />
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, pass number, card, flat, mobile" aria-label="Search on premises" />
        </div>
        <span className="muted num" style={{ alignSelf: 'center' }}>
          {data ? `${data.count} inside${data.groups?.length ? ` · ${data.groups.reduce((n, g) => n + g.inside, 0)} event guests` : ''}` : ''}
        </span>
        <span className="spacer-x" />
        {over.length > 0 && (
          <button className="btn btn-sm" onClick={() => setPicked(new Set(over.map((v) => v.id)))}><AlertTriangle />Select {over.length} past their pass</button>
        )}
        <button className="btn btn-sm btn-danger-outline" onClick={() => printEvacuation({ onError: (m) => toast(m, 'bad') })}><Siren />Evacuation list</button>
      </div>
      {!data ? <ListSkeleton /> : rows.length === 0 ? (
        <Empty icon={data.count ? Search : ShieldCheck} title={data.count ? 'No match' : 'Nobody inside'}>
          {data.count ? 'Try a pass number or flat.' : 'Approved visitors appear here until they check out.'}
        </Empty>
      ) : (
        <InsideTable rows={rows} staleAfter={data.staleAfterHours} openVisit={openVisit} printerOn={Boolean(stats?.printerOn)} onForce={setForce} onExtend={setExtending} picked={picked} onToggle={toggle} allPicked={allShown} onToggleAll={toggleAll} />
      )}
      {picked.size > 0 && (
        <div className="pick-bar" role="region" aria-label="Selected visitors">
          <span><strong className="num">{picked.size}</strong> selected</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => setSweep(true)}><LogOut />Check out {picked.size}</button>
        </div>
      )}
      <ForceDialog visit={force} onClose={() => setForce(null)} onDone={refresh} />
      <ForceDialog many={sweep ? chosen : null} onClose={() => setSweep(false)} onDone={() => { setPicked(new Set()); refresh(); }} />
      <ExtendPassDialog visit={extending} onClose={() => setExtending(null)} onDone={refresh} />
    </section>
  );
}

// The sticker button shows only with a network sticker printer: passes are otherwise printed at the gate.
function InsideTable({ rows, staleAfter, openVisit, printerOn = false, onForce, onExtend, compact, picked, onToggle, allPicked, onToggleAll }) {
  const selectable = Boolean(onToggle) && !compact;
  const toast = useToast();
  const reprint = async (e, v) => {
    e.stopPropagation();
    try { await api(`/api/visits/${v.id}/reprint`, { method: 'POST' }); toast(`Sticker ${v.dailyNumber} sent to the printer.`); } catch (err) { toast(err.message, 'bad'); }
  };
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {selectable && <th className="pick-col"><input type="checkbox" checked={allPicked} onChange={onToggleAll} aria-label="Select everyone shown" /></th>}
            <th>Pass</th><th>Visitor</th><th>Meeting</th><th>In since</th><th>Pass valid till</th>
            {!compact && <th className="r"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const since = v.lastIn?.at || v.decidedAt;
            const mins = minutesSince(since);
            const isLong = !v.validUntil && mins >= staleAfter * 60;
            const on = selectable && picked.has(v.id);
            return (
              <tr key={v.id} className={`clickable${on ? ' row-picked' : ''}`} onClick={() => openVisit(v.id)}>
                {selectable && (
                  <td className="pick-col" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={on} onChange={() => onToggle(v.id)} aria-label={`Select ${v.firstName} ${v.lastName}`} />
                  </td>
                )}
                <td><span className="pass-chip">{passLabel(v)}</span>{v.card && <div className="meta-line">{cardLabel(v.card)}</div>}</td>
                <td>
                  <div className="person">
                    <Avatar src={photoUrl(v.id)} name={`${v.firstName} ${v.lastName}`} size={36} square />
                    <div><div className="name">{v.firstName} {v.lastName}</div><div className="meta">{v.company} · <span className="mono">{v.ref}</span></div></div>
                  </div>
                </td>
                <td className="nowrap">{v.host?.name}<div className="meta-line">{v.host?.unit}</div></td>
                <td className="num">
                  {fmtTime(since)} · <span className={isLong ? 'row-flag' : ''}>{fmtDuration(mins)}</span>
                  {v.lastIn?.gate && <div className="meta-line" title={v.lastIn.by ? `Let in by ${v.lastIn.by}` : undefined}>{v.lastIn.gate}</div>}
                  {isLong && <div><span className="badge badge-warn">Long stay</span></div>}
                </td>
                <td className="num">
                  {v.passExpired ? <span className="badge badge-bad">Pass ended {fmtUntil(v.validUntil)}</span> : v.validUntil ? fmtUntil(v.validUntil) : <span className="faint">—</span>}
                  {v.validity && <div className="meta-line">{v.validity}{v.extensions?.length ? ` · extended ${v.extensions.length === 1 ? 'once' : `${v.extensions.length} times`}` : ''}</div>}
                  {v.passExpired && v.overstay?.escalatedAt && <div><span className="badge badge-bad">Escalated {fmtTime(v.overstay.escalatedAt)}</span></div>}
                  {v.passExpired && v.overstay?.ackAt && <div className="meta-line">Seen by {v.overstay.ackBy}{v.overstay.ackNote ? `: ${v.overstay.ackNote}` : ''}</div>}
                </td>
                {!compact && (
                  <td className="nowrap">
                    <div className="actions">
                      {printerOn && <button className="btn btn-sm btn-icon" onClick={(e) => reprint(e, v)} aria-label={`Reprint sticker ${v.dailyNumber}`} title="Reprint sticker"><Printer /></button>}
                      {onExtend && v.validUntil && !v.groupId && <button className="btn btn-sm btn-icon" onClick={(e) => { e.stopPropagation(); onExtend(v); }} aria-label={`Extend ${v.firstName}’s pass`} title="Extend the pass"><TimerReset /></button>}
                      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onForce(v); }}><LogOut />Check out</button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const FORCE_REASONS = ['Guard missed the exit', 'Left by another gate', 'Confirmed on CCTV', 'Host confirmed they left'];
const SWEEP_REASONS = ['End of day check', 'Guard missed the exit', 'Confirmed on CCTV', 'Left by another gate'];
// One visitor (`visit`) or several at once (`many`): the same reason goes on each record, each audited on its own.
function ForceDialog({ visit, many, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const open = Boolean(visit) || Boolean(many?.length);
  useEffect(() => { if (open) setReason(''); }, [visit?.id, open]);
  const name = visit ? `${visit.firstName || ''} ${visit.lastName || ''}`.trim() || visit.name : '';
  const n = many?.length || 0;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (visit) {
        await api(`/api/visits/${visit.id}/force-checkout`, { method: 'POST', body: { reason } });
        toast(`${name} checked out. Reason saved to the audit log.`);
      } else {
        const r = await api('/api/visits/force-checkout', { method: 'POST', body: { ids: many.map((v) => v.id), reason } });
        toast(`${r.checkedOut} checked out${r.skipped ? `. ${r.skipped} had already left` : ''}. Reason saved to each record.`);
      }
      onClose();
      onDone();
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} label="Check out visitor">
      {open && (
        <form onSubmit={submit}>
          <div className="dialog-head">
            <h2>{visit ? `Check out ${name}?` : `Check out ${n} ${n === 1 ? 'visitor' : 'visitors'}?`}</h2>
            <p>{visit ? 'Use this when the guard did not record the exit. ' : ''}Pick a reason or type your own, then press Check out. The reason is saved on {n > 1 ? 'each visitor’s record' : 'the record'} and in the audit log.</p>
          </div>
          <div className="dialog-body">
            {!visit && (
              <ul className="sweep-list">
                {many.slice(0, 8).map((v) => <li key={v.id}><span className="pass-chip">{passLabel(v)}</span>{v.firstName} {v.lastName}<span className="faint"> · {v.host?.name}</span></li>)}
                {n > 8 && <li className="faint">and {n - 8} more</li>}
              </ul>
            )}
            <div className="chips">
              {(visit ? FORCE_REASONS : SWEEP_REASONS).map((r) => <button type="button" key={r} className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
            </div>
            <label className="field">
              <span>Why are you checking {visit || n === 1 ? 'them' : 'these visitors'} out?</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={200} required placeholder="Pick one above or type your own" />
            </label>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-danger" disabled={busy || reason.trim().length < 5}>{busy ? <Spinner /> : <LogOut />}{visit ? 'Check out' : `Check out ${n}`}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ================================================================= History
const RANGES = [
  { id: 'today', label: 'Today', from: () => daysAgo(0), to: () => daysAgo(0) },
  { id: '7d', label: '7 days', from: () => daysAgo(6), to: () => '' },
  { id: 'month', label: 'This month', from: monthStart, to: () => '' },
  { id: 'all', label: 'All', from: () => '', to: () => '' },
];
const ID_CHECKS = [['mismatch', 'Does not match'], ['partial', 'Partly matches'], ['match', 'Matches'], ['unread', 'Not readable']];
function HistoryPage({ tick, openVisit, openExport, params }) {
  // Opened from an Overview number or alert: start on what was clicked.
  const preset = ID_CHECKS.some(([k]) => k === params.get('idCheck')) ? params.get('idCheck') : '';
  const presetStatus = STATUS[params.get('status')] ? params.get('status') : '';
  const todayOnly = Boolean(preset) || params.get('range') === 'today';
  const [f, setF] = useState({ name: '', host: '', company: '', status: presetStatus, gate: '', idCheck: preset, from: todayOnly ? daysAgo(0) : daysAgo(6), to: todayOnly ? daysAgo(0) : '' });
  const [gates, setGates] = useState([]);
  useEffect(() => { api('/api/admin/gates').then((r) => setGates(r.rows)).catch(() => {}); }, []);
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);

  // Apply as you type, without a button: debounce text, apply selects and dates at once.
  useEffect(() => { const t = setTimeout(() => { setApplied(f); setPage(1); }, 280); return () => clearTimeout(t); }, [f]);
  useEffect(() => {
    let live = true;
    api(`/api/admin/visits?${qs({ ...applied, page })}`).then((r) => live && setResult(r)).catch(() => live && setResult({ rows: [], total: 0, limit: 50 }));
    return () => { live = false; };
  }, [applied, page, tick]);

  const range = RANGES.find((r) => r.from() === f.from && r.to() === f.to)?.id || 'custom';
  const pages = result ? Math.max(1, Math.ceil(result.total / result.limit)) : 1;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <section className="panel">
      <div className="toolbar filter-grid" style={{ '--cols': gates.length > 1 ? 5 : 4 }}>
        <div className="field wide">
          <span className="label">Visitor</span>
          <div className="input-group"><Search /><input className="input" type="search" value={f.name} onChange={set('name')} placeholder="Name, visitor ID or mobile" /></div>
        </div>
        <label className="field"><span>Host</span><input className="input" value={f.host} onChange={set('host')} placeholder="Any host" /></label>
        <label className="field"><span>Company</span><input className="input" value={f.company} onChange={set('company')} placeholder="Any company" /></label>
        <label className="field"><span>Status</span>
          <select className="select" value={f.status} onChange={set('status')}>
            <option value="">Any status</option>
            {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="field"><span>Name on ID</span>
          <select className="select" value={f.idCheck} onChange={set('idCheck')}>
            <option value="">Any</option>
            {ID_CHECKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        {gates.length > 1 && (
          <label className="field"><span>Gate</span>
            <select className="select" value={f.gate} onChange={set('gate')}>
              <option value="">Any gate</option>
              {gates.map((g) => <option key={g.id} value={g.id}>{g.name}{g.active ? '' : ' (closed)'}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Date range">
          {RANGES.map((r) => <button key={r.id} aria-pressed={range === r.id} onClick={() => setF({ ...f, from: r.from(), to: r.to() })}>{r.label}</button>)}
        </div>
        <label className="field date"><span>From</span><input className="input" type="date" value={f.from} onChange={set('from')} /></label>
        <label className="field date"><span>To</span><input className="input" type="date" value={f.to} onChange={set('to')} /></label>
        <span className="spacer-x" />
        <button className="btn btn-sm" onClick={() => openExport({ ...applied })}><Download />Download these</button>
      </div>

      {!result ? <ListSkeleton /> : result.rows.length === 0 ? (
        <Empty icon={Search} title="No visits match">Widen the date range or clear a filter.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Visitor</th><th>Visitor ID</th><th>Meeting</th><th>Date</th><th>In / out</th><th>Status</th></tr></thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => openVisit(r.id)}>
                  <td>
                    <div className="person">
                      <Avatar src={photoUrl(r.id)} name={r.name} size={36} square />
                      <div><div className="name">{r.name}</div><div className="meta">{r.company} · <span className="num">{fmtMobile(r.mobile)}</span></div></div>
                    </div>
                  </td>
                  <td className="mono">{r.ref}</td>
                  <td>{r.host}<div className="meta-line">{r.unit}</div></td>
                  <td className="num">{fmtDate(r.createdAt)}{r.dailyNumber != null && <div className="meta-line">Pass {r.dailyNumber}{r.card ? ` · card ${r.card.no}` : ''}</div>}</td>
                  <td className="num">
                    {['approved', 'away', 'checked_out', 'force_checked_out'].includes(r.status) ? (
                      <>
                        <div><span className="move-tag in">In</span>{fmtTime(r.entry?.at || r.decidedAt)}<span className="meta-line">{r.entry?.gate ? ` · ${r.entry.gate}` : ''}{r.entry?.by ? ` · ${r.entry.by}` : ''}</span></div>
                        <div className="meta-line">
                          {r.status === 'approved'
                            ? 'still inside'
                            : r.exit
                              ? <><span className="move-tag out">Out</span>{fmtTime(r.exit.at)}{r.exit.gate ? ` · ${r.exit.gate}` : ''}{r.exit.by ? ` · ${r.exit.by}` : ''}</>
                              : r.checkedOutAt ? <><span className="move-tag out">Out</span>{fmtTime(r.checkedOutAt)}{r.forceReason ? ' · by admin' : ''}</> : ''}
                          {r.entries > 1 ? ` · ${r.entries} entries` : ''}
                        </div>
                      </>
                    ) : <span className="faint">—</span>}
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.idCheck?.status === 'mismatch' && <div className="meta-line"><span className="badge badge-bad plain">ID does not match</span></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && result.total > 0 && (
        <div className="pager">
          <span className="num">{(page - 1) * result.limit + 1}–{Math.min(page * result.limit, result.total)} of {result.total}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft />Previous</button>
            <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next<ChevronRight /></button>
          </div>
        </div>
      )}
    </section>
  );
}

// ================================================================= Visit detail drawer
const ACTIONS = {
  'visit.created': ['Registered at the gate', ''],
  'visit.cancelled': ['Cancelled: visitor left before a reply', 'warn'],
  'visit.expired': ['Approval link expired', 'warn'],
  'visit.approved': ['Host let them in', 'ok'],
  'visit.rejected': ['Host declined', 'bad'],
  'visit.resent': ['Approval SMS sent again', ''],
  'visit.checked_out': ['Checked out at the gate', ''],
  'visit.force_checked_out': ['Checked out by admin', 'warn'],
  'sticker.reprint_requested': ['Sticker reprint requested', ''],
  'pass.printed': ['Pass printed at the gate', ''],
  'sms.failed': ['SMS could not be sent', 'bad'],
  'print.failed': ['Sticker failed to print', 'bad'],
  'id_image.viewed': ['Aadhaar image viewed', 'warn'],
  'export.visits_csv': ['Downloaded the visit sheet', ''],
  'export.visits_zip': ['Downloaded the full record', ''],
  'export.visits_xlsx': ['Downloaded the Excel sheet', ''],
  'host.created': ['Host added', ''],
  'host.updated': ['Host updated', ''],
  'host.imported': ['Hosts imported', ''],
  'invite.imported': ['Expected visitors imported', ''],
  'visit.went_out': ['Went out on a valid pass', ''],
  'visit.reentered': ['Let in again on the same pass', 'ok'],
  'visit.pass_ended': ['Pass ended early', ''],
  'visit.pass_expired': ['Pass ran out while outside', ''],
  'visit.auto_checked_out': ['Checked out automatically: event ended', ''],
  'visit.pass_extended': ['Pass extended', ''],
  'visit.card_set': ['Lanyard card recorded', ''],
  'license.installed': ['Licence key entered', 'ok'],
  'emergency.started': ['Emergency started, roll call opened', 'bad'],
  'emergency.message': ['Emergency message sent', 'warn'],
  'emergency.safe': ['Marked safe at the assembly point', 'ok'],
  'emergency.unsafe': ['Safe mark taken back', ''],
  'emergency.closed': ['Emergency ended', 'ok'],
  'visit.overstay_acknowledged': ['Pass ended: seen by the guard', 'warn'],
  'visit.overstay_escalated': ['Still inside an hour after the pass: escalated', 'bad'],
  'material.received': ['Goods recorded at the gate', ''],
  'material.checked_out': ['Vendor checked out', ''],
  'material.exported': ['Downloaded the material register', ''],
  'parcel.received': ['Parcel logged at the gate', ''],
  'parcel.accepted': ['Recipient accepted the parcel', 'ok'],
  'parcel.declined': ['Recipient declined the parcel', 'warn'],
  'parcel.collected': ['Parcel handed over', ''],
  'parcel.forwarded': ['Parcel handed to a department', ''],
  'parcel.returned': ['Parcel returned to the courier', 'warn'],
  'parcel.booked': ['Outgoing parcel logged', ''],
  'parcel.dispatched': ['Outgoing parcel picked up', ''],
  'parcel.reminded': ['Parcel reminder sent', ''],
  'parcel.voided': ['Parcel voided', 'warn'],
  'parcel.exported': ['Downloaded the courier register', ''],
  'id_image_full.viewed': ['Full Aadhaar viewed (Super Admin)', 'warn'],
  'gate.created': ['Gate added', ''],
  'gate.updated': ['Gate changed', ''],
  'group.created': ['Event created', ''],
  'group.updated': ['Event changed', ''],
  'group.cancelled': ['Event cancelled', 'warn'],
  'group.guests_added': ['Guests added to an event', ''],
  'group.guest_removed': ['Guest taken off the list', ''],
  'group.walk_in': ['Walk-in added at the gate', ''],
  'group.checked_out_all': ['Everyone in an event checked out', ''],
  'whatsapp.failed': ['WhatsApp could not be sent', 'bad'],
  'telegram.failed': ['Telegram message failed', 'bad'],
  'email.failed': ['Email could not be sent', 'bad'],
  'auth.login': ['Signed in', ''],
  'auth.password_changed': ['Changed their password', ''],
  'otp.sent': ['Verification code sent', ''],
  'otp.verified': ['Mobile number verified by OTP', 'ok'],
  'otp.wrong': ['Wrong verification code entered', 'warn'],
  'otp.failed': ['Verification SMS could not be sent', 'bad'],
  'visit.blocked_attempt': ['Blocked visitor tried to check in', 'bad'],
  'invite.created': ['Expected visitor added', ''],
  'invite.cancelled': ['Expected visitor cancelled', ''],
  'block.added': ['Visitor blocked', 'warn'],
  'block.removed': ['Block removed', ''],
  'settings.updated': ['Settings changed', ''],
  'host.telegram_connected': ['Host connected Telegram', 'ok'],
  'host.telegram_link': ['Telegram connect link made', ''],
  'user.created': ['Staff account added', ''],
  'user.updated': ['Staff account changed', ''],
  'user.password_reset': ['Staff password reset', 'warn'],
  'auth.login_failed': ['Failed sign-in attempt', 'bad'],
  'visit.approved_by_phone': ['Let in by the guard: host said yes on the phone', 'ok'],
  'visit.scan_undone': ['Scan taken back (by mistake)', ''],
  'host.deleted': ['Host deleted', 'warn'],
  'report.daily': ['Printed the daily report', ''],
  'material.requested': ['Gate pass requested', ''],
  'material.approved': ['Gate pass approved', 'ok'],
  'material.rejected': ['Gate pass declined', 'bad'],
  'material.cancelled': ['Material entry cancelled', 'warn'],
  'material.handed_over': ['Goods handed to the department', ''],
  'material.let_out': ['Tools taken back out', ''],
  'material.returned': ['Goods came back', ''],
  'material.resent': ['Approval request sent again', ''],
  'group.guest_updated': ['Guest details changed', ''],
  'group.self_registered': ['Guest added themselves by the event link', ''],
  'group.join_refused': ['Event link refused a guest', 'warn'],
  'group.list_downloaded': ['Downloaded an event guest list', ''],
};
const VERIFIED_LABEL = { otp: 'Verified by OTP', expected: 'Expected visitor, number from the host', returning: 'Verified earlier (within 90 days)', skipped: 'Not verified (skipped by the guard)' };
const GENDER_LABEL = { male: 'Male', female: 'Female', other: 'Other' };
const actionLabel = (a) => ACTIONS[a]?.[0] || a;
const TL_ICON = { ok: CheckCircle2, bad: XCircle, warn: AlertTriangle };
// How the guard's phone masked the Aadhaar number before upload.
const ID_CHECK_TEXT = { match: ['Name matches the card', 'badge-ok'], partial: ['Name only partly matches the card', 'badge-warn'], mismatch: ['Name or gender does not match the card', 'badge-bad'], unread: ['Name on the card could not be read', ''] };
function IdCheckLine({ c }) {
  const [text, cls] = ID_CHECK_TEXT[c.status] || ID_CHECK_TEXT.unread;
  const bits = [c.source === 'qr' ? 'read from the Aadhaar QR' : c.source === 'ocr' ? 'read from the printed card' : '', c.gender === 'mismatch' ? 'gender differs' : c.gender === 'match' ? 'gender matches' : '', c.tamper ? 'the QR does not belong to this card' : ''].filter(Boolean);
  return <p style={{ margin: '0 0 10px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><span className={`badge ${cls}`}>{text}</span>{bits.length > 0 && <span className="faint" style={{ fontSize: 12.5 }}>{bits.join(' · ')}. Checked on the guard’s device; advice only.</span>}</p>;
}

const maskNote = (m) => {
  const [how, manual] = m.split('+');
  if (how === 'none') return manual ? 'Not an Aadhaar: nothing hidden automatically. The guard blacked out parts by hand.' : 'Not an Aadhaar: stored as photographed.';
  const base = { auto: 'Number found and hidden automatically on the guard’s phone', already: 'Card was already masked (UIDAI masked Aadhaar)', guide: 'Number could not be read; the standard area was hidden' }[how] || 'Masked on the guard’s phone';
  return manual ? `${base}. The guard blacked out more by hand.` : `${base}.`;
};

function VisitDrawer({ id, tick, superAdmin, onClose, onChanged }) {
  const toast = useToast();
  const [v, setV] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [showId, setShowId] = useState(false);
  const [force, setForce] = useState(null);
  const [blocking, setBlocking] = useState(null);
  const [extending, setExtending] = useState(null);
  const [zoomed, setZoomed] = useState(null); // { src, title } shown full size
  const [idUrl, setIdUrl] = useState(null);

  // The masked Aadhaar is fetched once per "Show" (each fetch is an audited view) and shared by
  // the inline preview and the full-size viewer.
  useEffect(() => {
    if (!showId || !id) return undefined;
    let url = null;
    let alive = true;
    fetch(`/api/visits/${id}/id-image`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Not available'))))
      .then((b) => { if (alive) { url = URL.createObjectURL(b); setIdUrl(url); } })
      .catch(() => alive && setIdUrl('error'));
    return () => { alive = false; if (url) URL.revokeObjectURL(url); setIdUrl(null); };
  }, [showId, id]);

  // The full Aadhaar: Super Admin only, fetched on request (an audited view), held in memory only while shown.
  const [fullUrl, setFullUrl] = useState(null);
  const [showFull, setShowFull] = useState(false);
  useEffect(() => {
    if (!showFull || !id) return undefined;
    let url = null;
    let alive = true;
    fetch(`/api/visits/${id}/id-image-full`, { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Not available'))))
      .then((b) => { if (alive) { url = URL.createObjectURL(b); setFullUrl(url); } })
      .catch(() => alive && setFullUrl('error'));
    return () => { alive = false; if (url) URL.revokeObjectURL(url); setFullUrl(null); };
  }, [showFull, id]);

  useEffect(() => { setV(null); setTimeline(null); setShowId(false); setShowFull(false); }, [id]);
  useEffect(() => {
    if (!id) return;
    api(`/api/visits/${id}`).then(setV).catch((e) => toast(e.message, 'bad'));
    api(`/api/admin/visits/${id}/timeline`).then((r) => setTimeline(r.rows)).catch(() => setTimeline([]));
  }, [id, tick, toast]);

  const act = async (path, msg) => {
    try { await api(`/api/visits/${id}/${path}`, { method: 'POST' }); toast(msg); onChanged(); } catch (e) { toast(e.message, 'bad'); }
  };
  const admitted = v && ['approved', 'away', 'checked_out', 'force_checked_out'].includes(v.status);
  const name = v ? `${v.firstName} ${v.lastName}` : '';

  return (
    <Modal open={Boolean(id)} onClose={onClose} className="drawer" label="Visit details">
      <div className="drawer-head">
        <strong>Visit details</strong>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="drawer-body">
        {!v ? <ListSkeleton /> : (
          <>
            <div className="profile">
              <button type="button" className="photo-btn" onClick={() => setZoomed({ src: photoUrl(v.id), title: `${name} · photo at the gate` })} aria-label="Open the photo full size">
                <img className="photo" src={photoUrl(v.id)} alt={`Photo of ${name}`} />
              </button>
              <div style={{ display: 'grid', gap: 6 }}>
                <h2>{name}</h2>
                <span className="muted">{v.company}</span>
                <span><StatusBadge status={v.status} /></span>
              </div>
            </div>

            <dl className="dl">
              <dt>Visitor ID</dt><dd className="mono">{v.ref}</dd>
              {v.dailyNumber != null && <><dt>Pass number</dt><dd className="num">{v.dailyNumber} · {fmtDate(v.decidedAt)}</dd></>}
              <dt>Mobile</dt><dd className="num">{fmtMobile(v.mobile)}</dd>
              {v.email && <><dt>Email</dt><dd>{v.email}</dd></>}
              {v.mobileVerified && <><dt>Number</dt><dd>{VERIFIED_LABEL[v.mobileVerified]}</dd></>}
              <dt>Gender</dt><dd>{GENDER_LABEL[v.gender] || <span className="faint">Not recorded</span>}</dd>
              <dt>Purpose</dt><dd>{v.purpose || <span className="faint">Not given</span>}</dd>
              <dt>Meeting</dt><dd>{v.host?.name}, {v.host?.unit}</dd>
              <dt>Arrived</dt><dd className="num">{fmtDateTime(v.createdAt)}</dd>
              {admitted && <><dt>Let in</dt><dd className="num">{fmtDateTime(v.decidedAt)}</dd></>}
              {v.checkedOutAt && <><dt>Left</dt><dd className="num">{fmtDateTime(v.checkedOutAt)} · {fmtDuration(Math.round((new Date(v.checkedOutAt) - new Date(v.decidedAt)) / 60000))} inside</dd></>}
              {v.validUntil && <><dt>Pass</dt><dd>{v.validity} · valid till {fmtDateTime(v.validUntil)}</dd></>}
              {v.card && <><dt>Lanyard card</dt><dd>{cardLabel(v.card)}</dd></>}
              {v.extensions?.length > 0 && <><dt>Extended</dt><dd>{v.extensions.map((x, i) => <div key={i}>{fmtDateTime(x.at)} by {x.by}: to {fmtDateTime(x.to)}{x.note ? ` · ${x.note}` : ''}</div>)}</dd></>}
              {v.overstay && <><dt>Overstay</dt><dd>{v.overstay.ackAt ? `Seen by ${v.overstay.ackBy} at ${fmtDateTime(v.overstay.ackAt)}${v.overstay.ackNote ? `: ${v.overstay.ackNote}` : ''}` : 'Not acknowledged'}{v.overstay.escalatedAt && <div className="tone-bad">Escalated {fmtDateTime(v.overstay.escalatedAt)}</div>}</dd></>}
              {v.forceReason && <><dt>Checkout reason</dt><dd>{v.forceReason}</dd></>}
              {v.printStatus && v.printStatus !== 'off' && <><dt>Sticker</dt><dd>{v.printStatus === 'off' ? 'No printer connected' : v.printStatus === 'sent' ? 'Printed' : v.printStatus === 'failed' ? `Failed${v.printError ? `: ${v.printError}` : ''}` : 'In the print queue'}</dd></>}
            </dl>

            {v.movements?.length > 0 && (
              <div>
                <h3 className="section-title">Entries and exits</h3>
                <ol className="moves">
                  {v.movements.map((m, i) => (
                    <li key={i} className={`move move-${m.kind}`}>
                      <span className="move-kind">{m.kind === 'in' ? <LogIn /> : <LogOut />}{m.kind === 'in' ? 'In' : 'Out'}</span>
                      <span className="move-where"><strong>{m.gate || 'Gate not recorded'}</strong>{m.by && <span className="faint"> · {m.by}</span>}</span>
                      <span className="num move-when">{fmtDateTime(m.at)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div>
              <h3 className="section-title">{v.idType && v.idType !== 'aadhaar' ? v.idLabel : 'Aadhaar card (masked)'}</h3>
              {v.idCheck && <IdCheckLine c={v.idCheck} />}
              {!v.hasIdImage ? (
                <p className="muted">Deleted automatically after the retention period.</p>
              ) : showId ? (
                idUrl === 'error' ? <p className="muted">The image could not be loaded.</p>
                  : !idUrl ? <div className="skeleton" style={{ height: 160, borderRadius: 12 }} />
                    : (
                      <button type="button" className="id-frame id-open" onClick={() => setZoomed({ src: idUrl, title: `${name} · masked Aadhaar`, status: v.idMaskMethod && { tone: v.idMaskMethod.startsWith('guide') ? 'warn' : 'ok', text: maskNote(v.idMaskMethod) } })} aria-label="Open the masked Aadhaar full size">
                        <img src={idUrl} alt="Masked Aadhaar card" />
                        <span className="shot-zoom"><Maximize2 />Open full size</span>
                      </button>
                    )
              ) : (
                <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                  <button className="btn btn-sm" onClick={() => setShowId(true)}><Eye />{v.idType && v.idType !== 'aadhaar' ? `Show ${v.idLabel}` : 'Show masked Aadhaar'}</button>
                  <span className="faint" style={{ fontSize: 12.5 }}>Each view is recorded in the audit log.</span>
                </div>
              )}
              {superAdmin && v.hasFullId && (
                <div className="full-id">
                  <h3 className="section-title">Full Aadhaar <span className="badge role-super">Super Admin only</span></h3>
                  {!showFull ? (
                    <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                      <button className="btn btn-sm" onClick={() => setShowFull(true)}><Eye />Show full Aadhaar</button>
                      <span className="faint" style={{ fontSize: 12.5 }}>Unmasked. Each view is recorded in the audit log with your name.</span>
                    </div>
                  ) : fullUrl === 'error' ? <p className="muted">The image could not be loaded.</p>
                    : !fullUrl ? <div className="skeleton" style={{ height: 160, borderRadius: 12 }} />
                      : (
                        <>
                          <button type="button" className="id-frame id-open" onClick={() => setZoomed({ src: fullUrl, title: `${name} · full Aadhaar (Super Admin)` })} aria-label="Open the full Aadhaar full size">
                            <img src={fullUrl} alt="Full Aadhaar card" />
                            <span className="shot-zoom"><Maximize2 />Open full size</span>
                          </button>
                          <button className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={() => setShowFull(false)}><X />Hide</button>
                        </>
                      )}
                </div>
              )}
              {v.idMaskMethod && <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>{maskNote(v.idMaskMethod)}</p>}
              {v.faceMatchStatus && (
                <p className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
                  {v.faceMatchStatus === 'scored'
                    ? `Face match ${v.faceMatchScore}%: live photo against the card photo, compared on the guard’s device. Advice only.`
                    : { no_card_face: 'Face match: no face could be read on the card.', no_photo_face: 'Face match: no face could be read in the live photo.', unavailable: 'Face match was not available on that device.' }[v.faceMatchStatus]}
                </p>
              )}
            </div>

            <div>
              <h3 className="section-title">Timeline</h3>
              {!timeline ? <Spinner /> : timeline.length === 0 ? <p className="muted">No events recorded.</p> : (
                <ol className="timeline">
                  {timeline.map((t, i) => {
                    const tone = ACTIONS[t.action]?.[1] || '';
                    const I = TL_ICON[tone] || Clock;
                    return (
                      <li key={i}>
                        <span className={`tdot ${tone}`}><I /></span>
                        <div>
                          <div className="what">{actionLabel(t.action)}</div>
                          <div className="when">{fmtDateTime(t.at)} · {t.role === 'host' ? 'Host' : t.actor}{t.details?.via ? ` · ${VIA[t.details.via] || t.details.via}` : ''}{t.details?.reason ? ` · “${t.details.reason}”` : ''}</div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </>
        )}
      </div>
      {v && (
        <div className="drawer-foot">
          {['pending', 'expired'].includes(v.status) && <button className="btn btn-ghost" onClick={() => act('cancel', 'Visit cancelled. The host’s link no longer works.')}><X />Cancel visit</button>}
          {['pending', 'expired'].includes(v.status) && <button className="btn" onClick={() => act('resend', 'New request sent to the host.')}><RotateCcw />Resend request</button>}
          {admitted && v.printStatus && v.printStatus !== 'off' && <button className="btn" onClick={() => act('reprint', 'Sticker sent to the printer.')}><Printer />Reprint sticker</button>}
          <button className="btn btn-ghost" onClick={() => setBlocking({ mobile: v.mobile, name: `${v.firstName} ${v.lastName}` })}><Ban />Block</button>
          {['approved', 'away'].includes(v.status) && v.validUntil && !v.groupId && <button className="btn" onClick={() => setExtending(v)}><TimerReset />Extend pass</button>}
          {['approved', 'away'].includes(v.status) && <button className="btn" onClick={() => setForce(v)}><LogOut />{v.status === 'away' ? 'End pass' : 'Check out'}</button>}
        </div>
      )}
      <ExtendPassDialog visit={extending} onClose={() => setExtending(null)} onDone={onChanged} />
      <ForceDialog visit={force} onClose={() => setForce(null)} onDone={onChanged} />
      <BlockDialog prefill={blocking} onClose={() => setBlocking(null)} onDone={onChanged} />
      <ImageViewer open={Boolean(zoomed)} onClose={() => setZoomed(null)} src={zoomed?.src} alt={zoomed?.title} title={zoomed?.title} status={zoomed?.status} />
    </Modal>
  );
}

// ================================================================= SMS and prints
const LINK_RE = /https?:\/\/\S+/;
function OutboxBadge({ status, logged }) {
  if (status === 'sent') return logged ? <span className="badge">Logged</span> : <span className="badge badge-ok">Sent</span>;
  if (status === 'failed') return <span className="badge badge-bad">Failed</span>;
  return <span className="badge badge-warn">{logged ? 'Queued' : 'Retrying'}</span>;
}

function MessagesPage({ tick, stats }) {
  const [kind, setKind] = useState('sms');
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); }, [kind]);
  useEffect(() => { api(`/api/admin/outbox?kind=${kind}`).then((d) => setRows(d.rows)).catch(() => setRows([])); }, [kind, tick]);
  const failed = { sms: stats?.smsFailed || 0, print: stats?.printFailed || 0 };

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Message type">
          <button aria-pressed={kind === 'sms'} onClick={() => setKind('sms')}><MessageSquare size={14} />Approval messages{failed.sms > 0 && <span className="n bad-n">{failed.sms} failed</span>}</button>
          <button aria-pressed={kind === 'print'} onClick={() => setKind('print')}><Printer size={14} />Sticker prints{failed.print > 0 && <span className="n bad-n">{failed.print} failed</span>}</button>
        </div>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>Failed items retry automatically, up to five times.</span>
      </div>
      {kind === 'sms' && stats && !stats.smsLive && (
        <div className="notice">
          <Info />
          <span className="grow">
            {stats.telegramOn
              ? <><strong>Hosts who connected Telegram get requests there.</strong> Text messages are not switched on yet, so other hosts receive nothing. To approve for them, press “Open approval link” below and share it, or connect them to Telegram on the Hosts page.</>
              : <><strong>Text messages are not switched on yet, so hosts receive nothing.</strong> To approve a visitor, press “Open approval link” below and share it with the host. Ask GateSmartX support to switch text messages on.</>}
          </span>
        </div>
      )}
      {kind === 'print' && stats && !stats.printerOn && (
        <div className="notice">
          <Info />
          <span className="grow"><strong>No label printer is connected to the server.</strong> Guards print passes from the guard desk through the browser, on any printer installed on that computer.</span>
        </div>
      )}
      {!rows ? <ListSkeleton /> : rows.length === 0 ? (
        <Empty icon={kind === 'sms' ? MessageSquare : Printer} title="Nothing yet">{kind === 'sms' ? 'Approval messages to hosts appear here.' : 'Sticker print jobs appear here.'}</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th><th>Visitor ID</th>
                {kind === 'sms' && <><th>Sent to</th><th>Message</th></>}
                <th className="r">Tries</th><th>Queued</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const link = o.body?.match(LINK_RE)?.[0];
                return (
                  <tr key={o.id}>
                    <td>
                      <OutboxBadge status={o.status} logged={kind === 'sms' && o.channel === 'sms' && stats && !stats.smsLive} />
                      {o.lastError && o.status !== 'sent' && <div className="meta-line err">{o.lastError}</div>}
                    </td>
                    <td className="mono">{o.ref || '—'}</td>
                    {kind === 'sms' && (
                      <>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>{o.channel === 'telegram' ? <span className="badge badge-live"><Send size={11} />Telegram</span> : fmtMobile(o.to)}</td>
                        <td className="msg-cell">
                          <span>{o.body?.replace(LINK_RE, '').replace(/\s+/g, ' ').trim()}</span>
                          {link && <a className="btn btn-sm" href={link} target="_blank" rel="noopener noreferrer"><ExternalLink />Open approval link</a>}
                        </td>
                      </>
                    )}
                    <td className="r num">{o.attempts}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(o.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ================================================================= Audit log
const AUDIT_FILTERS = [
  { id: '', label: 'All' }, { id: 'visit.', label: 'Visits' }, { id: 'material.', label: 'Material' }, { id: 'parcel.', label: 'Couriers' }, { id: 'group.', label: 'Events' },
  { id: 'emergency.', label: 'Emergency' }, { id: 'force', label: 'Force checkouts' }, { id: 'id_image', label: 'Aadhaar views' }, { id: 'export|exported|report.', label: 'Downloads and reports' },
  { id: 'auth', label: 'Sign-ins' }, { id: 'user.', label: 'Staff' }, { id: 'host.', label: 'Hosts' }, { id: 'block', label: 'Blocked' }, { id: 'invite.', label: 'Expected' }, { id: 'settings|license|gate.', label: 'Settings' },
];
const ROLE_LABEL = { superadmin: 'Super Admin', admin: 'Administrator', guard: 'Guard' };
const DETAIL_KEYS = { parcelsIn: 'parcels in', parcelsOut: 'parcels out', expectedCancelled: 'expected visitors cancelled', takenBack: 'part taken back', receivedBy: 'received by', aadhaarImages: 'Aadhaar images', dailyNumber: 'pass', rows: 'visits', from: 'from', to: 'to', created: 'added', updated: 'updated', errors: 'not added', unit: 'flat', host: 'host', reason: 'reason', error: 'error', active: 'receives visitors', count: 'how many' };
// Details in plain words: yes / no, and lists or objects as "a, b" rather than code.
const plainValue = (v) => (v === true ? 'yes' : v === false ? 'no' : Array.isArray(v) ? v.join(', ')
  : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k} ${plainValue(x)}`).join(', ') : String(v));
function AuditPage({ tick, openVisit }) {
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  // Live updates refresh the newest page; older pages the admin opened stay as they are.
  useEffect(() => {
    let live = true;
    api(`/api/admin/audit?${qs({ action: filter, q: term })}`)
      .then((d) => { if (live) { setRows(d.rows); setMore(d.more); } })
      .catch(() => live && setRows([]));
    return () => { live = false; };
  }, [filter, term, tick]);
  const older = async () => {
    setLoadingMore(true);
    try {
      const d = await api(`/api/admin/audit?${qs({ action: filter, q: term, before: rows.at(-1)?._id })}`);
      setRows((rs) => [...rs, ...d.rows]);
      setMore(d.more);
    } catch { /* the button stays for another try */ } finally { setLoadingMore(false); }
  };

  const detail = (r) => {
    const d = { ...(r.details || {}) };
    delete d.ref;
    return Object.entries(d).filter(([, v]) => v !== undefined && v !== '' && v !== null)
      .map(([k, v]) => `${DETAIL_KEYS[k] || k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${plainValue(v)}`).join(' · ');
  };

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="seg seg-wrap" role="group" aria-label="Filter">
          {AUDIT_FILTERS.map((f) => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <div className="input-group field wide">
          <Search />
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Person, visitor ID, mobile, entry or parcel no., reason" aria-label="Search the audit log" />
        </div>
      </div>
      {!rows ? <ListSkeleton /> : rows.length === 0 ? <Empty icon={ScrollText} title="No entries">{term ? 'Nothing matches that search.' : 'Nothing recorded for this filter yet.'}</Empty> : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Visitor</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const tone = ACTIONS[r.action]?.[1];
                const isVisit = r.entity === 'Visit' && r.entityId;
                return (
                  <tr key={r._id} className={isVisit ? 'clickable' : ''} onClick={isVisit ? () => openVisit(String(r.entityId)) : undefined}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.at)}</td>
                    <td>{r.actorRole === 'host' ? 'Host (by SMS link)' : r.actor || 'System'}{r.actorRole && r.actorRole !== 'host' && <div className="meta-line">{ROLE_LABEL[r.actorRole] || r.actorRole}</div>}</td>
                    <td><span className={tone ? `tone-${tone}` : ''}>{actionLabel(r.action)}</span></td>
                    <td className="mono">{r.details?.ref || (isVisit ? '…' + String(r.entityId).slice(-6) : '—')}</td>
                    <td className="meta-line wrap">{detail(r) || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {more && (
            <div className="pager">
              <span className="num faint">{rows.length} shown</span>
              <button type="button" className="btn btn-sm" onClick={older} disabled={loadingMore}>{loadingMore ? <Spinner /> : <ChevronDown />}Show older</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ================================================================= Hosts
// Sent from the search box: find someone, or start adding or importing.
function useIntent(intent, handlers) {
  const done = useRef(null);
  useEffect(() => {
    if (!intent || done.current === intent.n) return;
    done.current = intent.n;
    handlers[intent.action]?.(intent.value);
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps
}

function HostsPage({ toast, stats, intent }) {
  const [rows, setRows] = useState(null);
  const [connecting, setConnecting] = useState(null); // host being connected to Telegram
  const [editingHost, setEditingHost] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => api('/api/admin/hosts').then((d) => setRows(d.rows)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  useIntent(intent, { find: setQ, add: () => setAdding(true), import: () => setImporting(true) });

  const toggle = async (h) => {
    setRows((rs) => rs.map((r) => (r.id === h.id ? { ...r, active: !h.active } : r))); // optimistic
    try { await api(`/api/admin/hosts/${h.id}`, { method: 'PATCH', body: { active: !h.active } }); toast(`${h.fullName} ${h.active ? 'can no longer' : 'can now'} receive visitors.`); } catch (e) { toast(e.message, 'bad'); load(); }
  };

  const term = q.trim().toLowerCase();
  const shown = (rows || []).filter((h) => !term || `${h.fullName} ${h.unit} ${h.mobile} ${h.email || ''}`.toLowerCase().includes(term));
  const active = (rows || []).filter((h) => h.active).length;

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, flat, mobile" aria-label="Search hosts" /></div>
        <span className="muted num" style={{ alignSelf: 'center' }}>{rows ? `${active} active of ${rows.length}` : ''}</span>
        <span className="spacer-x" />
        <button className="btn btn-sm" onClick={() => setImporting(true)}><Upload />Import from Excel</button>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus />Add host</button>
      </div>
      {!rows ? <ListSkeleton /> : shown.length === 0 ? (
        <Empty icon={Building2} title={rows.length ? 'No match' : 'No hosts yet'} action={rows.length ? null : <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus />Add the first host</button>}>
          {rows.length ? 'Try a flat number.' : 'Hosts receive the SMS asking them to approve a visitor.'}
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Host</th><th>Flat / dept</th><th>Mobile</th>{stats?.telegramOn && <th>Telegram</th>}<th className="r">Receives visitors</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {shown.map((h) => (
                <tr key={h.id} className={h.active ? '' : 'row-off'}>
                  <td><div className="person"><Avatar name={h.fullName} size={34} /><div><div className="name">{h.fullName}</div>{h.email && <div className="meta">{h.email}</div>}</div></div></td>
                  <td>{h.unit}</td>
                  <td className="num">{fmtMobile(h.mobile)}</td>
                  {stats?.telegramOn && (
                    <td>
                      {h.telegram
                        ? <span className="badge badge-live">Connected</span>
                        : <button className="btn btn-sm" onClick={() => setConnecting(h)}><Send />Connect</button>}
                    </td>
                  )}
                  <td className="r"><button className="switch" role="switch" aria-checked={h.active} aria-label={`${h.fullName} receives visitors`} onClick={() => toggle(h)} /></td>
                  <td className="r"><button className="btn btn-sm" onClick={() => setEditingHost(h)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConnectTelegramDialog host={connecting} live={rows?.find((r) => r.id === connecting?.id)} onClose={() => setConnecting(null)} onRefresh={load} />
      <AddHostDialog open={adding} onClose={() => setAdding(false)} onDone={load} />
      <AddHostDialog open={Boolean(editingHost)} host={editingHost} onClose={() => setEditingHost(null)} onDone={load} />
      <BulkImport
        open={importing} onClose={() => setImporting(false)} onDone={load}
        title="Import hosts" noun={['host', 'hosts']} endpoint="/api/admin/hosts/import"
        intro="A sheet with the name, flat or department, mobile and (optional) email of each host. Someone already listed is recognised by their mobile and updated, never added twice."
        placeholder={'Asha Verma\tA-101\t98765 43210\tasha@example.com\nRahul Mehta\tB-302\t98200 11223'}
        template={'Name,Flat or department,Mobile,Email\r\nAsha Verma,A-101,98765 43210,asha@example.com\r\n'} templateName="hosts"
        columns={[
          { label: 'Name', cell: (r) => r.fullName },
          { label: 'Flat / dept', cell: (r) => r.unit },
          { label: 'Mobile', cell: (r) => <span className="num">{fmtMobile(r.mobile)}</span> },
          { label: 'Email', cell: (r) => r.email },
        ]}
        status={(r) => (r.action === 'add' ? ['New', 'badge-live'] : r.action === 'update' ? ['Will be updated', 'badge-warn'] : ['Already up to date', ''])}
        done={(r) => `${r.created} ${r.created === 1 ? 'host' : 'hosts'} added${r.updated ? `, ${r.updated} updated` : ''}${r.same ? `, ${r.same} already up to date` : ''}.`}
      />
    </section>
  );
}

function AddHostDialog({ open, host, onClose, onDone }) {
  const toast = useToast();
  const blank = { fullName: '', unit: '', mobile: '', email: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const editing = Boolean(host);
  const [sure, setSure] = useState(false);
  const disconnect = async () => {
    try { await api(`/api/admin/hosts/${host.id}`, { method: 'PATCH', body: { disconnectTelegram: true } }); toast(`${host.fullName} disconnected from Telegram.`); onDone(); onClose(); } catch (x) { setErr(x.message); }
  };
  const remove = async () => {
    if (!sure) { setSure(true); return; }
    setBusy(true); setErr('');
    try {
      const r = await api(`/api/admin/hosts/${host.id}`, { method: 'DELETE' });
      toast(`${host.fullName} deleted.${r.expectedCancelled ? ` ${r.expectedCancelled} expected ${r.expectedCancelled === 1 ? 'visitor' : 'visitors'} cancelled.` : ''}`);
      onDone();
      onClose();
    } catch (x) { setErr(x.message); setSure(false); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!open) return;
    setErr(''); setSure(false);
    setF(host ? { fullName: host.fullName, unit: host.unit, mobile: host.mobile.replace(/^\+91/, ''), email: host.email || '' } : blank);
  }, [open, host?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      if (editing) await api(`/api/admin/hosts/${host.id}`, { method: 'PATCH', body: f });
      else await api('/api/admin/hosts', { method: 'POST', body: f });
      toast(editing ? `${f.fullName} updated.` : `${f.fullName} added.`);
      onDone();
      onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} label={editing ? 'Edit host' : 'Add host'}>
      <form onSubmit={submit}>
        <div className="dialog-head"><h2>{editing ? 'Edit host' : 'Add host'}</h2><p>{editing ? 'Changes apply to the next approval SMS.' : 'They will get an SMS each time a visitor asks for them.'}</p></div>
        <div className="dialog-body">
          <label className="field"><span>Full name</span><input className="input" required minLength={2} value={f.fullName} onChange={set('fullName')} autoFocus /></label>
          <div className="grid-2">
            <label className="field"><span>Flat or department</span><input className="input" required value={f.unit} onChange={set('unit')} placeholder="A-101" /></label>
            <label className="field"><span>Mobile</span><input className="input num" required inputMode="tel" value={f.mobile} onChange={set('mobile')} placeholder="98765 43210" /></label>
          </div>
          <label className="field"><span>Email <span className="faint">· optional, also gets approval requests</span></span><input className="input" type="email" value={f.email} onChange={set('email')} /></label>
          {editing && host.telegram && (
            <div className="field"><span>Telegram</span>
              <div className="notice-inline"><span className="badge badge-live">Connected</span><button type="button" className="btn btn-sm btn-danger-outline" onClick={disconnect}>Disconnect</button></div>
              <span className="hint">Approval requests go to Telegram. After disconnecting they fall back to SMS.</span>
            </div>
          )}
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
          {editing && sure && <div className="alert alert-warn" role="alert"><AlertTriangle /><span className="grow">Press again to delete {host.fullName}. Past visits keep their name; expected visitors for them are cancelled. This cannot be undone.</span></div>}
        </div>
        <div className="dialog-foot">
          {editing && (
            <button type="button" className={`btn ${sure ? 'btn-danger' : 'btn-danger-outline'}`} style={{ marginRight: 'auto' }} disabled={busy} onClick={remove} onBlur={() => setSure(false)}>
              <Trash2 />{sure ? `Yes, delete ${host.fullName.split(' ')[0]}` : 'Delete host'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : editing ? <CheckCircle2 /> : <UserPlus />}{editing ? 'Save changes' : 'Add host'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ================================================================= Download data
const EXPORT_RANGES = [
  { id: 'today', label: 'Today', from: () => daysAgo(0), to: () => daysAgo(0) },
  { id: 'yesterday', label: 'Yesterday', from: () => daysAgo(1), to: () => daysAgo(1) },
  { id: '7d', label: 'Last 7 days', from: () => daysAgo(6), to: () => daysAgo(0) },
  { id: 'month', label: 'This month', from: monthStart, to: () => daysAgo(0) },
  { id: 'all', label: 'Everything', from: () => '', to: () => '' },
  { id: 'custom', label: 'Pick dates' },
];
function ExportDialog({ opts, onClose }) {
  const open = Boolean(opts);
  const filters = useMemo(() => {
    const { from, to, ...rest } = opts || {}; // eslint-disable-line no-unused-vars
    return Object.fromEntries(Object.entries(rest).filter(([, v]) => v));
  }, [opts]);
  const [range, setRange] = useState('today');
  const [custom, setCustom] = useState({ from: daysAgo(6), to: daysAgo(0) });
  const [format, setFormat] = useState('zip');
  const [withAadhaar, setWithAadhaar] = useState(true);
  const [count, setCount] = useState(null);

  useEffect(() => {
    if (!open) return;
    if (opts.from || opts.to) { setRange('custom'); setCustom({ from: opts.from || '', to: opts.to || '' }); } else setRange('today');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const r = EXPORT_RANGES.find((x) => x.id === range);
  const dates = range === 'custom' ? custom : { from: r.from(), to: r.to() };
  const query = qs({ ...filters, ...dates });

  useEffect(() => {
    if (!open) return undefined;
    setCount(null);
    let live = true;
    const t = setTimeout(() => api(`/api/admin/visits?${query}&limit=1`).then((x) => live && setCount(x.total)).catch(() => {}), 150);
    return () => { live = false; clearTimeout(t); };
  }, [open, query]);

  const href = `/api/admin/visits.${format}?${query}${format === 'zip' && withAadhaar ? '&aadhaar=1' : ''}`;
  const filterNote = Object.entries(filters).map(([k, v]) => `${k === 'name' ? 'visitor' : k}: ${k === 'status' ? STATUS[v]?.[0] || v : v}`).join(', ');

  return (
    <Modal open={open} onClose={onClose} label="Download data">
      <div className="dialog-head">
        <h2>Download visitor data</h2>
        <p>Saved straight to this computer's Downloads folder.</p>
      </div>
      <div className="dialog-body">
        <div className="field">
          <span>Which visits</span>
          <div className="chips">
            {EXPORT_RANGES.map((x) => <button type="button" key={x.id} className="chip" aria-pressed={range === x.id} onClick={() => setRange(x.id)}>{x.label}</button>)}
          </div>
        </div>
        {range === 'custom' && (
          <div className="grid-2">
            <label className="field"><span>From</span><input className="input" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="field"><span>To</span><input className="input" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          </div>
        )}
        {filterNote && <p className="faint" style={{ fontSize: 13 }}>Only visits matching {filterNote}.</p>}
        <div className="field">
          <span>Format</span>
          <div className="export-opts" role="radiogroup" aria-label="Format">
            <button type="button" role="radio" aria-checked={format === 'zip'} className="export-opt" onClick={() => setFormat('zip')}>
              <FolderArchive /><span><strong>Full record (.zip)</strong><small>Excel sheet, a printable report, and a folder per visitor with their photo</small></span>
            </button>
            <button type="button" role="radio" aria-checked={format === 'xlsx'} className="export-opt" onClick={() => setFormat('xlsx')}>
              <FileSpreadsheet /><span><strong>Excel sheet only (.xlsx)</strong><small>All details in clean columns, ready to sort and filter</small></span>
            </button>
          </div>
        </div>
        {format === 'zip' && (
          <label className={`checkbox attest-lite ${withAadhaar ? 'on' : ''}`}>
            <input type="checkbox" checked={withAadhaar} onChange={(e) => setWithAadhaar(e.target.checked)} />
            <span><strong>Include masked Aadhaar images</strong><br /><span className="faint">First 8 digits are blacked out on the guard’s device. Images deleted under the retention rule are not available.</span></span>
          </label>
        )}
        <p className="faint" style={{ fontSize: 12.5 }}>Every download is recorded in the audit log{format === 'zip' && withAadhaar ? ', including that Aadhaar images were taken' : ''}.</p>
      </div>
      <div className="dialog-foot">
        <span className="muted num" style={{ marginRight: 'auto', alignSelf: 'center' }}>{count === null ? <Spinner /> : `${count} ${count === 1 ? 'visit' : 'visits'}`}</span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        {count === 0
          ? <button className="btn btn-primary" disabled><Download />Download</button>
          : <a className="btn btn-primary" href={href} download onClick={() => setTimeout(onClose, 300)}><Download />Download</a>}
      </div>
    </Modal>
  );
}

// ================================================================= Staff accounts
const ROLE_INFO = {
  guard: ['Guard', 'Checks visitors in and out at the gate'],
  admin: ['Admin', 'Everything a guard can do, plus this console'],
  superadmin: ['Super Admin', 'Everything an admin can do, plus the full Aadhaar'],
};
const ago = (iso) => {
  if (!iso) return 'Never';
  const m = minutesSince(iso);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ago`;
  return fmtDate(iso);
};
const suggestUsername = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.').slice(0, 30);

// Gates for pickers. Closed gates stay listed so a guard still assigned to one shows it.
function useGates() {
  const [gates, setGates] = useState([]);
  useEffect(() => { api('/api/admin/gates').then((r) => setGates(r.rows)).catch(() => {}); }, []);
  return gates;
}

function GatePicker({ value, onChange, gates }) {
  const open = gates.filter((g) => g.active || g.id === value);
  return (
    <label className="field"><span>Gate</span>
      <select className="select" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{open.length > 1 ? 'Not fixed (uses the first gate)' : 'Main gate'}</option>
        {open.map((g) => <option key={g.id} value={g.id}>{g.name}{g.active ? '' : ' (closed)'}</option>)}
      </select>
      <span className="hint">Where they check visitors in and out. Every entry and exit records this gate.</span>
    </label>
  );
}

function StaffPage({ toast, user, intent }) {
  const gates = useGates();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  useIntent(intent, { find: setQ, add: () => setAdding(true) });
  const [editing, setEditing] = useState(null);
  const [canSuper, setCanSuper] = useState(false);
  const load = useCallback(() => api('/api/admin/users').then((d) => { setRows(d.rows); setCanSuper(Boolean(d.canAppointSuper)); }).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (u) => {
    setRows((rs) => rs.map((r) => (r.id === u.id ? { ...r, active: !u.active } : r)));
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
      toast(u.active ? `${u.fullName} can no longer sign in, and was signed out everywhere.` : `${u.fullName} can sign in again.`);
    } catch (e) { toast(e.message, 'bad'); load(); }
  };

  const term = q.trim().toLowerCase();
  const shown = (rows || []).filter((u) => !term || `${u.fullName} ${u.username} ${u.role}`.toLowerCase().includes(term));
  const counts = (rows || []).reduce((c, u) => (u.active ? { ...c, [u.role]: (c[u.role] || 0) + 1 } : c), {});

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or username" aria-label="Search staff" /></div>
        <span className="muted num" style={{ alignSelf: 'center' }}>{rows ? `${counts.guard || 0} ${counts.guard === 1 ? 'guard' : 'guards'} · ${(counts.admin || 0) + (counts.superadmin || 0)} ${(counts.admin || 0) + (counts.superadmin || 0) === 1 ? 'admin' : 'admins'}` : ''}</span>
        <span className="spacer-x" />
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><UserPlus />Add staff</button>
      </div>
      {!rows ? <ListSkeleton /> : shown.length === 0 ? (
        <Empty icon={UserCog} title="No match">Try a different name.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th><th>Gate</th><th>Last sign-in</th><th className="r">Can sign in</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {shown.map((u) => {
                const self = u.id === user.id;
                return (
                  <tr key={u.id} className={u.active ? '' : 'row-off'}>
                    <td>
                      <div className="person">
                        <Avatar name={u.fullName} size={34} />
                        <div>
                          <div className="name">{u.fullName}{self && <span className="badge plain you">You</span>}</div>
                          <div className="meta mono">{u.username}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className={`badge plain ${u.role === 'superadmin' ? 'role-super' : u.role === 'admin' ? 'role-admin' : ''}`}>{ROLE_INFO[u.role]?.[0] || u.role}</span></td>
                    <td>{u.gate ? <>{u.gate.name}{!u.gate.active && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Closed</span>}</> : <span className="faint">{u.role === 'guard' ? 'Not fixed' : '—'}</span>}</td>
                    <td className="num">{ago(u.lastLoginAt)}</td>
                    <td className="r">
                      <button className="switch" role="switch" aria-checked={u.active} disabled={self || (u.role === 'superadmin' && user.role !== 'superadmin')}
                        aria-label={`${u.fullName} can sign in`} title={self ? 'You cannot switch off your own account' : undefined} onClick={() => toggle(u)} />
                    </td>
                    <td className="r"><button className="btn btn-sm" disabled={u.role === 'superadmin' && user.role !== 'superadmin'} title={u.role === 'superadmin' && user.role !== 'superadmin' ? 'Only a Super Admin can change a Super Admin' : undefined} onClick={() => setEditing(u)}>Manage</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <AddStaffDialog open={adding} gates={gates} canSuper={canSuper} onClose={() => setAdding(false)} onDone={load} />
      <EditStaffDialog member={editing} gates={gates} canSuper={canSuper} self={editing?.id === user.id} onClose={() => setEditing(null)} onDone={load} />
    </section>
  );
}

function RolePicker({ value, onChange, disabled, canSuper }) {
  return (
    <div className="export-opts" role="radiogroup" aria-label="Role">
      {Object.entries(ROLE_INFO).filter(([id]) => id !== 'superadmin' || canSuper || value === 'superadmin').map(([id, [label, desc]]) => (
        <button type="button" key={id} role="radio" aria-checked={value === id} className="export-opt" disabled={disabled} onClick={() => onChange(id)}>
          {id === 'guard' ? <Users /> : <ShieldCheck />}<span><strong>{label}</strong><small>{desc}</small></span>
        </button>
      ))}
    </div>
  );
}

function AddStaffDialog({ open, gates, canSuper, onClose, onDone }) {
  const blank = { fullName: '', username: '', role: 'guard', password: '', gateId: '' };
  const [f, setF] = useState(blank);
  const [ownPassword, setOwnPassword] = useState(false);
  const [userEdited, setUserEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState(null);
  useEffect(() => { if (open) { setF(blank); setOwnPassword(false); setUserEdited(false); setErr(''); setCreated(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setName = (fullName) => setF((x) => ({ ...x, fullName, username: userEdited ? x.username : suggestUsername(fullName) }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = await api('/api/admin/users', { method: 'POST', body: { fullName: f.fullName, username: f.username, role: f.role, gateId: f.gateId || null, ...(ownPassword ? { password: f.password } : {}) } });
      onDone();
      setCreated({ ...res, password: res.password || null });
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  if (created) {
    return (
      <Modal open={open} onClose={onClose} label="Staff account ready">
        <div className="dialog-head">
          <h2>{created.fullName} can sign in</h2>
          <p>{created.password ? 'Give them these details in person. The password is shown only once.' : 'They can sign in with the password you set.'}</p>
        </div>
        <div className="dialog-body">
          <SecretBox label="Username" value={created.username} />
          {created.password && <SecretBox label="Password" value={created.password} />}
          <p className="faint" style={{ fontSize: 13 }}>They can change it any time from their account menu.</p>
        </div>
        <div className="dialog-foot"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} label="Add staff">
      <form onSubmit={submit}>
        <div className="dialog-head"><h2>Add a staff account</h2><p>For a guard at the gate, or another admin.</p></div>
        <div className="dialog-body">
          <label className="field"><span>Full name</span><input className="input" required minLength={2} value={f.fullName} onChange={(e) => setName(e.target.value)} autoFocus /></label>
          <label className="field"><span>Username</span>
            <input className="input mono" required value={f.username} onChange={(e) => { setUserEdited(true); setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, '') }); }} autoCapitalize="none" spellCheck="false" />
            <span className="hint">What they type to sign in. Lowercase letters, numbers, dot or dash.</span>
          </label>
          <div className="field"><span>Role</span><RolePicker value={f.role} canSuper={canSuper} onChange={(role) => setF({ ...f, role })} /></div>
          {f.role === 'guard' && <GatePicker value={f.gateId} gates={gates} onChange={(gateId) => setF({ ...f, gateId })} />}
          <label className="checkbox" style={{ fontSize: 13.5 }}>
            <input type="checkbox" checked={ownPassword} onChange={(e) => setOwnPassword(e.target.checked)} />
            <span>I will set the password myself <span className="faint">(otherwise a strong one is made for you)</span></span>
          </label>
          {ownPassword && (
            <label className="field"><span>Password</span>
              <input className="input" type="text" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
              <span className="hint">At least 10 characters.</span>
            </label>
          )}
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || f.fullName.trim().length < 2 || f.username.length < 3 || (ownPassword && f.password.length < 10)}>{busy ? <Spinner /> : <UserPlus />}Add account</button>
        </div>
      </form>
    </Modal>
  );
}

function EditStaffDialog({ member, gates, canSuper, self, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', role: 'guard', gateId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [newPassword, setNewPassword] = useState(null);
  useEffect(() => {
    if (member) { setF({ fullName: member.fullName, role: member.role, gateId: member.gate?.id || '' }); setErr(''); setConfirmReset(false); setNewPassword(null); }
  }, [member?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = member && (f.fullName.trim() !== member.fullName || f.role !== member.role || f.gateId !== (member.gate?.id || ''));
  const save = async (e) => {
    e.preventDefault();
    if (!changed) return onClose();
    setBusy(true); setErr('');
    try {
      await api(`/api/admin/users/${member.id}`, { method: 'PATCH', body: { fullName: f.fullName, role: f.role, gateId: f.gateId || null } });
      toast(`${f.fullName} updated.`);
      onDone();
      onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api(`/api/admin/users/${member.id}`, { method: 'PATCH', body: { resetPassword: true } });
      setNewPassword(res.password);
      setConfirmReset(false);
      onDone();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const first = member?.fullName.split(' ')[0];

  return (
    <Modal open={Boolean(member)} onClose={onClose} label="Manage staff account">
      {member && (
        <form onSubmit={save}>
          <div className="dialog-head">
            <h2>{member.fullName}</h2>
            <p><span className="mono">{member.username}</span> · last signed in {ago(member.lastLoginAt).toLowerCase()}</p>
          </div>
          <div className="dialog-body">
            <label className="field"><span>Full name</span><input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
            <div className="field">
              <span>Role {self && <span className="faint">· you cannot change your own role</span>}</span>
              <RolePicker value={f.role} canSuper={canSuper} onChange={(role) => setF({ ...f, role })} disabled={self} />
            </div>
            {f.role === 'guard' && <GatePicker value={f.gateId} gates={gates} onChange={(gateId) => setF({ ...f, gateId })} />}
            <div className="field">
              <span>Password</span>
              {newPassword ? (
                <>
                  <SecretBox label="New password" value={newPassword} />
                  <span className="hint">Give this to {first} in person. It is shown only once, and they have been signed out everywhere.</span>
                </>
              ) : confirmReset ? (
                <div className="alert alert-warn">
                  <AlertTriangle />
                  <span className="grow">This makes a new password and signs {first} out on every device.</span>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirmReset(false)}>Keep</button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={reset} disabled={busy}>Reset</button>
                </div>
              ) : self ? (
                <span className="hint">To change your own password, use the key button next to your name in the sidebar.</span>
              ) : (
                <div><button type="button" className="btn btn-sm" onClick={() => setConfirmReset(true)}><KeyRound />Reset password</button></div>
              )}
            </div>
            {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
            <button className="btn btn-primary" disabled={busy || !changed || f.fullName.trim().length < 2}>{busy && <Spinner />}Save changes</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ================================================================= Connect a host to Telegram
// The host scans the QR (or opens the link) once, taps Start in Telegram, and from then on
// approval requests arrive there with Let them in / Decline buttons.
function ConnectTelegramDialog({ host, live, onClose, onRefresh }) {
  const [link, setLink] = useState(null);
  const [qr, setQr] = useState('');
  const [err, setErr] = useState('');
  const connected = Boolean(live?.telegram);

  useEffect(() => {
    setLink(null); setQr(''); setErr('');
    if (!host) return undefined;
    let alive = true;
    api(`/api/admin/hosts/${host.id}/telegram-link`, { method: 'POST' })
      .then(async (r) => { if (alive) { setLink(r); setQr(await QRCode.toString(r.url, { type: 'svg', margin: 1, width: 220, color: { dark: '#0b0d10', light: '#ffffff' } })); } })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [host?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch for the moment the host taps Start.
  useEffect(() => {
    if (!host || connected) return undefined;
    const t = setInterval(onRefresh, 2500);
    return () => clearInterval(t);
  }, [host?.id, connected, onRefresh]);

  const first = host?.fullName.split(' ')[0];
  return (
    <Modal open={Boolean(host)} onClose={onClose} label="Connect Telegram">
      {host && (
        <>
          <div className="dialog-head">
            <h2>{connected ? `${first} is connected` : `Connect ${host.fullName} to Telegram`}</h2>
            <p>{connected ? 'Approval requests for this host now arrive in Telegram.' : 'Ask them to scan this with their phone camera, then tap Start in Telegram.'}</p>
          </div>
          <div className="dialog-body">
            {connected ? (
              <div className="tg-done"><CheckCircle2 /><span>Connected. Next visitor for {first} goes to their Telegram.</span></div>
            ) : err ? (
              <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>
            ) : !link ? (
              <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}><Spinner size={22} /></div>
            ) : (
              <>
                <div className="tg-qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR code to connect Telegram" role="img" />
                <p className="faint" style={{ fontSize: 13, textAlign: 'center' }}><Spinner size={12} /> Waiting for {first} to tap Start…</p>
                <SecretBox label="Link" value={link.url} compact />
                <p className="faint" style={{ fontSize: 12.5 }}>Works once and expires in 24 hours. You can send the link on WhatsApp instead of showing the QR.</p>
              </>
            )}
          </div>
          <div className="dialog-foot">
            {!connected && link && <a className="btn" href={link.url} target="_blank" rel="noopener noreferrer"><ExternalLink />Open in Telegram</a>}
            <button className="btn btn-primary" onClick={onClose}>{connected ? 'Done' : 'Close'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// How a decision arrived, shown in the visit timeline.
const VIA = { telegram: 'via Telegram', expected: 'expected visitor, let in on arrival' };

// ================================================================= Expected visitors
const dayLabel = (day, today) => {
  if (day === today) return 'Today';
  const t = new Date(`${today}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  if (day === t.toISOString().slice(0, 10)) return 'Tomorrow';
  return fmtDate(`${day}T12:00:00+05:30`);
};

function ExpectedPage({ toast, tick, openVisit, refresh, intent }) {
  const [data, setData] = useState(null);
  const [view, setView] = useState('upcoming');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [batch, setBatch] = useState({ day: daysAgo(0), host: null }); // the day and host for an imported list
  const [picked, setPicked] = useState(() => new Set());
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('/api/admin/invites').then(setData).catch(() => setData({ today: daysAgo(0), rows: [] })), []);
  useEffect(() => { load(); }, [load, tick]);
  useIntent(intent, { add: () => setAdding(true), import: () => setImporting(true) });
  useEffect(() => { if (importing) setBatch({ day: daysAgo(0), host: null }); }, [importing]);

  const cancel = async (r) => {
    try { await api(`/api/admin/invites/${r.id}`, { method: 'PATCH', body: { status: 'cancelled' } }); toast(`${r.firstName} ${r.lastName} is no longer expected.`); load(); refresh(); } catch (e) { toast(e.message, 'bad'); }
  };
  const cancelPicked = async () => {
    setBusy(true);
    try {
      const r = await api('/api/admin/invites/cancel', { method: 'POST', body: { ids: [...picked] } });
      toast(`${r.cancelled} ${r.cancelled === 1 ? 'visitor is' : 'visitors are'} no longer expected. If they come, the guard asks their host as usual.`);
      setPicked(new Set()); setConfirmCancel(false); load(); refresh();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };

  const today = data?.today;
  const term = q.trim().toLowerCase();
  const rows = (data?.rows || [])
    .filter((r) => (view === 'today' ? r.day === today : r.status !== 'cancelled' || r.day === today))
    .filter((r) => !term || `${r.firstName} ${r.lastName} ${r.mobile} ${r.company} ${r.host?.name} ${r.host?.unit}`.toLowerCase().includes(term));
  const todayCount = (data?.rows || []).filter((r) => r.day === today && r.status === 'expected').length;
  const open = rows.filter((r) => r.status === 'expected');
  const allPicked = open.length > 0 && open.every((r) => picked.has(r.id));
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setPicked((s) => { const n = new Set(s); open.forEach((r) => (allPicked ? n.delete(r.id) : n.add(r.id))); return n; });
  useEffect(() => { setConfirmCancel(false); }, [picked]);

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Which days">
          <button aria-pressed={view === 'today'} onClick={() => setView('today')}>Today{todayCount > 0 && <span className="n">{todayCount}</span>}</button>
          <button aria-pressed={view === 'upcoming'} onClick={() => setView('upcoming')}>Today and later</button>
        </div>
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile, host" aria-label="Search expected visitors" /></div>
        <span className="spacer-x" />
        <button className="btn btn-sm" onClick={() => setImporting(true)}><Upload />Import a list</button>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus />Add one visitor</button>
      </div>
      <div className="notice">
        <Info />
        <span className="grow">People added here <strong>do not wait for the host</strong>. At the gate the guard types their mobile number, the form fills in, and they get their pass at once. Their photo and ID are still taken.</span>
      </div>
      {!data ? <ListSkeleton /> : rows.length === 0 ? (
        <Empty icon={CalendarCheck} title={term ? 'No match' : 'Nobody expected yet'} action={term ? null : (
          <div className="empty-actions">
            <button className="btn btn-sm" onClick={() => setImporting(true)}><Upload />Import a list</button>
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Plus />Add one visitor</button>
          </div>
        )}>
          {term ? 'Try another name or number.' : 'Add a guest, an interview candidate or a contractor you know is coming. For many people at once, import them from an Excel sheet.'}
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr>
              <th className="pick-col">{open.length > 0 && <input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Select everyone still expected" />}</th>
              <th>Day</th><th>Visitor</th><th>Meeting</th><th>Note for the guard</th><th>Status</th><th className="r"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`${r.status === 'cancelled' ? 'row-off' : ''}${picked.has(r.id) ? ' row-picked' : ''}`}>
                  <td className="pick-col">{r.status === 'expected' && <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.firstName} ${r.lastName}`} />}</td>
                  <td className={r.day === today ? 'day-today' : ''}>{dayLabel(r.day, today)}</td>
                  <td>
                    <div className="name">{r.firstName} {r.lastName}</div>
                    <div className="meta-line">{fmtMobile(r.mobile)}{r.company ? ` · ${r.company}` : ''}{r.purpose ? ` · ${r.purpose}` : ''}</div>
                  </td>
                  <td>{r.host?.name}<div className="meta-line">{r.host?.unit}</div></td>
                  <td className="meta-line wrap">{r.note || '—'}</td>
                  <td>
                    {r.status === 'arrived' ? <span className="badge badge-live">Arrived</span>
                      : r.status === 'cancelled' ? <span className="badge">Cancelled</span>
                        : <span className="badge badge-warn">Expected</span>}
                  </td>
                  <td className="r">
                    {r.status === 'expected' && <button className="btn btn-sm btn-ghost" onClick={() => cancel(r)}><X />Cancel</button>}
                    {r.status === 'arrived' && r.visitId && <button className="btn btn-sm" onClick={() => openVisit(r.visitId)}>View visit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {picked.size > 0 && (
        <div className="pick-bar" role="region" aria-label="Selected visitors">
          <span><strong className="num">{picked.size}</strong> selected</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
          {confirmCancel
            ? <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={cancelPicked}>{busy ? <Spinner /> : <CheckCircle2 />}Yes, cancel {picked.size}</button>
            : <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmCancel(true)}><X />Cancel {picked.size}</button>}
        </div>
      )}
      <ExpectedDialog open={adding} onClose={() => setAdding(false)} onDone={() => { load(); refresh(); }} />
      <BulkImport
        open={importing} onClose={() => setImporting(false)} onDone={() => { load(); refresh(); }}
        title="Import expected visitors" noun={['visitor', 'visitors']} endpoint="/api/admin/invites/import"
        intro="For a group you know is coming: interview candidates, a delegation, a contractor crew. 1. Pick the day and whom they meet. 2. Upload the sheet or paste the rows. 3. Check the lines, then add them."
        body={{ day: batch.day, hostId: batch.host?.id }}
        settings={(
          <div className="import-settings">
            <label className="field"><span>Day they come</span>
              <input className="input" type="date" min={daysAgo(0)} max={daysAgo(-90)} value={batch.day} onChange={(e) => setBatch({ ...batch, day: e.target.value })} />
            </label>
            <div className="field"><span>Whom they meet</span><HostPicker value={batch.host} onChange={(host) => setBatch({ ...batch, host })} /></div>
            <span className="hint">People on different days or with different hosts? Add a <strong>Date</strong> or <strong>Host</strong> column to the sheet (the host's name or flat). The sheet's column is used for that person instead of these two boxes.</span>
          </div>
        )}
        placeholder={'Kavya Iyer\t98765 43210\tTCS\nArjun Rao\t98200 11223\tInfosys'}
        template={'Name,Mobile,Company,Purpose,Note for the guard,Date,Host\r\nKavya Iyer,98765 43210,TCS,Interview,,,\r\n'} templateName="expected visitors"
        columns={[
          { label: 'Name', cell: (r) => r.name },
          { label: 'Mobile', cell: (r) => <span className="num">{fmtMobile(r.mobile)}</span> },
          { label: 'Company', cell: (r) => r.company },
          { label: 'Day', cell: (r) => (/^\d{4}-\d{2}-\d{2}$/.test(r.day || '') && today ? dayLabel(r.day, today) : r.day) },
          { label: 'Meeting', cell: (r) => (r.host ? `${r.host.name}, ${r.host.unit}` : '') },
        ]}
        status={() => ['Ready', 'badge-live']}
        done={(r) => `${r.created} ${r.created === 1 ? 'visitor is' : 'visitors are'} now expected. The guard sees them as soon as their mobile number is typed at the gate.`}
      />
    </section>
  );
}

function ExpectedDialog({ open, onClose, onDone }) {
  const toast = useToast();
  const blank = () => ({ day: daysAgo(0), firstName: '', lastName: '', mobile: '', company: '', purpose: '', note: '' });
  const [f, setF] = useState(blank);
  const [host, setHost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setF(blank()); setHost(null); setErr(''); } }, [open]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const digits = f.mobile.replace(/\D/g, '');
  const maxDay = daysAgo(-90);

  const submit = async (e) => {
    e.preventDefault();
    if (!host) return setErr('Choose whom they are meeting');
    setBusy(true); setErr('');
    try {
      await api('/api/admin/invites', { method: 'POST', body: { ...f, mobile: digits, hostId: host.id } });
      toast(`${f.firstName} ${f.lastName} added for ${f.day === daysAgo(0) ? 'today' : fmtDate(`${f.day}T12:00:00+05:30`)}.`);
      onDone();
      onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} label="Add expected visitor">
      <form onSubmit={submit}>
        <div className="dialog-head"><h2>Add an expected visitor</h2><p>They are let in on arrival, without waiting for the host to reply.</p></div>
        <div className="dialog-body">
          <div className="grid-2">
            <label className="field"><span>Day</span><input className="input" type="date" required min={daysAgo(0)} max={maxDay} value={f.day} onChange={set('day')} /></label>
            <label className="field"><span>Mobile</span>
              <div className="input-group"><span className="prefix">+91</span><input className="input num" inputMode="numeric" required value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/[^\d ]/g, '').slice(0, 11) })} placeholder="98765 43210" /></div>
            </label>
          </div>
          <div className="grid-2">
            <label className="field"><span>First name</span><input className="input" required value={f.firstName} onChange={set('firstName')} /></label>
            <label className="field"><span>Last name</span><input className="input" required value={f.lastName} onChange={set('lastName')} /></label>
          </div>
          <div className="grid-2">
            <label className="field"><span>Company <span className="faint">· optional</span></span><input className="input" value={f.company} onChange={set('company')} /></label>
            <label className="field"><span>Purpose <span className="faint">· optional</span></span><input className="input" value={f.purpose} onChange={set('purpose')} placeholder="Meeting, delivery…" /></label>
          </div>
          <div className="field"><span>Meeting</span><HostPicker value={host} onChange={setHost} /></div>
          <label className="field"><span>Note for the guard <span className="faint">· optional</span></span><input className="input" maxLength={200} value={f.note} onChange={set('note')} placeholder="e.g. Bringing a laptop, send to 3rd floor" /></label>
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || digits.length !== 10 || !f.firstName.trim() || !f.lastName.trim() || !host}>{busy ? <Spinner /> : <CalendarCheck />}Add expected visitor</button>
        </div>
      </form>
    </Modal>
  );
}

// ================================================================= Blocked visitors
function BlockedPage({ toast, tick }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const load = useCallback(() => api('/api/admin/blocks').then((d) => setRows(d.rows)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load, tick]);

  const unblock = async (r) => {
    if (confirmId !== r.id) return setConfirmId(r.id);
    try { await api(`/api/admin/blocks/${r.id}`, { method: 'PATCH', body: { active: false } }); toast(`${r.name || fmtMobile(r.mobile)} can be checked in again.`); setConfirmId(null); load(); } catch (e) { toast(e.message, 'bad'); }
  };

  const term = q.trim().toLowerCase();
  const shown = (rows || []).filter((r) => !term || `${r.name} ${r.mobile} ${r.reason}`.toLowerCase().includes(term));
  return (
    <section className="panel">
      <div className="toolbar">
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile, reason" aria-label="Search blocked visitors" /></div>
        <span className="muted num" style={{ alignSelf: 'center' }}>{rows ? `${rows.length} blocked` : ''}</span>
        <span className="spacer-x" />
        <button className="btn btn-primary btn-sm" onClick={() => setAdding({})}><Ban />Block a visitor</button>
      </div>
      <div className="notice">
        <Info />
        <span className="grow">When a guard types a blocked number they see <strong>Do not admit</strong> with your reason, and the check-in is refused. Every attempt is recorded in the audit log.</span>
      </div>
      {!rows ? <ListSkeleton /> : shown.length === 0 ? (
        <Empty icon={ShieldCheck} title={rows.length ? 'No match' : 'Nobody is blocked'}>{rows.length ? 'Try a different name or number.' : 'Block someone from their visit details, or with the button above.'}</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Person</th><th>Reason</th><th>Blocked</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><div className="name">{r.name || 'Unknown name'}</div><div className="meta-line num">{fmtMobile(r.mobile)}</div></td>
                  <td className="meta-line wrap" style={{ color: 'var(--text)' }}>{r.reason}</td>
                  <td className="num">{fmtDate(r.createdAt)}{r.by && <div className="meta-line">by {r.by}</div>}</td>
                  <td className="r">
                    <button className={`btn btn-sm ${confirmId === r.id ? 'btn-danger' : 'btn-ghost'}`} onClick={() => unblock(r)} onBlur={() => setConfirmId((c) => (c === r.id ? null : c))}>
                      {confirmId === r.id ? 'Confirm: allow again' : 'Remove block'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <BlockDialog prefill={adding} onClose={() => setAdding(null)} onDone={load} />
    </section>
  );
}

function BlockDialog({ prefill, onClose, onDone }) {
  const toast = useToast();
  const open = Boolean(prefill);
  const [f, setF] = useState({ mobile: '', name: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) { setF({ mobile: (prefill.mobile || '').replace(/^\+91/, ''), name: prefill.name || '', reason: '' }); setErr(''); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api('/api/admin/blocks', { method: 'POST', body: f });
      toast(`${f.name || 'That number'} is blocked. Guards will see your reason.`);
      onDone();
      onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} label="Block a visitor">
      <form onSubmit={submit}>
        <div className="dialog-head"><h2>Block {prefill?.name || 'a visitor'}</h2><p>Guards will see “Do not admit” and your reason, and cannot check this number in.</p></div>
        <div className="dialog-body">
          <div className="grid-2">
            <label className="field"><span>Mobile</span>
              <div className="input-group"><span className="prefix">+91</span><input className="input num" inputMode="numeric" required value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/[^\d ]/g, '').slice(0, 11) })} /></div>
            </label>
            <label className="field"><span>Name <span className="faint">· optional</span></span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          </div>
          <label className="field"><span>Reason</span>
            <input className="input" required minLength={5} maxLength={200} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Abusive to staff on 2 Oct" autoFocus />
            <span className="hint">Shown to the guard at the gate. Keep it factual.</span>
          </label>
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || f.reason.trim().length < 5 || f.mobile.replace(/\D/g, '').length !== 10}>{busy ? <Spinner /> : <Ban />}Block</button>
        </div>
      </form>
    </Modal>
  );
}

// ================================================================= Settings
const RETENTION_LABEL = { 1: '1 day', 7: '7 days', 30: '30 days', 90: '90 days', 180: '180 days', 365: '1 year' };

// Entry points. Added, renamed and opened or closed here; each guard is assigned one under Staff.
function GatesManager() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null); // { id, name }
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('/api/admin/gates').then((r) => setRows(r.rows)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);

  const call = async (fn, msg) => {
    setBusy(true);
    try { await fn(); if (msg) toast(msg); load(); return true; } catch (e) { toast(e.message, 'bad'); return false; } finally { setBusy(false); }
  };
  const add = async () => {
    const n = name.trim();
    if (n.length < 2) return;
    if (await call(() => api('/api/admin/gates', { method: 'POST', body: { name: n } }), `${n} added. Assign guards to it under Staff.`)) setName('');
  };
  const rename = async () => {
    const n = editing.name.trim();
    if (n.length < 2) return;
    if (await call(() => api(`/api/admin/gates/${editing.id}`, { method: 'PATCH', body: { name: n } }), 'Gate renamed. Past entries keep the old name.')) setEditing(null);
  };
  const toggle = (g) => call(() => api(`/api/admin/gates/${g.id}`, { method: 'PATCH', body: { active: !g.active } }),
    g.active ? `${g.name} closed. Its guards use the first open gate until you move them.` : `${g.name} is open again.`);
  const enter = (fn) => (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } if (e.key === 'Escape') setEditing(null); };

  return (
    <div className="field">
      <span>Gates</span>
      {!rows ? <div className="skeleton" style={{ height: 44, borderRadius: 10 }} /> : (
        <ul className="gate-list">
          {rows.map((g) => (
            <li key={g.id} className={g.active ? '' : 'row-off'}>
              {editing?.id === g.id ? (
                <>
                  <input className="input" value={editing.name} maxLength={40} autoFocus aria-label="Gate name"
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })} onKeyDown={enter(rename)} />
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy || editing.name.trim().length < 2} onClick={rename}><Save />Save</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span className="gate-name"><strong>{g.name}</strong><span className="faint">{g.active ? `${g.staff} ${g.staff === 1 ? 'guard' : 'guards'}` : 'Closed'}</span></span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing({ id: g.id, name: g.name })}>Rename</button>
                  <button type="button" className="switch" role="switch" aria-checked={g.active} disabled={busy} aria-label={`${g.name} is open`} onClick={() => toggle(g)} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="gate-add">
        <input className="input" value={name} maxLength={40} placeholder="e.g. Staff Entrance" aria-label="New gate name"
          onChange={(e) => setName(e.target.value)} onKeyDown={enter(add)} />
        <button type="button" className="btn btn-sm" disabled={busy || name.trim().length < 2} onClick={add}><Plus />Add gate</button>
      </div>
      <span className="hint">Every entry and exit records the gate and the guard. A visitor can come in at one gate and leave by another.</span>
    </div>
  );
}

// The escalation contacts travel as { mobiles, emails } and are edited as one comma-separated line.
const withContacts = (d) => ({
  ...d, assemblyPoint: d.assemblyPoint || '', purposes: (d.purposes || []).join(', '), durations: (d.durations || []).join(', '),
  lanyardCards: Boolean(d.lanyardCards), notifyCheckout: d.notifyCheckout !== false, thankVisitor: d.thankVisitor !== false, escalateTo: [...(d.escalateTo?.mobiles || []), ...(d.escalateTo?.emails || [])].join(', ') });

function SettingsPage({ toast, superAdmin, go, openExport, stats }) {
  const [s, setS] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/api/admin/settings').then((raw) => {
      const d = withContacts(raw);
      setS(d);
      setF({ siteName: d.siteName, gateName: d.gateName, idRetentionDays: d.idRetentionDays, otpMode: d.otpMode, escalateTo: d.escalateTo, assemblyPoint: d.assemblyPoint || '', purposes: d.purposes, durations: d.durations, lanyardCards: d.lanyardCards, notifyCheckout: d.notifyCheckout, thankVisitor: d.thankVisitor, ...(superAdmin ? { fullIdCapture: Boolean(d.fullIdCapture) } : {}) });
    }).catch((e) => setErr(e.message));
  }, []);

  if (!f) return err ? <div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div> : <ListSkeleton />;
  const changed = Object.keys(f).filter((k) => String(f[k]) !== String(s[k]));
  const save = async (e) => {
    e.preventDefault();
    if (!changed.length) return;
    setBusy(true); setErr('');
    try {
      const d = withContacts(await api('/api/admin/settings', { method: 'PATCH', body: Object.fromEntries(changed.map((k) => [k, f[k]])) }));
      setS({ ...s, ...d });
      setF((x) => ({ ...x, escalateTo: d.escalateTo, purposes: d.purposes, durations: d.durations }));
      toast('Settings saved. Guard screens pick up the changes the next time they open or refresh.');
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const ch = s.channels || {};

  return (
    <form className="settings-grid" onSubmit={save}>
      <LicensePanel />
      <section className="panel">
        <div className="panel-head"><h2>Site</h2></div>
        <div className="panel-body">
          <label className="field"><span>Site name</span>
            <input className="input" value={f.siteName} maxLength={60} onChange={(e) => setF({ ...f, siteName: e.target.value })} />
            <span className="hint">Printed on visitor passes, shown on the host’s approval page and in downloads.</span>
          </label>
          <GatesManager />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Privacy</h2></div>
        <div className="panel-body">
          <label className="field"><span>Keep masked Aadhaar images for</span>
            <select className="select" value={f.idRetentionDays} onChange={(e) => setF({ ...f, idRetentionDays: Number(e.target.value) })}>
              {(s.retentionChoices || [1, 7, 30, 90, 180, 365]).map((d) => <option key={d} value={d}>{RETENTION_LABEL[d] || `${d} days`}</option>)}
            </select>
            <span className="hint">Older images are deleted automatically and are then left out of downloads. Visitor photos are not affected.</span>
          </label>
          <div className="field">
            <span>Full Aadhaar for the Super Admin</span>
            {superAdmin ? (
              <label className="checkbox" style={{ fontSize: 14 }}>
                <input type="checkbox" checked={f.fullIdCapture} onChange={(e) => setF({ ...f, fullIdCapture: e.target.checked })} />
                <span>Keep the full card, encrypted, alongside the masked one</span>
              </label>
            ) : (
              <span className="muted" style={{ fontSize: 14 }}>{s.fullIdCapture ? 'On' : 'Off'} · only a Super Admin can change this</span>
            )}
            <span className="hint">Only a Super Admin can open it; every view is recorded with their name. It is deleted with the masked image after the period above.</span>
          </div>
          <div className="alert"><Info /><span className="grow">Under the DPDP Act, keep Aadhaar images only as long as you need them for security, and say so in the notice visitors see. Guards and admins only ever see the masked card: the first 8 digits are blacked out on the guard’s device.</span></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Visitor mobile number</h2></div>
        <div className="panel-body">
          <label className="field"><span>Check that the number is real</span>
            <select className="select" value={f.otpMode} onChange={(e) => setF({ ...f, otpMode: e.target.value })}>
              <option value="off">Off: just take the number</option>
              <option value="optional">Optional: guard can verify or skip</option>
              <option value="required">Required: verify before every check-in</option>
            </select>
            <span className="hint">The visitor gets a 6-digit code by SMS and reads it out to the guard. Expected visitors and numbers verified in the last 90 days are not asked again. Only admins can skip when it is required.</span>
          </label>
          <div className={`alert ${ch.otp ? 'alert-ok' : 'alert-warn'}`}>
            {ch.otp ? <CheckCircle2 /> : <AlertTriangle />}
            <span className="grow">{ch.otp ? 'Text messages are on: visitors receive the code on their phone.' : 'Text messages are not switched on yet, so visitors would not receive the code. Keep this Off until GateSmartX support switches text messages on.'}</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Check-in</h2></div>
        <div className="panel-body">
          <label className="field"><span>Purpose buttons</span>
            <input className="input" value={f.purposes} onChange={(e) => setF({ ...f, purposes: e.target.value })} placeholder="Delivery, Meeting, Interview, Service / repair, Guest" />
            <span className="hint">Separated by commas, up to 12. The guard can also pick “Other” and type one.</span>
          </label>
          <label className="field"><span>Pass lengths</span>
            <input className="input" value={f.durations} onChange={(e) => setF({ ...f, durations: e.target.value })} placeholder="2h, 4h, 8h, today, 3d, 7d" />
            <span className="hint">Hours like 6h (up to 72h), days like 15d (up to 90d), or today. “Pick a date” is always there too.</span>
          </label>
          <label className="checkbox" style={{ fontSize: 14 }}>
            <input type="checkbox" checked={f.notifyCheckout} onChange={(e) => setF({ ...f, notifyCheckout: e.target.checked })} />
            <span>Tell the host when their visitor leaves <span className="faint">(WhatsApp, email; SMS once its template is approved)</span></span>
          </label>
          <label className="checkbox" style={{ fontSize: 14 }}>
            <input type="checkbox" checked={f.thankVisitor} onChange={(e) => setF({ ...f, thankVisitor: e.target.checked })} />
            <span>Thank the visitor when they leave <span className="faint">(email if they gave one; SMS once its template is approved, 1 SMS each)</span></span>
          </label>
          <label className="checkbox" style={{ fontSize: 14 }}>
            <input type="checkbox" checked={f.lanyardCards} onChange={(e) => setF({ ...f, lanyardCards: e.target.checked })} />
            <span>Ask for the hotel’s lanyard card number at check-in</span>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Emergency</h2></div>
        <div className="panel-body">
          <label className="field"><span>Assembly point</span>
            <input className="input" value={f.assemblyPoint} maxLength={120} onChange={(e) => setF({ ...f, assemblyPoint: e.target.value })} placeholder="e.g. Main driveway, by the fountain" />
            <span className="hint">Written into the emergency messages (fire, evacuate, drill), so everyone knows where to go. The Emergency button is on every guard desk and at the top of this console.</span>
          </label>
          {!ch.smsAlerts && <div className="alert alert-warn"><AlertTriangle /><span className="grow">Emergency SMS is not set up. Visitors who have not messaged the hotel’s WhatsApp number may not get emergency messages. Ask GateSmartX support to set up an SMS emergency template.</span></div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Visitor past their pass</h2></div>
        <div className="panel-body">
          <label className="field"><span>Escalate to</span>
            <textarea className="textarea" rows={2} value={f.escalateTo} onChange={(e) => setF({ ...f, escalateTo: e.target.value })} placeholder="98110 00099, security.manager@hotel.com" />
            <span className="hint">Mobile numbers (WhatsApp) and email addresses, separated by commas. When a visitor is still inside an hour after their pass ended, these people and the visitor’s host are told. The guard desk and this console show it the moment the pass ends.</span>
          </label>
          {!ch.whatsapp && !ch.email && <div className="alert alert-warn"><AlertTriangle /><span className="grow">WhatsApp and email are both off, so nobody can be told yet. The escalation still shows in red on this console.</span></div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Notifications and printing</h2>
          <button type="button" className="btn btn-sm" onClick={() => go('messages')}>
            Messages and prints{stats && stats.printFailed + stats.smsFailed > 0 && <span className="badge badge-bad plain">{stats.printFailed + stats.smsFailed} failed</span>}<ArrowRight />
          </button>
        </div>
        <div className="panel-body">
          <div className="channel">
            <MessageSquare />
            <span className="grow"><strong>WhatsApp</strong><small>{ch.whatsapp ? 'Hosts get requests with Let them in / Decline buttons.' : 'Off. Ask GateSmartX support to set up your WhatsApp business number.'}</small></span>
            {ch.whatsapp ? <span className="badge badge-live">On</span> : <span className="badge">Off</span>}
          </div>
          <div className="channel">
            <Mail />
            <span className="grow"><strong>Email</strong><small>{ch.email ? `Sent from ${ch.email} to every host with an email address, as well as WhatsApp or SMS. Free.` : 'Off. Ask GateSmartX support to connect a mail account, so hosts also get requests by email.'}</small></span>
            {ch.email ? <span className="badge badge-live">On</span> : <span className="badge">Off</span>}
          </div>
          <div className="channel">
            <Send />
            <span className="grow"><strong>Telegram</strong><small>{ch.telegram ? `Connected as @${ch.telegram}. Connect each host from the Hosts page.` : 'Off. Ask GateSmartX support to set it up, so hosts can approve with one tap in Telegram.'}</small></span>
            {ch.telegram ? <span className="badge badge-live">On</span> : <span className="badge">Off</span>}
          </div>
          <div className="channel">
            <MessageSquare />
            <span className="grow"><strong>SMS</strong><small>{ch.sms ? 'On: hosts get approval requests by text message.' : 'Off: hosts get no text message. Ask GateSmartX support to switch it on. Until then, requests are listed under Messages and prints.'}</small></span>
            {ch.sms ? <span className="badge badge-live">On</span> : <span className="badge">Off</span>}
          </div>
          <div className="channel">
            <Printer />
            <span className="grow"><strong>Visitor passes</strong><small>{ch.printer === 'off' ? 'Printed from the guard desk through the browser, on any printer installed on that computer.' : 'Sent to the label printer automatically when a visitor is approved.'}</small></span>
            <span className="badge badge-live">On</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Data</h2></div>
        <div className="panel-body">
          <div className="channel">
            <Download />
            <span className="grow"><strong>Download visitor records</strong><small>Excel sheet, or the full record with photos. Visit history downloads exactly what its filters show.</small></span>
            <button type="button" className="btn btn-sm" onClick={() => openExport({})}>Download</button>
          </div>
        </div>
      </section>

      {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
      {changed.length > 0 && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span className="grow">You changed {changed.length === 1 ? 'a setting' : `${changed.length} settings`}. Save to apply {changed.length === 1 ? 'it' : 'them'}.</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setF(Object.fromEntries(Object.keys(f).map((k) => [k, s[k]]))); setErr(''); }}>Undo</button>
          <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? <Spinner /> : <Save />}Save changes</button>
        </div>
      )}
    </form>
  );
}
