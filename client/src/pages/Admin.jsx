import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Building2, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, ExternalLink,
  Eye, FileSpreadsheet, FolderArchive, History, LayoutDashboard, LogIn, LogOut, MessageSquare, Plus, Printer,
  RotateCcw, ScrollText, Search, ShieldCheck, Upload, UserPlus, Users, X, XCircle, KeyRound, UserCog, Info, Send,
} from 'lucide-react';
import { api, fmtDate, fmtDateTime, fmtDuration, fmtMobile, fmtTime, minutesSince, passLabel } from '../api.js';
import QRCode from 'qrcode';
import { PasswordDialog, SecretBox } from '../components/Account.jsx';
import { useLive, useTick } from '../lib/live.js';
import { Avatar, Empty, Logo, Modal, Spinner, StatusBadge, STATUS, useToast, useTitle } from '../components/ui.jsx';

const TZ = 'Asia/Kolkata';
const NAV = [
  { group: 'Today', items: [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'inside', label: 'On premises', icon: Users },
  ] },
  { group: 'Records', items: [
    { id: 'history', label: 'Visit history', icon: History },
    { id: 'messages', label: 'Messages and prints', icon: MessageSquare },
    { id: 'audit', label: 'Audit log', icon: ScrollText },
  ] },
  { group: 'Setup', items: [
    { id: 'hosts', label: 'Hosts', icon: Building2 },
    { id: 'staff', label: 'Staff accounts', icon: UserCog },
  ] },
];
const TITLES = {
  overview: ['Overview', 'Today at this gate'],
  inside: ['On premises', 'Everyone let in and not yet checked out'],
  history: ['Visit history', 'Every visit, searchable'],
  messages: ['Messages and prints', 'Approval requests sent to hosts, and sticker jobs'],
  audit: ['Audit log', 'Who did what, and when'],
  hosts: ['Hosts', 'Residents and staff who can approve visitors'],
  staff: ['Staff accounts', 'Who can sign in to the guard desk and this console'],
};

// ---------- date helpers (site timezone) ----------
const dayStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const daysAgo = (n) => dayStr(new Date(Date.now() - n * 86400e3));
const monthStart = () => `${dayStr(new Date()).slice(0, 8)}01`;
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const fmtHour = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const photoUrl = (id) => `/api/visits/${id}/photo`;

export default function Admin({ user, onLogout }) {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const section = TITLES[params.get('s')] ? params.get('s') : 'overview';
  const go = (s) => { setParams(s === 'overview' ? {} : { s }); window.scrollTo(0, 0); };
  const [stats, setStats] = useState(null);
  const [tick, setTick] = useState(0); // bumps on every live event; pages reload on change
  const [visitId, setVisitId] = useState(null);
  const [exportOpts, setExportOpts] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);

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

  const failures = stats ? stats.printFailed + stats.smsFailed : 0;
  const [title, sub] = TITLES[section];
  useTitle(title);
  const page = { tick, refresh, go, openVisit: setVisitId, toast, stats, openExport: setExportOpts };

  return (
    <div className="console">
      <aside className="sidebar" aria-label="Admin navigation">
        <Logo />
        {NAV.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <span className="group">{g.group}</span>
            {g.items.map(({ id, label, icon: Icon }) => (
              <button key={id} className="nav-item" aria-current={section === id ? 'page' : undefined} onClick={() => go(id)}>
                <Icon /><span className="grow">{label}</span>
                {id === 'inside' && stats ? <span className="n">{stats.inside}</span> : null}
                {id === 'messages' && failures > 0 ? <span className="n alert-n" aria-label={`${failures} failed`}>{failures}</span> : null}
              </button>
            ))}
          </div>
        ))}
        <span className="group">Data</span>
        <button className="nav-item" onClick={() => setExportOpts({})}><Download /><span className="grow">Download data</span></button>
        <span className="spacer" />
        <div className="me">
          <Avatar name={user.fullName} size={32} />
          <span className="grow"><strong>{user.fullName}</strong><small>Administrator</small></span>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setPwOpen(true)} aria-label="Change password" title="Change password"><KeyRound /></button>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut /></button>
        </div>
      </aside>

      <main className="admin-main">
        <header className="page-head">
          <div><h1>{title}</h1><p className="sub">{sub}</p></div>
          <div className="right">
            <span className="conn"><span className={`live-dot ${connected ? '' : 'off'}`} />{connected ? 'Live' : 'Reconnecting'}</span>
            <button className="btn btn-primary btn-sm" onClick={() => setExportOpts({})}><Download />Download</button>
          </div>
        </header>
        <div className="page">
          {section === 'overview' && <Overview {...page} />}
          {section === 'inside' && <InsidePage {...page} />}
          {section === 'history' && <HistoryPage {...page} />}
          {section === 'messages' && <MessagesPage {...page} />}
          {section === 'audit' && <AuditPage {...page} />}
          {section === 'hosts' && <HostsPage {...page} />}
          {section === 'staff' && <StaffPage {...page} user={user} />}
        </div>
      </main>

      <VisitDrawer id={visitId} tick={tick} onClose={() => setVisitId(null)} onChanged={refresh} />
      <ExportDialog opts={exportOpts} onClose={() => setExportOpts(null)} />
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

// ================================================================= Overview
function Overview({ stats, tick, go, openVisit, toast, refresh }) {
  const [pending, setPending] = useState(null);
  const [inside, setInside] = useState(null);
  useTick(30000);
  useEffect(() => {
    api('/api/admin/visits?status=pending&limit=20').then((r) => setPending(r.rows)).catch(() => setPending([]));
    api('/api/visits/inside').then(setInside).catch(() => {});
  }, [tick]);

  const resend = async (v) => {
    try { await api(`/api/visits/${v.id}/resend`, { method: 'POST' }); toast(`New approval SMS sent to ${v.host}.`); refresh(); } catch (e) { toast(e.message, 'bad'); }
  };
  const cancel = async (v) => {
    try { await api(`/api/visits/${v.id}/cancel`, { method: 'POST' }); toast(`${v.name}’s visit was cancelled.`); refresh(); } catch (e) { toast(e.message, 'bad'); }
  };

  if (!stats) return <div className="skeleton" style={{ height: 120, borderRadius: 14 }} />;
  const left = stats.checkedOutToday + stats.forceToday;
  const peak = stats.byHour.reduce((b, n, h) => (n > stats.byHour[b] ? h : b), 0);

  return (
    <>
      {(stats.printFailed > 0 || stats.smsFailed > 0) && (
        <div className="alert alert-bad" role="alert">
          <AlertTriangle />
          <span className="grow">
            <strong>{[stats.smsFailed && `${stats.smsFailed} SMS`, stats.printFailed && `${stats.printFailed} sticker ${stats.printFailed === 1 ? 'print' : 'prints'}`].filter(Boolean).join(' and ')} failed.</strong>{' '}
            Check the SMS settings or the printer, then retry.
          </span>
          <button className="btn btn-sm" onClick={() => go('messages')}>Review<ArrowRight /></button>
        </div>
      )}
      {stats.staleInside > 0 && (
        <div className="alert alert-warn">
          <Clock />
          <span className="grow"><strong>{stats.staleInside} {stats.staleInside === 1 ? 'visitor has' : 'visitors have'} been inside unusually long.</strong> The guard may have missed the exit.</span>
          <button className="btn btn-sm" onClick={() => go('inside')}>Review<ArrowRight /></button>
        </div>
      )}

      <section className="panel kpis" aria-label="Today in numbers">
        <Kpi icon={Users} label="On premises" value={stats.inside} note={stats.staleInside ? `${stats.staleInside} long stay` : 'Right now'} />
        <Kpi icon={LogIn} label="Arrivals today" value={stats.arrivalsToday} note={stats.arrivalsToday ? `Busiest ${fmtHour(peak)}–${fmtHour((peak + 1) % 24)}` : 'None yet'} />
        <Kpi icon={Clock} label="Awaiting host" value={stats.pending} note={stats.pending ? 'SMS sent, no reply yet' : 'Nobody waiting'} />
        <Kpi icon={LogOut} label="Left today" value={left} note={stats.forceToday ? `${stats.forceToday} checked out by admin` : 'Checked out at the gate'} />
      </section>

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

function Kpi({ icon: Icon, label, value, note }) {
  return (
    <div className="kpi">
      <span className="k"><Icon />{label}</span>
      <span className="v">{value}</span>
      <span className="d">{note}</span>
    </div>
  );
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
function InsidePage({ tick, openVisit, refresh }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [force, setForce] = useState(null);
  useTick(30000);
  useEffect(() => { api('/api/visits/inside').then(setData).catch(() => {}); }, [tick]);

  const term = q.trim().toLowerCase();
  const rows = (data?.visits || []).filter((v) => !term || `${v.firstName} ${v.lastName} ${v.company} ${v.host?.name} ${v.host?.unit} ${v.dailyNumber} ${v.ref} ${v.mobile}`.toLowerCase().includes(term));
  const long = (data?.visits || []).filter((v) => v.insideMinutes >= data.staleAfterHours * 60).length;

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="input-group field wide">
          <Search />
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, pass number, flat, mobile" aria-label="Search on premises" />
        </div>
        <span className="muted num" style={{ alignSelf: 'center' }}>
          {data ? `${data.count} inside${long ? ` · ${long} long stay` : ''}` : ''}
        </span>
      </div>
      {!data ? <ListSkeleton /> : rows.length === 0 ? (
        <Empty icon={data.count ? Search : ShieldCheck} title={data.count ? 'No match' : 'Nobody inside'}>
          {data.count ? 'Try a pass number or flat.' : 'Approved visitors appear here until they check out.'}
        </Empty>
      ) : (
        <InsideTable rows={rows} staleAfter={data.staleAfterHours} openVisit={openVisit} onForce={setForce} />
      )}
      <ForceDialog visit={force} onClose={() => setForce(null)} onDone={refresh} />
    </section>
  );
}

function InsideTable({ rows, staleAfter, openVisit, onForce, compact }) {
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
            <th>Pass</th><th>Visitor</th><th>Meeting</th><th>Let in</th><th>Inside for</th>
            {!compact && <th className="r"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const mins = minutesSince(v.decidedAt);
            const isLong = mins >= staleAfter * 60;
            return (
              <tr key={v.id} className="clickable" onClick={() => openVisit(v.id)}>
                <td><span className="pass-chip">{passLabel(v)}</span></td>
                <td>
                  <div className="person">
                    <Avatar src={photoUrl(v.id)} name={`${v.firstName} ${v.lastName}`} size={36} square />
                    <div><div className="name">{v.firstName} {v.lastName}</div><div className="meta">{v.company} · <span className="mono">{v.ref}</span></div></div>
                  </div>
                </td>
                <td>{v.host?.name}<div className="meta-line">{v.host?.unit}</div></td>
                <td className="num">{fmtTime(v.decidedAt)}</td>
                <td className="num">
                  <span className={isLong ? 'row-flag' : ''}>{fmtDuration(mins)}</span>
                  {isLong && <div><span className="badge badge-warn">Long stay</span></div>}
                </td>
                {!compact && (
                  <td>
                    <div className="actions">
                      <button className="btn btn-sm btn-icon" onClick={(e) => reprint(e, v)} aria-label={`Reprint sticker ${v.dailyNumber}`} title="Reprint sticker"><Printer /></button>
                      <button className="btn btn-sm btn-danger-outline" onClick={(e) => { e.stopPropagation(); onForce(v); }}><LogOut />Check out</button>
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
function ForceDialog({ visit, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(''); }, [visit?.id]);
  const name = visit ? `${visit.firstName || ''} ${visit.lastName || ''}`.trim() || visit.name : '';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/visits/${visit.id}/force-checkout`, { method: 'POST', body: { reason } });
      toast(`${name} checked out. Reason saved to the audit log.`);
      onClose();
      onDone();
    } catch (err) { toast(err.message, 'bad'); } finally { setBusy(false); }
  };

  return (
    <Modal open={Boolean(visit)} onClose={onClose} label="Check out visitor">
      {visit && (
        <form onSubmit={submit}>
          <div className="dialog-head">
            <h2>Check out {name}?</h2>
            <p>Use this when the guard did not mark the exit. The reason is kept in the audit log.</p>
          </div>
          <div className="dialog-body">
            <div className="chips">
              {FORCE_REASONS.map((r) => <button type="button" key={r} className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
            </div>
            <label className="field">
              <span>Reason</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={200} required placeholder="Pick one above or type your own" />
            </label>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-danger" disabled={busy || reason.trim().length < 5}>{busy ? <Spinner /> : <LogOut />}Check out</button>
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
function HistoryPage({ tick, openVisit, openExport }) {
  const [f, setF] = useState({ name: '', host: '', company: '', status: '', from: daysAgo(6), to: '' });
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
      <div className="toolbar">
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
                  <td className="num">{fmtDate(r.createdAt)}{r.dailyNumber != null && <div className="meta-line">Pass {r.dailyNumber}</div>}</td>
                  <td className="num">
                    {['approved', 'checked_out', 'force_checked_out'].includes(r.status) ? (
                      <>{fmtTime(r.decidedAt)}<div className="meta-line">{r.checkedOutAt ? `to ${fmtTime(r.checkedOutAt)}` : 'still inside'}</div></>
                    ) : <span className="faint">—</span>}
                  </td>
                  <td><StatusBadge status={r.status} /></td>
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
  'export.visits_zip': ['Downloaded a full backup', ''],
  'host.created': ['Host added', ''],
  'host.updated': ['Host updated', ''],
  'host.imported': ['Hosts imported', ''],
  'auth.login': ['Signed in', ''],
  'auth.password_changed': ['Changed their password', ''],
  'user.created': ['Staff account added', ''],
  'user.updated': ['Staff account changed', ''],
  'user.password_reset': ['Staff password reset', 'warn'],
  'auth.login_failed': ['Failed sign-in attempt', 'bad'],
};
const actionLabel = (a) => ACTIONS[a]?.[0] || a;
const TL_ICON = { ok: CheckCircle2, bad: XCircle, warn: AlertTriangle };

function VisitDrawer({ id, tick, onClose, onChanged }) {
  const toast = useToast();
  const [v, setV] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [showId, setShowId] = useState(false);
  const [force, setForce] = useState(null);

  useEffect(() => { setV(null); setTimeline(null); setShowId(false); }, [id]);
  useEffect(() => {
    if (!id) return;
    api(`/api/visits/${id}`).then(setV).catch((e) => toast(e.message, 'bad'));
    api(`/api/admin/visits/${id}/timeline`).then((r) => setTimeline(r.rows)).catch(() => setTimeline([]));
  }, [id, tick, toast]);

  const act = async (path, msg) => {
    try { await api(`/api/visits/${id}/${path}`, { method: 'POST' }); toast(msg); onChanged(); } catch (e) { toast(e.message, 'bad'); }
  };
  const admitted = v && ['approved', 'checked_out', 'force_checked_out'].includes(v.status);
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
              <img className="photo" src={photoUrl(v.id)} alt={`Photo of ${name}`} />
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
              <dt>Purpose</dt><dd>{v.purpose || <span className="faint">Not given</span>}</dd>
              <dt>Meeting</dt><dd>{v.host?.name}, {v.host?.unit}</dd>
              <dt>Arrived</dt><dd className="num">{fmtDateTime(v.createdAt)}</dd>
              {admitted && <><dt>Let in</dt><dd className="num">{fmtDateTime(v.decidedAt)}</dd></>}
              {v.checkedOutAt && <><dt>Left</dt><dd className="num">{fmtDateTime(v.checkedOutAt)} · {fmtDuration(Math.round((new Date(v.checkedOutAt) - new Date(v.decidedAt)) / 60000))} inside</dd></>}
              {v.forceReason && <><dt>Checkout reason</dt><dd>{v.forceReason}</dd></>}
              {v.printStatus && <><dt>Sticker</dt><dd>{v.printStatus === 'off' ? 'No printer connected' : v.printStatus === 'sent' ? 'Printed' : v.printStatus === 'failed' ? `Failed${v.printError ? `: ${v.printError}` : ''}` : 'In the print queue'}</dd></>}
            </dl>

            <div>
              <h3 className="section-title">Aadhaar card (masked)</h3>
              {!v.hasIdImage ? (
                <p className="muted">Deleted automatically after the retention period.</p>
              ) : showId ? (
                <div className="id-frame"><img src={`/api/visits/${v.id}/id-image`} alt="Masked Aadhaar card" /></div>
              ) : (
                <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                  <button className="btn btn-sm" onClick={() => setShowId(true)}><Eye />Show masked Aadhaar</button>
                  <span className="faint" style={{ fontSize: 12.5 }}>Each view is recorded in the audit log.</span>
                </div>
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
                          <div className="when">{fmtDateTime(t.at)} · {t.role === 'host' ? 'Host' : t.actor}{t.details?.reason ? ` · “${t.details.reason}”` : ''}</div>
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
          {['pending', 'expired'].includes(v.status) && <button className="btn" onClick={() => act('resend', 'New approval SMS sent.')}><RotateCcw />Resend SMS</button>}
          {admitted && <button className="btn" onClick={() => act('reprint', 'Sticker sent to the printer.')}><Printer />Reprint sticker</button>}
          {v.status === 'approved' && <button className="btn btn-danger-outline" onClick={() => setForce(v)}><LogOut />Check out</button>}
        </div>
      )}
      <ForceDialog visit={force} onClose={() => setForce(null)} onDone={onChanged} />
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
              ? <><strong>Hosts who connected Telegram get requests there.</strong> For everyone else, SMS are only logged here (no SMS provider is connected): open the approval link below, or connect them on the Hosts page.</>
              : <><strong>SMS are logged here, not delivered yet.</strong> No SMS provider is connected. To approve a visitor, open the approval link below, or share it with the host.</>}
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
  { id: '', label: 'All' }, { id: 'visit.', label: 'Visits' }, { id: 'force', label: 'Force checkouts' },
  { id: 'id_image', label: 'Aadhaar views' }, { id: 'export', label: 'Downloads' }, { id: 'auth', label: 'Sign-ins' }, { id: 'user.', label: 'Staff' }, { id: 'host.', label: 'Hosts' },
];
const ROLE_LABEL = { admin: 'Administrator', guard: 'Guard' };
const DETAIL_KEYS = { dailyNumber: 'pass', rows: 'visits', from: 'from', to: 'to', created: 'added', errors: 'errors', unit: 'flat', host: 'host', reason: 'reason', error: 'error', active: 'receives visitors' };
function AuditPage({ tick, openVisit }) {
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState(null);
  useEffect(() => { api(`/api/admin/audit?${qs({ action: filter })}`).then((d) => setRows(d.rows)).catch(() => setRows([])); }, [filter, tick]);

  const detail = (r) => {
    const d = { ...(r.details || {}) };
    delete d.ref;
    return Object.entries(d).filter(([, v]) => v !== undefined && v !== '' && v !== null)
      .map(([k, v]) => `${DETAIL_KEYS[k] || k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
  };

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="seg seg-wrap" role="group" aria-label="Filter">
          {AUDIT_FILTERS.map((f) => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
      </div>
      {!rows ? <ListSkeleton /> : rows.length === 0 ? <Empty icon={ScrollText} title="No entries">Nothing recorded for this filter yet.</Empty> : (
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
        </div>
      )}
    </section>
  );
}

// ================================================================= Hosts
function HostsPage({ toast, stats }) {
  const [rows, setRows] = useState(null);
  const [connecting, setConnecting] = useState(null); // host being connected to Telegram
  const [editingHost, setEditingHost] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => api('/api/admin/hosts').then((d) => setRows(d.rows)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);

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
        <button className="btn btn-sm" onClick={() => setImporting(true)}><Upload />Import CSV</button>
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
      <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={load} />
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
  const disconnect = async () => {
    try { await api(`/api/admin/hosts/${host.id}`, { method: 'PATCH', body: { disconnectTelegram: true } }); toast(`${host.fullName} disconnected from Telegram.`); onDone(); onClose(); } catch (x) { setErr(x.message); }
  };
  useEffect(() => {
    if (!open) return;
    setErr('');
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
          <label className="field"><span>Email <span className="faint">· optional</span></span><input className="input" type="email" value={f.email} onChange={set('email')} /></label>
          {editing && host.telegram && (
            <div className="field"><span>Telegram</span>
              <div className="notice-inline"><span className="badge badge-live">Connected</span><button type="button" className="btn btn-sm btn-danger-outline" onClick={disconnect}>Disconnect</button></div>
              <span className="hint">Approval requests go to Telegram. After disconnecting they fall back to SMS.</span>
            </div>
          )}
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : editing ? <CheckCircle2 /> : <UserPlus />}{editing ? 'Save changes' : 'Add host'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportDialog({ open, onClose, onDone }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { if (open) { setCsv(''); setResult(null); } }, [open]);
  const lines = csv.split(/\r?\n/).filter((l) => l.trim()).length;

  const readFile = async (file) => { if (file) setCsv((await file.text()).replace(/^﻿/, '')); };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/api/admin/hosts/import', { method: 'POST', body: { csv } });
      setResult(r);
      if (r.created) { toast(`${r.created} ${r.created === 1 ? 'host' : 'hosts'} added.`); onDone(); }
      if (!r.errors.length) onClose();
    } catch (e) { setResult({ created: 0, errors: [{ line: '-', error: e.message }] }); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} label="Import hosts">
      <div className="dialog-head"><h2>Import hosts</h2><p>One host per line: <span className="mono">name, flat, mobile, email</span>. Email is optional.</p></div>
      <div className="dialog-body">
        <button type="button" className="dropzone" onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); readFile(e.dataTransfer.files[0]); }}>
          <Upload /><strong>Choose a CSV file</strong><span className="faint">or drop it here, or paste below</span>
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => readFile(e.target.files[0])} />
        <textarea className="textarea" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} placeholder={'Asha Verma, A-101, 9000000001\nRahul Mehta, B-302, 9000000002'} aria-label="Hosts CSV" />
        {result?.errors?.length > 0 && (
          <div className="alert alert-warn"><AlertTriangle /><span className="grow">{result.created} added. Fix {result.errors.length === 1 ? 'line' : 'lines'} {result.errors.map((x) => x.line).join(', ')}: {result.errors[0].error}</span></div>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" disabled={!lines || busy} onClick={submit}>{busy ? <Spinner /> : <Upload />}Import {lines || ''} {lines === 1 ? 'host' : 'hosts'}</button>
      </div>
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

  const href = `/api/admin/visits.${format}?${query}`;
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
              <FolderArchive /><span><strong>Full backup (.zip)</strong><small>Excel sheet plus every visitor photo</small></span>
            </button>
            <button type="button" role="radio" aria-checked={format === 'csv'} className="export-opt" onClick={() => setFormat('csv')}>
              <FileSpreadsheet /><span><strong>Excel sheet only (.csv)</strong><small>All details, opens in Excel or Google Sheets</small></span>
            </button>
          </div>
        </div>
        <p className="faint" style={{ fontSize: 12.5 }}>Aadhaar images are never included. Every download is recorded in the audit log.</p>
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

function StaffPage({ toast, user }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => api('/api/admin/users').then((d) => setRows(d.rows)).catch(() => setRows([])), []);
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
        <span className="muted num" style={{ alignSelf: 'center' }}>{rows ? `${counts.guard || 0} ${counts.guard === 1 ? 'guard' : 'guards'} · ${counts.admin || 0} ${counts.admin === 1 ? 'admin' : 'admins'}` : ''}</span>
        <span className="spacer-x" />
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><UserPlus />Add staff</button>
      </div>
      {!rows ? <ListSkeleton /> : shown.length === 0 ? (
        <Empty icon={UserCog} title="No match">Try a different name.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th><th>Last sign-in</th><th className="r">Can sign in</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
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
                    <td><span className={`badge plain ${u.role === 'admin' ? 'role-admin' : ''}`}>{ROLE_INFO[u.role][0]}</span></td>
                    <td className="num">{ago(u.lastLoginAt)}</td>
                    <td className="r">
                      <button className="switch" role="switch" aria-checked={u.active} disabled={self}
                        aria-label={`${u.fullName} can sign in`} title={self ? 'You cannot switch off your own account' : undefined} onClick={() => toggle(u)} />
                    </td>
                    <td className="r"><button className="btn btn-sm" onClick={() => setEditing(u)}>Manage</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <AddStaffDialog open={adding} onClose={() => setAdding(false)} onDone={load} />
      <EditStaffDialog member={editing} self={editing?.id === user.id} onClose={() => setEditing(null)} onDone={load} />
    </section>
  );
}

function RolePicker({ value, onChange, disabled }) {
  return (
    <div className="export-opts" role="radiogroup" aria-label="Role">
      {Object.entries(ROLE_INFO).map(([id, [label, desc]]) => (
        <button type="button" key={id} role="radio" aria-checked={value === id} className="export-opt" disabled={disabled} onClick={() => onChange(id)}>
          {id === 'admin' ? <ShieldCheck /> : <Users />}<span><strong>{label}</strong><small>{desc}</small></span>
        </button>
      ))}
    </div>
  );
}

function AddStaffDialog({ open, onClose, onDone }) {
  const blank = { fullName: '', username: '', role: 'guard', password: '' };
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
      const res = await api('/api/admin/users', { method: 'POST', body: { fullName: f.fullName, username: f.username, role: f.role, ...(ownPassword ? { password: f.password } : {}) } });
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
          <div className="field"><span>Role</span><RolePicker value={f.role} onChange={(role) => setF({ ...f, role })} /></div>
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

function EditStaffDialog({ member, self, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', role: 'guard' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [newPassword, setNewPassword] = useState(null);
  useEffect(() => {
    if (member) { setF({ fullName: member.fullName, role: member.role }); setErr(''); setConfirmReset(false); setNewPassword(null); }
  }, [member?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = member && (f.fullName.trim() !== member.fullName || f.role !== member.role);
  const save = async (e) => {
    e.preventDefault();
    if (!changed) return onClose();
    setBusy(true); setErr('');
    try {
      await api(`/api/admin/users/${member.id}`, { method: 'PATCH', body: { fullName: f.fullName, role: f.role } });
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
              <RolePicker value={f.role} onChange={(role) => setF({ ...f, role })} disabled={self} />
            </div>
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
