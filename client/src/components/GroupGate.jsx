import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Info, LogIn, ScanLine, Search, UserPlus, Users } from 'lucide-react';
import { api, fmtTime } from '../api.js';
import { cue } from '../lib/notify.js';
import { Empty, Modal, Spinner, useToast } from './ui.jsx';

// One group at the gate: find a guest by name, the last digits of their number or their pass code, and let
// them in with one tap; tick several to let a family or a team in together; add walk-ins when allowed.
const FILTERS = [['all', 'Everyone'], ['expected', 'Not arrived'], ['inside', 'Inside'], ['gone', 'Left']];
const STATUS = { expected: ['Not arrived', ''], inside: ['Inside', 'badge-live'], out: ['Out, pass valid', 'badge-ok'], left: ['Left', ''] };
const canAdmit = (g) => g.status !== 'inside';

export default function GroupGate({ groupId, liveTick, onBack, onScan }) {
  const toast = useToast();
  const [group, setGroup] = useState(null);
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState('all');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(null); // guest id, or 'many'
  const [walkIn, setWalkIn] = useState(false);

  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 220); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    api(`/api/groups/${groupId}`).then(setGroup).catch((e) => toast(e.message, 'bad'));
    api(`/api/groups/${groupId}/guests${term ? `?q=${encodeURIComponent(term)}` : ''}`).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [groupId, term, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (liveTick) load(); }, [liveTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (rows || []).filter((g) => filter === 'all'
    || (filter === 'expected' && g.status === 'expected')
    || (filter === 'inside' && g.status === 'inside')
    || (filter === 'gone' && (g.status === 'left' || g.status === 'out'))), [rows, filter]);

  const say = (r) => {
    if (r.ok) { cue.approved(); toast(r.message, 'ok'); } else { (r.result === 'inside' ? cue.expired : cue.rejected)(); toast(r.message, r.result === 'inside' ? 'info' : 'bad'); }
  };
  const admit = async (g) => {
    setBusy(g.id);
    try { say(await api(`/api/groups/${groupId}/guests/${g.id}/admit`, { method: 'POST' })); load(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(null); }
  };
  const admitPicked = async () => {
    setBusy('many');
    try {
      const r = await api(`/api/groups/${groupId}/admit-many`, { method: 'POST', body: { ids: [...picked] } });
      const refused = r.results.filter((x) => !x.ok);
      if (r.letIn) cue.approved(); else cue.rejected();
      toast(`${r.letIn} let in${refused.length ? `. Not let in: ${refused.map((x) => `${x.guest.name} (${x.message})`).join('; ')}` : '.'}`, refused.length ? 'info' : 'ok');
      setPicked(new Set());
      load();
    } catch (e) { toast(e.message, 'bad'); } finally { setBusy(null); }
  };
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (!group) return <div className="card" style={{ padding: 24 }}><Spinner /></div>;
  return (
    <div className="group-gate">
      <div className="card group-head">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onBack}><ArrowLeft />Back</button>
        <div className="group-title">
          <h1>{group.name}</h1>
          <p className="muted">{group.days}{group.host ? ` · ${group.host.name}, ${group.host.unit}` : ''}{group.purpose ? ` · ${group.purpose}` : ''}</p>
        </div>
        <div className="group-counts">
          <span><strong className="num">{group.arrived}</strong> of {group.guests} arrived</span>
          <span><strong className="num">{group.inside}</strong> inside</span>
        </div>
        {group.status === 'cancelled' && <div className="alert alert-bad"><Info /><span className="grow">This group was cancelled. Do not let guests in on it.</span></div>}
        {!group.today && group.status !== 'cancelled' && <div className="alert alert-warn"><Info /><span className="grow">This group is for {group.days}, not today.</span></div>}
        {group.note && <div className="alert"><Info /><span className="grow">{group.note}</span></div>}
        <div className="group-actions">
          <button type="button" className="btn btn-primary" onClick={onScan}><ScanLine />Scan passes</button>
          {group.allowWalkIns && <button type="button" className="btn" onClick={() => setWalkIn(true)}><UserPlus />Add a walk-in</button>}
        </div>
      </div>

      <div className="card group-list">
        <div className="input-group">
          <Search />
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, last digits of mobile, or pass code" aria-label="Find a guest" autoFocus />
        </div>
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.map(([k, l]) => <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
        </div>

        {!rows ? <div className="skeleton" style={{ height: 120, borderRadius: 12 }} /> : shown.length === 0 ? (
          <Empty icon={term ? Search : Users} title={term ? 'Not on this list' : 'Nobody here'}>
            {term ? (group.allowWalkIns ? 'Check the spelling, or add them as a walk-in.' : 'Check the spelling. Someone not on the list is checked in as a visitor.') : 'Try another filter.'}
          </Empty>
        ) : (
          <ul className="guest-rows">
            {shown.map((g) => {
              const [label, cls] = STATUS[g.status];
              return (
                <li key={g.id} className={`guest-row ${g.status}`}>
                  {canAdmit(g) ? (
                    <input type="checkbox" checked={picked.has(g.id)} onChange={() => toggle(g.id)} aria-label={`Select ${g.firstName} ${g.lastName}`} />
                  ) : <span className="guest-tick"><CheckCircle2 /></span>}
                  <div className="guest-who">
                    <strong>{g.firstName} {g.lastName}</strong>
                    <span className="faint">
                      {g.company || ''}{g.company && g.mobileEnd ? ' · ' : ''}{g.mobileEnd ? `•••• ${g.mobileEnd}` : ''}
                      {g.lastIn && g.status === 'inside' ? ` · in ${fmtTime(g.lastIn.at)}${g.lastIn.gate ? `, ${g.lastIn.gate}` : ''}` : ''}
                      {g.addedAtGate ? ' · walk-in' : ''}
                    </span>
                  </div>
                  <span className={`badge ${cls}`}>{label}{g.dailyNumber != null && g.status === 'inside' ? ` · ${g.dailyNumber}` : ''}</span>
                  {canAdmit(g) && (
                    <button type="button" className="btn btn-sm btn-success" disabled={busy !== null} onClick={() => admit(g)}>
                      {busy === g.id ? <Spinner /> : <><LogIn />Let in</>}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {picked.size > 0 && (
        <div className="pick-bar">
          <span><strong>{picked.size}</strong> selected</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
          <button type="button" className="btn btn-success" disabled={busy !== null} onClick={admitPicked}>{busy === 'many' ? <Spinner /> : <LogIn />}Let in {picked.size}</button>
        </div>
      )}

      <WalkInDialog open={walkIn} groupId={groupId} onClose={() => setWalkIn(false)} onDone={(r) => { setWalkIn(false); say(r); load(); }} />
    </div>
  );
}

function WalkInDialog({ open, groupId, onClose, onDone }) {
  const [f, setF] = useState({ name: '', mobile: '', company: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setF({ name: '', mobile: '', company: '' }); setErr(''); } }, [open]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { onDone(await api(`/api/groups/${groupId}/walk-in`, { method: 'POST', body: f })); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} label="Add a walk-in">
      <form onSubmit={submit}>
        <div className="dialog-head"><h2>Add a walk-in</h2><p>Someone with this group who is not on the list. They are added and let in.</p></div>
        <div className="dialog-body">
          <label className="field"><span>Name</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={80} /></label>
          <label className="field"><span>Mobile <span className="faint">· optional</span></span><input className="input num" inputMode="numeric" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} maxLength={15} /></label>
          <label className="field"><span>Company or side <span className="faint">· optional</span></span><input className="input" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} maxLength={80} /></label>
          {err && <div className="alert alert-bad" role="alert"><Info /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-success" disabled={busy || f.name.trim().length < 2}>{busy ? <Spinner /> : <LogIn />}Add and let in</button>
        </div>
      </form>
    </Modal>
  );
}
