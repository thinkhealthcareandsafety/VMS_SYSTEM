import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertTriangle, ArrowLeft, Ban, CalendarDays, Check, Copy, Download, FileSpreadsheet, Info, Link2, LogOut, MessageCircle,
  PartyPopper, Pencil, Plus, Printer, RefreshCw, RotateCcw, Search, Upload, UserX, Users,
} from 'lucide-react';
import { api, fmtDateTime, fmtMobile, today } from '../api.js';
import HostPicker from '../components/HostPicker.jsx';
import { Empty, Modal, Spinner, useToast } from '../components/ui.jsx';

// Groups and events: a guest list per wedding, banquet or conference. Creating the group is the approval;
// each guest gets a pass (QR + code) that any gate scans, and the list shows who came.
const STATUS = { expected: ['Not arrived', ''], inside: ['Inside', 'badge-live'], out: ['Out, pass valid', 'badge-ok'], left: ['Left', ''] };
const addDays = (ymd, n) => { const t = new Date(`${ymd}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const waLink = (mobile, text) => `https://wa.me/${mobile ? mobile.replace(/\D/g, '') : ''}?text=${encodeURIComponent(text)}`;
const copy = async (text, toast, what) => {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); } catch { window.prompt('Copy this:', text); }
};

export default function GroupsPage({ tick }) {
  const [openId, setOpenId] = useState(null);
  if (openId) return <GroupDetail id={openId} tick={tick} onBack={() => setOpenId(null)} />;
  return <GroupList tick={tick} onOpen={setOpenId} />;
}

// ----------------------------------------------------------------------------- list
function GroupList({ tick, onOpen }) {
  const [rows, setRows] = useState(null);
  const [view, setView] = useState('current');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api('/api/groups').then((r) => setRows(r.rows)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load, tick]);

  const now = today();
  const term = q.trim().toLowerCase();
  const shown = (rows || [])
    .filter((g) => (view === 'current' ? g.endDay >= now && g.status === 'active' : view === 'past' ? g.endDay < now || g.status === 'cancelled' : true))
    .filter((g) => !term || `${g.name} ${g.host?.name} ${g.purpose}`.toLowerCase().includes(term))
    .sort((a, b) => (view === 'current' ? a.startDay.localeCompare(b.startDay) : b.startDay.localeCompare(a.startDay)));

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Which groups">
          {[['current', 'Today and upcoming'], ['past', 'Past and cancelled'], ['all', 'All']].map(([k, l]) => <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
        </div>
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Group, host or purpose" aria-label="Search groups" /></div>
        <span className="spacer-x" />
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Plus />New group</button>
      </div>
      {!rows ? <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 120, borderRadius: 12 }} /></div> : shown.length === 0 ? (
        <Empty icon={PartyPopper} title={view === 'current' ? 'No groups coming up' : 'Nothing here'}>
          For a wedding, banquet or conference: add the guest list once, and each guest gets a pass any gate can scan.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Group</th><th>Days</th><th>Host</th><th className="r">Guests</th><th className="r">Arrived</th><th className="r">Inside</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((g) => (
                <tr key={g.id} className="clickable" onClick={() => onOpen(g.id)}>
                  <td><div className="name">{g.name}</div>{g.purpose && <div className="meta-line">{g.purpose}</div>}</td>
                  <td>{g.days}</td>
                  <td>{g.host?.name}<div className="meta-line">{g.host?.unit}</div></td>
                  <td className="r num">{g.guests}</td>
                  <td className="r num">{g.arrived}</td>
                  <td className="r num">{g.inside}</td>
                  <td>
                    {g.status === 'cancelled' ? <span className="badge badge-bad">Cancelled</span>
                      : g.today ? <span className="badge badge-live">Today</span>
                        : g.endDay < now ? <span className="badge">Over</span> : <span className="badge">Upcoming</span>}
                    {g.joinOpen && <span className="badge badge-ok" style={{ marginLeft: 6 }}>Link open</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <GroupDialog open={creating} onClose={() => setCreating(false)} onDone={(g) => { setCreating(false); onOpen(g.id); }} />
    </section>
  );
}

// ----------------------------------------------------------------------------- create / edit
function GroupDialog({ open, group, onClose, onDone }) {
  const blank = { name: '', purpose: '', note: '', startDay: today(), endDay: today(), allowWalkIns: false };
  const [f, setF] = useState(blank);
  const [host, setHost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    if (group) {
      setF({ name: group.name, purpose: group.purpose || '', note: group.note || '', startDay: group.startDay, endDay: group.endDay, allowWalkIns: group.allowWalkIns });
      setHost(group.host);
    } else { setF(blank); setHost(null); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const body = { ...f, hostId: host?.id };
      const g = group
        ? await api(`/api/groups/${group.id}`, { method: 'PATCH', body })
        : await api('/api/groups', { method: 'POST', body });
      onDone(g);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <Modal open={open} onClose={onClose} label={group ? 'Edit group' : 'New group'}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2>{group ? 'Edit group' : 'New group'}</h2>
          <p>{group ? 'Changes apply at every gate straight away.' : 'A wedding, banquet, conference or team. Setting it up is the approval: guests on the list need no host request at the gate.'}</p>
        </div>
        <div className="dialog-body">
          <label className="field"><span>Name</span><input className="input" required value={f.name} onChange={set('name')} placeholder="e.g. Sharma wedding, Grand Ballroom" maxLength={80} autoFocus /></label>
          <div className="field"><span>Responsible host</span><HostPicker value={host} onChange={setHost} /></div>
          <div className="grid-2">
            <label className="field"><span>First day</span>
              <input className="input" type="date" required value={f.startDay} min={group ? undefined : today()}
                onChange={(e) => setF({ ...f, startDay: e.target.value, endDay: f.endDay < e.target.value ? e.target.value : f.endDay })} />
            </label>
            <label className="field"><span>Last day</span>
              <input className="input" type="date" required value={f.endDay} min={f.startDay} max={addDays(f.startDay || today(), 90)} onChange={set('endDay')} />
            </label>
          </div>
          <label className="field"><span>Purpose <span className="faint">· optional</span></span><input className="input" value={f.purpose} onChange={set('purpose')} placeholder="Wedding, Conference, Training…" maxLength={80} /></label>
          <label className="field"><span>Note for the guards <span className="faint">· optional</span></span>
            <textarea className="textarea" rows={2} value={f.note} onChange={set('note')} placeholder="e.g. Guests go to the Grand Ballroom via the lobby. Valet at Gate 2." maxLength={300} />
          </label>
          <label className="checkbox" style={{ fontSize: 14 }}>
            <input type="checkbox" checked={f.allowWalkIns} onChange={(e) => setF({ ...f, allowWalkIns: e.target.checked })} />
            <span>Guards may add walk-ins who are not on the list</span>
          </label>
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || f.name.trim().length < 2 || !host}>{busy ? <Spinner /> : group ? <Check /> : <Plus />}{group ? 'Save' : 'Create group'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- one group
function GroupDetail({ id, tick, onBack }) {
  const toast = useToast();
  const [g, setG] = useState(null);
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'checkout' | 'cancel'
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api(`/api/groups/${id}`).then(setG).catch((e) => toast(e.message, 'bad'));
    api(`/api/groups/${id}/guests`).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [id, toast]);
  useEffect(() => { load(); }, [load, tick]);

  const term = q.trim().toLowerCase();
  const shown = useMemo(() => (rows || [])
    .filter((r) => filter === 'all' || (filter === 'gone' ? ['left', 'out'].includes(r.status) : r.status === filter))
    .filter((r) => !term || `${r.firstName} ${r.lastName} ${r.company} ${r.mobile || ''} ${r.code}`.toLowerCase().includes(term)), [rows, filter, term]);

  const patch = async (body, msg) => {
    setBusy(true);
    try { setG(await api(`/api/groups/${id}`, { method: 'PATCH', body })); if (msg) toast(msg); load(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const guestPatch = async (r, body, msg) => {
    try { await api(`/api/groups/${id}/guests/${r.id}`, { method: 'PATCH', body }); toast(msg); load(); } catch (e) { toast(e.message, 'bad'); }
  };
  const checkoutAll = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/groups/${id}/checkout-all`, { method: 'POST' });
      toast(`${r.checkedOut} checked out${r.passesClosed ? `, ${r.passesClosed} passes closed` : ''}.`);
      setConfirm(null); load();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };

  if (!g) return <section className="panel" style={{ padding: 18 }}><div className="skeleton" style={{ height: 160, borderRadius: 12 }} /></section>;
  const inviteText = (r) => `Hi ${r.firstName}, here is your entry pass for ${g.name} (${g.days}): ${r.link}\nShow it at the gate. Code: ${r.code}`;
  const joinText = `You are invited to ${g.name} (${g.days}). Get your entry pass here: ${g.joinLink}`;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="panel">
        <div className="panel-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button className="btn btn-ghost btn-sm" onClick={onBack}><ArrowLeft />Groups</button>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 18 }}>{g.name} {g.status === 'cancelled' && <span className="badge badge-bad">Cancelled</span>}</h2>
              <span className="sub">{g.days} · {g.host?.name}, {g.host?.unit}{g.purpose ? ` · ${g.purpose}` : ''}</span>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => setEditing(true)}><Pencil />Edit</button>
        </div>
        <div className="group-stats">
          <div><strong className="num">{g.guests}</strong><span>on the list</span></div>
          <div><strong className="num">{g.arrived}</strong><span>arrived</span></div>
          <div><strong className="num">{g.inside}</strong><span>inside now</span></div>
          <div><strong className="num">{Math.max(0, g.guests - g.arrived)}</strong><span>not arrived</span></div>
        </div>
        {g.note && <div className="alert" style={{ margin: '0 18px 14px' }}><Info /><span className="grow">Note for guards: {g.note}</span></div>}
        <div className="group-tools">
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)} disabled={g.status === 'cancelled'}><Upload />Add guests</button>
          <a className="btn btn-sm" href={`/api/groups/${id}/guests.xlsx`}><Download />Guest list and pass links</a>
          <button className="btn btn-sm" onClick={() => printBadges(g, rows || [], toast)} disabled={!rows?.length}><Printer />Print badges</button>
          <span className="spacer-x" />
          {g.inside > 0 && <button className="btn btn-sm btn-danger-outline" onClick={() => setConfirm('checkout')}><LogOut />Check out everyone</button>}
          {g.status === 'active'
            ? <button className="btn btn-sm btn-ghost" onClick={() => setConfirm('cancel')}><Ban />Cancel group</button>
            : <button className="btn btn-sm btn-ghost" onClick={() => patch({ status: 'active' }, 'Group is active again.')}><RotateCcw />Reactivate</button>}
        </div>
        {confirm && (
          <div className="alert alert-warn" style={{ margin: '0 18px 16px' }}>
            <AlertTriangle />
            <span className="grow">{confirm === 'checkout'
              ? `Check out all ${g.inside} guests still inside? Use this when the event is over.`
              : 'Cancel this group? Every guest pass stops working at all gates at once.'}</span>
            <button className="btn btn-sm" onClick={() => setConfirm(null)}>Keep</button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => (confirm === 'checkout' ? checkoutAll() : patch({ status: 'cancelled' }, 'Group cancelled. Its passes no longer work.').then(() => setConfirm(null)))}>
              {busy ? <Spinner /> : confirm === 'checkout' ? 'Check out all' : 'Cancel group'}
            </button>
          </div>
        )}
      </section>

      <JoinLinkPanel g={g} busy={busy} onPatch={patch} joinText={joinText} />

      <section className="panel">
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Show">
            {[['all', 'Everyone'], ['expected', 'Not arrived'], ['inside', 'Inside'], ['gone', 'Left']].map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile, company or pass code" aria-label="Search guests" /></div>
        </div>
        {!rows ? <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 120, borderRadius: 12 }} /></div> : rows.length === 0 ? (
          <Empty icon={Users} title="No guests yet">Add the guest list from Excel or by pasting it. Each guest gets their own pass.</Empty>
        ) : shown.length === 0 ? <Empty icon={Search} title="No match">Try another name or filter.</Empty> : (
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Guest</th><th>Mobile</th><th>Pass</th><th>Status</th><th>Arrived</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const [label, cls] = STATUS[r.status];
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="name">{r.firstName} {r.lastName}</div>
                        <div className="meta-line">{r.company}{r.addedAtGate ? ' · walk-in' : ''}{r.selfRegistered ? ' · added themselves' : ''}</div>
                      </td>
                      <td className="num">{r.mobile ? fmtMobile(r.mobile) : <span className="faint">—</span>}</td>
                      <td className="mono">{r.code}</td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      <td className="num">{r.arrivedAt ? fmtDateTime(r.arrivedAt) : <span className="faint">—</span>}{r.lastIn?.gate && <div className="meta-line">{r.lastIn.gate}</div>}</td>
                      <td className="r">
                        <div className="actions">
                          <a className="btn btn-sm btn-icon" href={waLink(r.mobile, inviteText(r))} target="_blank" rel="noopener noreferrer" title="Send the pass on WhatsApp" aria-label={`Send ${r.firstName}'s pass on WhatsApp`}><MessageCircle /></a>
                          <button className="btn btn-sm btn-icon" onClick={() => copy(r.link, toast, 'Pass link')} title="Copy pass link" aria-label={`Copy ${r.firstName}'s pass link`}><Copy /></button>
                          {r.status === 'expected' && <button className="btn btn-sm btn-icon btn-ghost" onClick={() => guestPatch(r, { remove: true }, `${r.firstName} removed. Their pass no longer works.`)} title="Remove from the list" aria-label={`Remove ${r.firstName}`}><UserX /></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <GroupDialog open={editing} group={g} onClose={() => setEditing(false)} onDone={() => { setEditing(false); toast('Group updated.'); load(); }} />
      <AddGuestsDialog open={adding} groupId={id} onClose={() => setAdding(false)} onDone={load} />
    </div>
  );
}

// ----------------------------------------------------------------------------- shared link
function JoinLinkPanel({ g, busy, onPatch, joinText }) {
  const toast = useToast();
  const [limit, setLimit] = useState(g.joinLimit || 50);
  useEffect(() => { setLimit(g.joinLimit || 50); }, [g.joinLimit]);
  return (
    <section className="panel">
      <div className="panel-head">
        <div><h2><Link2 size={16} style={{ verticalAlign: -3 }} /> Link for guests to add themselves</h2><span className="sub">Share one link in a WhatsApp group; each guest gets their own pass. Capped, and you can close or replace it any time.</span></div>
        <button className="switch" role="switch" aria-checked={Boolean(g.joinOpen)} disabled={busy || g.status === 'cancelled'} aria-label="Link open"
          onClick={() => onPatch(g.joinOpen ? { joinOpen: false } : { joinOpen: true, joinLimit: Number(limit) || 50 }, g.joinOpen ? 'Link closed.' : 'Link open. Share it with the guests.')} />
      </div>
      <div className="panel-body join-panel">
        <label className="field" style={{ maxWidth: 220 }}><span>Most guests through the link</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input num" type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(e.target.value)} />
            <button className="btn btn-sm" disabled={busy || Number(limit) === g.joinLimit || !(Number(limit) >= 1)} onClick={() => onPatch({ joinLimit: Number(limit) }, 'Limit saved.')}>Save</button>
          </div>
          <span className="hint">{g.joined || 0} of {g.joinLimit || '—'} places taken</span>
        </label>
        {g.joinOpen && g.joinLink && (
          <div className="join-link">
            <code className="mono">{g.joinLink}</code>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={() => copy(g.joinLink, toast, 'Link')}><Copy />Copy</button>
              <a className="btn btn-sm btn-whatsapp" href={waLink('', joinText)} target="_blank" rel="noopener noreferrer"><MessageCircle />Share on WhatsApp</a>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onPatch({ newJoinLink: true }, 'New link made. The old one no longer works.')}><RefreshCw />New link</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------- add guests
function AddGuestsDialog({ open, groupId, onClose, onDone }) {
  const [mode, setMode] = useState('file');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => { if (open) { setText(''); setErr(''); setResult(null); setMode('file'); } }, [open]);

  const send = async (body) => {
    setBusy(true); setErr('');
    try { setResult(await api(`/api/groups/${groupId}/guests`, { method: 'POST', body })); onDone(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const readFile = (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setErr('The file is larger than 5 MB.'); return; }
    const r = new FileReader();
    r.onload = () => send({ file: String(r.result).split(',')[1], filename: file.name });
    r.onerror = () => setErr('The file could not be read.');
    r.readAsDataURL(file);
  };

  return (
    <Modal open={open} onClose={onClose} label="Add guests">
      <div className="dialog-head">
        <h2>Add guests</h2>
        <p>An Excel or CSV sheet with a <strong>Name</strong> column, and <strong>Mobile</strong> and <strong>Company</strong> if you have them. Headings are recognised in most forms.</p>
      </div>
      <div className="dialog-body">
        {result ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="alert alert-ok"><Check /><span className="grow"><strong>{result.added}</strong> {result.added === 1 ? 'guest' : 'guests'} added, each with their own pass.</span></div>
            {result.warnings?.length > 0 && (
              <div className="alert alert-warn"><Info /><span className="grow">{result.warnings.length} added without a mobile number:<ul className="import-issues">{result.warnings.slice(0, 20).map((w) => <li key={w.line}>Line {w.line}: {w.name}</li>)}</ul></span></div>
            )}
            {result.skipped?.length > 0 && (
              <div className="alert alert-bad"><AlertTriangle /><span className="grow">{result.skipped.length} not added:<ul className="import-issues">{result.skipped.slice(0, 30).map((s) => <li key={s.line}>Line {s.line}{s.name ? ` (${s.name})` : ''}: {s.reason}</li>)}</ul></span></div>
            )}
          </div>
        ) : (
          <>
            <div className="seg" role="group" aria-label="How">
              <button aria-pressed={mode === 'file'} onClick={() => setMode('file')}><FileSpreadsheet size={15} /> Upload a sheet</button>
              <button aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}><Pencil size={15} /> Paste or type</button>
            </div>
            {mode === 'file' ? (
              <div className="drop" onClick={() => fileRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); readFile(e.dataTransfer.files[0]); }} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}>
                {busy ? <Spinner /> : <Upload />}
                <strong>{busy ? 'Reading the sheet…' : 'Choose an Excel or CSV file'}</strong>
                <span className="faint">or drop it here · up to 1,000 guests at a time</span>
                <input ref={fileRef} type="file" hidden accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { readFile(e.target.files[0]); e.target.value = ''; }} />
              </div>
            ) : (
              <label className="field"><span>One guest per line: name, mobile, company</span>
                <textarea className="textarea mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Ravi Kumar, 98765 43210, Groom side\nAnita Desai, 98200 11223, Infosys\nMeena'} />
              </label>
            )}
            <a className="faint" style={{ fontSize: 13 }} href="/api/groups/template.xlsx"><Download size={13} style={{ verticalAlign: -2 }} /> Download a ready-made sheet</a>
          </>
        )}
        {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
      </div>
      <div className="dialog-foot">
        {result ? (
          <>
            <button className="btn btn-ghost" onClick={() => setResult(null)}>Add more</button>
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            {mode === 'paste' && <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => send({ text })}>{busy ? <Spinner /> : <Upload />}Add guests</button>}
          </>
        )}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- badges
// A4 sheet, 8 badges a page (2 × 4): name, company, event, days, QR and code. Opened first, filled after the QR
// codes are made, so the browser does not block it as a pop-up.
async function printBadges(g, rows, toast) {
  const list = rows.filter((r) => r.status !== 'left');
  const win = window.open('', '_blank');
  if (!win) { toast('Allow pop-ups for this site to print badges.', 'bad'); return; }
  win.document.write('<p style="font:16px system-ui;padding:24px">Preparing badges…</p>');
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qrs = await Promise.all(list.map((r) => QRCode.toDataURL(r.link, { width: 240, margin: 0, errorCorrectionLevel: 'M' }).catch(() => '')));
  const marks = `<div class="lg"><img src="${location.origin}/brand/marquis-mark.png" alt="Marriott Marquis"><i></i><img class="sr" src="${location.origin}/brand/stregis-mark.png" alt="St. Regis"></div>`;
  const badges = list.map((r, i) => `<div class="b">${marks}<div class="ev">${esc(g.name)}</div><div class="nm">${esc(`${r.firstName} ${r.lastName}`.trim())}</div><div class="co">${esc(r.company)}</div><img src="${qrs[i]}" alt=""><div class="cd">${esc(r.code)}</div><div class="dy">${esc(g.days)}</div></div>`).join('');
  win.document.open();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Badges · ${esc(g.name)}</title><style>
@page { size: A4; margin: 10mm; } * { box-sizing: border-box; } body { margin: 0; font-family: -apple-system, "Segoe UI", Arial, sans-serif; color: #000; }
.sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
.b { height: 64mm; border: .3mm dashed #999; border-radius: 3mm; padding: 3.5mm 4mm; display: grid; grid-template-rows: auto auto auto auto 1fr auto auto; justify-items: center; text-align: center; break-inside: avoid; }
.lg { display: flex; align-items: center; gap: 2.5mm; margin-bottom: 1.5mm; } .lg img { height: 5mm; width: auto; } .lg img.sr { height: 6mm; } .lg i { width: .2mm; height: 5mm; background: #a8a8a8; }
.ev { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #444; } .nm { font-family: 'Didot', 'Bodoni 72', 'Bodoni MT', Georgia, serif; font-size: 17pt; font-weight: 600; line-height: 1.1; margin-top: 1mm; }
.co { font-size: 10pt; color: #333; min-height: 4mm; } img { width: 26mm; height: 26mm; align-self: center; } .cd { font: 600 11pt ui-monospace, Menlo, Consolas, monospace; letter-spacing: .06em; } .dy { font-size: 8.5pt; color: #444; }
</style></head><body><div class="sheet">${badges}</div></body></html>`);
  win.document.close();
  // The site's security policy blocks scripts inside the sheet, so printing is started from here.
  const go = () => { try { win.focus(); win.print(); } catch { /* the guard can press Ctrl+P */ } };
  if (win.document.readyState === 'complete') setTimeout(go, 300); else win.addEventListener('load', () => setTimeout(go, 300), { once: true });
}
