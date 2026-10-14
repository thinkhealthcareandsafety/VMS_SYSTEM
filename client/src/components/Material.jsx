import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Camera, Check, CheckCircle2, Download, LogIn, LogOut, Package, Plus,
  RotateCcw, Search, Send, Trash2, Truck, Undo2, X,
} from 'lucide-react';
import { api, fmtDate, fmtDateTime, fmtMobile, today } from '../api.js';
import HostPicker from './HostPicker.jsx';
import ImageViewer from './ImageViewer.jsx';
import { Empty, Modal, Spinner, useToast } from './ui.jsx';

// Material at the gate: what comes in (deliveries, contractor tools) and goes out on a gate pass (returnable or
// not, approved by a head first). One board for the guard desk and the admin console; admins also decide and export.
const UNITS = ['nos', 'pcs', 'box', 'carton', 'set', 'pair', 'kg', 'g', 'litre', 'ml', 'metre', 'roll', 'bag', 'drum', 'bundle', 'packet'];
const TONE = {
  pending: 'badge-warn', approved: 'badge-live', rejected: 'badge-bad', cancelled: '', out: 'badge-ok', partly_returned: 'badge-warn',
  returned: '', received: 'badge-live', handed_over: '', closed: '',
};
const VIEWS = [
  ['pending', 'Waiting approval'], ['ready', 'Ready to go out'], ['out', 'Out, due back'], ['overdue', 'Overdue'],
  ['inside', 'Tools inside'], ['inward', 'All inward'], ['outward', 'All outward'],
];
const addDays = (ymd, n) => { const t = new Date(`${ymd}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const itemsLine = (m) => m.items.map((i) => `${i.qty} ${i.unit} ${i.name}`).join(', ');
const partyLine = (p) => [p?.name, p?.company].filter(Boolean).join(', ');

export function StatusBadge({ m }) {
  if (m.overdue) return <span className="badge badge-bad">Overdue</span>;
  return <span className={`badge ${TONE[m.status] || ''}`}>{m.statusLabel}</span>;
}

// ----------------------------------------------------------------------------- the board
export default function MaterialBoard({ admin = false, liveTick = 0 }) {
  const toast = useToast();
  const [view, setView] = useState(admin ? 'pending' : 'ready');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);       // 'in' | 'out'
  const [openId, setOpenId] = useState(null);

  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    const p = new URLSearchParams({ ...(term ? { q: term } : { view }) });
    api(`/api/material?${p}`).then(setData).catch(() => setData({ rows: [], counts: {} }));
  }, [view, term]);
  useEffect(() => { load(); }, [load, liveTick]);
  const c = data?.counts || {};
  const count = { pending: c.pending, ready: c.ready, out: c.out, overdue: c.overdue, inside: c.inside };

  return (
    <section className="panel material-board">
      <div className="toolbar">
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pass no., party, item, serial, vehicle, DC / invoice" aria-label="Search material" /></div>
        <span className="spacer-x" />
        <button className="btn btn-sm" onClick={() => setForm('in')}><ArrowDownToLine />Goods coming in</button>
        <button className="btn btn-sm btn-primary" onClick={() => setForm('out')}><ArrowUpFromLine />Gate pass to send out</button>
        {admin && <a className="btn btn-sm" href={`/api/material/export.xlsx?${new URLSearchParams(term ? { q: term } : { view })}`}><Download />Excel</a>}
      </div>
      {!term && (
        <div className="material-views" role="tablist" aria-label="Registers">
          {VIEWS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={view === k} className={k === 'overdue' && count.overdue ? 'hot' : ''} onClick={() => setView(k)}>
              {l}{count[k] ? <span className="n">{count[k]}</span> : null}
            </button>
          ))}
        </div>
      )}
      {!data ? <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 140, borderRadius: 12 }} /></div> : data.rows.length === 0 ? (
        <Empty icon={term ? Search : Package} title={term ? 'Nothing matches' : 'Nothing here'}>
          {term ? 'Try the pass number, the company or a serial number.' : 'Passes appear here as they move through the gate.'}
        </Empty>
      ) : (
        <ul className="material-list">
          {data.rows.map((m) => (
            <li key={m.id}>
              <button type="button" className="material-row" onClick={() => setOpenId(m.id)}>
                <span className={`material-dir ${m.direction}`}>{m.direction === 'out' ? <ArrowUpFromLine /> : <ArrowDownToLine />}</span>
                <span className="material-main">
                  <span className="material-top"><strong className="mono">{m.number}</strong><span className="faint">{m.kindLabel}</span><StatusBadge m={m} /></span>
                  <span className="material-what">{itemsLine(m)}</span>
                  <span className="faint">
                    {partyLine(m.party)}{m.department ? ` · ${m.department}` : ''}{m.vehicle?.number ? ` · ${m.vehicle.number}` : ''}
                    {m.returnBy && ['out', 'partly_returned', 'approved', 'pending'].includes(m.status) ? ` · back by ${fmtDate(`${m.returnBy}T12:00:00+05:30`)}` : ''}
                    {` · ${fmtDateTime(m.createdAt)}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <MaterialForm direction={form} admin={admin} units={data?.units || UNITS} onClose={() => setForm(null)}
        onDone={(m) => {
          setForm(null);
          toast(m.direction === 'in' ? `${m.number} recorded.` : m.status === 'approved' ? `${m.number} approved.` : m.approvalSentBy ? `${m.number} sent to ${m.approver?.name} for approval.` : `${m.number} raised. ${m.approver?.name} cannot be reached by WhatsApp, Telegram or email: an admin must approve it.`, m.direction === 'out' && !m.approvalSentBy && m.status === 'pending' ? 'info' : 'ok');
          load();
          setOpenId(m.id);
        }} />
      <MaterialDetail id={openId} admin={admin} liveTick={liveTick} onClose={() => setOpenId(null)} onChanged={load} />
    </section>
  );
}

// ----------------------------------------------------------------------------- photos (taken or chosen, kept small)
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read')); };
    img.src = url;
  });
}

// ----------------------------------------------------------------------------- new pass / entry
const blankItem = () => ({ name: '', qty: '1', unit: 'nos', serial: '' });
function MaterialForm({ direction, admin, units, onClose, onDone }) {
  const open = Boolean(direction);
  const [f, setF] = useState(null);
  const [approver, setApprover] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    setF({
      kind: direction === 'out' ? 'returnable' : 'delivery', items: [blankItem()], party: { name: '', company: '', mobile: '' }, department: '', purpose: '', note: '',
      vehicle: { number: '', driver: '', driverMobile: '', transporter: '' }, docs: { dc: '', invoice: '', po: '', eway: '' }, returnBy: addDays(today(), 7), approveNow: false,
    });
    setApprover(null); setPhotos([]); setErr('');
  }, [open, direction]);
  if (!open || !f) return <Modal open={false} onClose={onClose} label="Material" />;

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setIn = (k, sub, v) => setF((x) => ({ ...x, [k]: { ...x[k], [sub]: v } }));
  const setItem = (i, k, v) => setF((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) }));
  const out = direction === 'out';
  const addPhoto = async (file) => {
    if (!file) return;
    try { const d = await shrink(file); setPhotos((p) => [...p, d].slice(0, 3)); } catch (e) { setErr(e.message); }
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const body = {
        ...f, direction, approverId: approver?.id, photos,
        items: f.items.filter((it) => it.name.trim()).map((it) => ({ ...it, qty: Number(it.qty) })),
        returnBy: f.kind === 'returnable' ? f.returnBy : undefined,
        party: { ...f.party, mobile: f.party.mobile || undefined }, vehicle: { ...f.vehicle, driverMobile: f.vehicle.driverMobile || undefined },
      };
      onDone(await api('/api/material', { method: 'POST', body }));
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} className="dialog dialog-wide" label={out ? 'Gate pass to send out' : 'Goods coming in'}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2>{out ? 'Gate pass to send material out' : 'Goods coming in'}</h2>
          <p>{out ? 'The head of department approves it on WhatsApp or Telegram; the gate lets it out only after that.' : 'Recorded with this gate, your name and the time.'}</p>
        </div>
        <div className="dialog-body">
          <div className="seg" role="radiogroup" aria-label="Type">
            {(out ? [['returnable', 'Returnable (comes back)'], ['non_returnable', 'Non-returnable']] : [['delivery', 'Delivery'], ['returnable_in', 'Tools brought in (go back out)']]).map(([k, l]) => (
              <button type="button" key={k} role="radio" aria-checked={f.kind === k} aria-pressed={f.kind === k} onClick={() => set('kind', k)}>{l}</button>
            ))}
          </div>

          <div className="field">
            <span>Items</span>
            <div className="items-editor">
              {f.items.map((it, i) => (
                <div className="item-row" key={i}>
                  <input className="input" placeholder="Item, e.g. Split AC compressor" value={it.name} onChange={(e) => setItem(i, 'name', e.target.value)} maxLength={120} aria-label={`Item ${i + 1}`} />
                  <input className="input num" type="number" min="0" step="any" value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} aria-label="Quantity" />
                  <select className="select" value={it.unit} onChange={(e) => setItem(i, 'unit', e.target.value)} aria-label="Unit">{units.map((u) => <option key={u}>{u}</option>)}</select>
                  <input className="input" placeholder="Serial / tag" value={it.serial} onChange={(e) => setItem(i, 'serial', e.target.value)} maxLength={60} aria-label="Serial or asset tag" />
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={f.items.length === 1} onClick={() => set('items', f.items.filter((_, j) => j !== i))} aria-label="Remove item"><Trash2 /></button>
                </div>
              ))}
              <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} disabled={f.items.length >= 50} onClick={() => set('items', [...f.items, blankItem()])}><Plus />Add item</button>
            </div>
          </div>

          <div className="grid-2">
            <label className="field"><span>{out ? 'Taken by (name)' : 'Brought by (name)'}</span><input className="input" value={f.party.name} onChange={(e) => setIn('party', 'name', e.target.value)} maxLength={80} /></label>
            <label className="field"><span>{out ? 'Company / sent to' : 'Supplier / company'}</span><input className="input" value={f.party.company} onChange={(e) => setIn('party', 'company', e.target.value)} maxLength={100} /></label>
            <label className="field"><span>Their mobile <span className="faint">· optional</span></span><input className="input num" inputMode="numeric" value={f.party.mobile} onChange={(e) => setIn('party', 'mobile', e.target.value)} maxLength={15} /></label>
            <label className="field"><span>Department</span><input className="input" value={f.department} onChange={(e) => set('department', e.target.value)} placeholder="Engineering, Housekeeping, Kitchen…" maxLength={60} /></label>
          </div>
          <label className="field"><span>Purpose <span className="faint">· optional</span></span><input className="input" value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder={out ? 'Repair, servicing, scrap sale, transfer…' : 'Purchase order supply, sample…'} maxLength={120} /></label>
          {f.kind === 'returnable' && (
            <label className="field" style={{ maxWidth: 240 }}><span>Must come back by</span><input className="input" type="date" min={today()} value={f.returnBy} onChange={(e) => set('returnBy', e.target.value)} /></label>
          )}

          <details className="more-fields">
            <summary><Truck size={15} /> Vehicle and documents <span className="faint">· optional</span></summary>
            <div className="grid-2">
              <label className="field"><span>Vehicle number</span><input className="input mono" value={f.vehicle.number} onChange={(e) => setIn('vehicle', 'number', e.target.value.toUpperCase())} placeholder="MH 12 AB 1234" maxLength={20} /></label>
              <label className="field"><span>Driver</span><input className="input" value={f.vehicle.driver} onChange={(e) => setIn('vehicle', 'driver', e.target.value)} maxLength={80} /></label>
              <label className="field"><span>Driver mobile</span><input className="input num" inputMode="numeric" value={f.vehicle.driverMobile} onChange={(e) => setIn('vehicle', 'driverMobile', e.target.value)} maxLength={15} /></label>
              <label className="field"><span>Transporter</span><input className="input" value={f.vehicle.transporter} onChange={(e) => setIn('vehicle', 'transporter', e.target.value)} maxLength={80} /></label>
              <label className="field"><span>Delivery challan no.</span><input className="input mono" value={f.docs.dc} onChange={(e) => setIn('docs', 'dc', e.target.value)} maxLength={40} /></label>
              <label className="field"><span>Invoice no.</span><input className="input mono" value={f.docs.invoice} onChange={(e) => setIn('docs', 'invoice', e.target.value)} maxLength={40} /></label>
              <label className="field"><span>PO no.</span><input className="input mono" value={f.docs.po} onChange={(e) => setIn('docs', 'po', e.target.value)} maxLength={40} /></label>
              <label className="field"><span>E-way bill no.</span><input className="input mono" value={f.docs.eway} onChange={(e) => setIn('docs', 'eway', e.target.value)} maxLength={40} /></label>
            </div>
          </details>

          <div className="field">
            <span>Photos <span className="faint">· material, challan, vehicle (up to 3)</span></span>
            <div className="photo-strip">
              {photos.map((p, i) => (
                <span key={i} className="photo-thumb"><img src={p} alt={`Photo ${i + 1}`} /><button type="button" onClick={() => setPhotos(photos.filter((_, j) => j !== i))} aria-label="Remove photo"><X /></button></span>
              ))}
              {photos.length < 3 && <button type="button" className="photo-add" onClick={() => fileRef.current?.click()}><Camera />Add photo</button>}
              <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addPhoto(e.target.files[0]); e.target.value = ''; }} />
            </div>
          </div>

          {out && (
            <>
              <div className="field"><span>Approved by (head of department)</span><HostPicker value={approver} onChange={setApprover} /></div>
              {admin && (
                <label className="checkbox" style={{ fontSize: 14 }}>
                  <input type="checkbox" checked={f.approveNow} onChange={(e) => set('approveNow', e.target.checked)} />
                  <span>I approve it now, on the head’s behalf <span className="faint">(recorded with your name)</span></span>
                </label>
              )}
            </>
          )}
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !f.items.some((it) => it.name.trim()) || (out && !approver)}>
            {busy ? <Spinner /> : out ? <Send /> : <Check />}{out ? (f.approveNow ? 'Raise approved pass' : 'Send for approval') : 'Record entry'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- one pass
function MaterialDetail({ id, admin, liveTick, onClose, onChanged }) {
  const toast = useToast();
  const [m, setM] = useState(null);
  const [busy, setBusy] = useState('');
  const [returning, setReturning] = useState(false);
  const [handTo, setHandTo] = useState('');
  const [zoom, setZoom] = useState(null);
  const [confirm, setConfirm] = useState('');
  const load = useCallback(() => { if (id) api(`/api/material/${id}`).then(setM).catch((e) => toast(e.message, 'bad')); }, [id, toast]);
  useEffect(() => { setM(null); setReturning(false); setHandTo(''); setConfirm(''); load(); }, [load]);
  useEffect(() => { if (id && liveTick) load(); }, [liveTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (path, body, msg) => {
    setBusy(path);
    try { setM(await api(`/api/material/${id}/${path}`, { method: 'POST', body })); toast(msg); setConfirm(''); onChanged(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(''); }
  };
  const decide = async (decision) => {
    setBusy(decision);
    try { await api(`/api/material/${id}/decision`, { method: 'POST', body: { decision } }); toast(decision === 'approve' ? 'Approved.' : 'Declined.'); load(); onChanged(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(''); }
  };
  const resend = async () => {
    setBusy('resend');
    try { const r = await api(`/api/material/${id}/resend`, { method: 'POST' }); toast(r.approvalSentBy ? `Sent again by ${({ whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'email' })[r.approvalSentBy]}.` : 'The approver cannot be reached by WhatsApp, Telegram or email. An admin must decide.', r.approvalSentBy ? 'ok' : 'info'); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(''); }
  };

  return (
    <Modal open={Boolean(id)} onClose={onClose} className="drawer" label="Material pass">
      <div className="drawer-head">
        <strong>{m ? `${m.number} · ${m.kindLabel}` : 'Material'}</strong>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="drawer-body">
        {!m ? <div className="skeleton" style={{ height: 200, borderRadius: 12 }} /> : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusBadge m={m} />
              {m.returnBy && <span className={`badge ${m.overdue ? 'badge-bad' : ''}`}>Back by {fmtDate(`${m.returnBy}T12:00:00+05:30`)}</span>}
            </div>
            {m.status === 'pending' && <div className="alert alert-warn"><AlertTriangle /><span className="grow">Waiting for {m.approver?.name || 'the approver'}. Do not let this material out yet.</span></div>}
            {m.status === 'rejected' && <div className="alert alert-bad"><X /><span className="grow">Declined by {m.decidedBy}{m.decisionNote ? `: ${m.decisionNote}` : ''}. Do not let this material out.</span></div>}
            {m.status === 'approved' && <div className="alert alert-ok"><CheckCircle2 /><span className="grow">Approved by {m.decidedBy}. Check the items below against the material, then let it out.</span></div>}

            <table className="table items-table">
              <thead><tr><th>Item</th><th className="r">Qty</th>{m.kind === 'returnable' && <th className="r">Back</th>}<th>Serial / tag</th></tr></thead>
              <tbody>
                {m.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td><td className="r num">{i.qty} {i.unit}</td>
                    {m.kind === 'returnable' && <td className={`r num ${i.returnedQty < i.qty ? 'tone-warn' : ''}`}>{i.returnedQty}</td>}
                    <td className="mono">{i.serial || <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <dl className="dl">
              <dt>{m.direction === 'out' ? 'Going to' : 'From'}</dt><dd>{partyLine(m.party) || '—'}{m.party?.mobile ? ` · ${fmtMobile(m.party.mobile)}` : ''}</dd>
              {m.department && <><dt>Department</dt><dd>{m.department}</dd></>}
              {m.purpose && <><dt>Purpose</dt><dd>{m.purpose}</dd></>}
              {m.approver && <><dt>Approver</dt><dd>{m.approver.name}, {m.approver.unit}</dd></>}
              {m.decidedBy && <><dt>Decided</dt><dd>{m.decidedBy} · {fmtDateTime(m.decidedAt)}</dd></>}
              {(m.vehicle?.number || m.vehicle?.driver) && <><dt>Vehicle</dt><dd>{[m.vehicle.number, m.vehicle.driver, m.vehicle.driverMobile && fmtMobile(m.vehicle.driverMobile), m.vehicle.transporter].filter(Boolean).join(' · ')}</dd></>}
              {Object.values(m.docs || {}).some(Boolean) && <><dt>Documents</dt><dd className="mono">{[m.docs.dc && `DC ${m.docs.dc}`, m.docs.invoice && `Inv ${m.docs.invoice}`, m.docs.po && `PO ${m.docs.po}`, m.docs.eway && `EWB ${m.docs.eway}`].filter(Boolean).join(' · ')}</dd></>}
              {m.handedTo && <><dt>Handed to</dt><dd>{m.handedTo} · {fmtDateTime(m.handedAt)}</dd></>}
              <dt>Raised</dt><dd>{m.createdBy} · {fmtDateTime(m.createdAt)}</dd>
            </dl>

            {m.photos.length > 0 && (
              <div className="photo-strip">{m.photos.map((src, i) => <button type="button" key={src} className="photo-thumb" onClick={() => setZoom(src)}><img src={src} alt={`Photo ${i + 1}`} /></button>)}</div>
            )}
            {m.movements.length > 0 && (
              <div>
                <h3 className="section-title">Through the gate</h3>
                <ol className="moves">
                  {m.movements.map((x, i) => (
                    <li key={i} className={`move move-${x.kind}`}>
                      <span className="move-kind">{x.kind === 'in' ? <LogIn /> : <LogOut />}{x.kind === 'in' ? 'In' : 'Out'}</span>
                      <span className="move-where"><strong>{x.gate || '—'}</strong>{x.by && <span className="faint"> · {x.by}</span>}</span>
                      <span className="num move-when">{fmtDateTime(x.at)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {returning && <ReturnForm m={m} busy={busy === 'return'} onCancel={() => setReturning(false)} onSave={(items, note) => act('return', { items, note }, 'Return recorded.').then(() => setReturning(false))} />}
            {m.kind === 'delivery' && m.status === 'received' && (
              <div className="field">
                <span>Hand over to (stores / receiving)</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" value={handTo} onChange={(e) => setHandTo(e.target.value)} placeholder="Name of the person who took it" maxLength={80} />
                  <button className="btn" disabled={busy || handTo.trim().length < 2} onClick={() => act('hand-over', { to: handTo }, 'Handed over.')}><Check />Done</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {m && (
        <div className="drawer-foot">
          {admin && m.status === 'pending' && <button className="btn btn-danger-outline" disabled={Boolean(busy)} onClick={() => decide('reject')}><X />Decline</button>}
          {admin && m.status === 'pending' && <button className="btn btn-success" disabled={Boolean(busy)} onClick={() => decide('approve')}><Check />Approve</button>}
          {m.status === 'pending' && <button className="btn" disabled={Boolean(busy)} onClick={resend}><RotateCcw />Send again</button>}
          {['pending', 'approved'].includes(m.status) && (confirm === 'cancel'
            ? <button className="btn btn-danger" disabled={Boolean(busy)} onClick={() => act('cancel', {}, 'Pass cancelled.')}>Cancel pass?</button>
            : <button className="btn btn-ghost" onClick={() => setConfirm('cancel')}>Cancel pass</button>)}
          {((m.status === 'approved') || (m.kind === 'returnable_in' && m.status === 'received')) && (confirm === 'out'
            ? <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => act('let-out', {}, `${m.number} let out.`)}>{busy ? <Spinner /> : <CheckCircle2 />}Items checked: let out</button>
            : <button className="btn btn-primary" onClick={() => setConfirm('out')}><LogOut />Let out</button>)}
          {m.kind === 'returnable' && ['out', 'partly_returned'].includes(m.status) && !returning && <button className="btn btn-primary" onClick={() => setReturning(true)}><Undo2 />Record return</button>}
        </div>
      )}
      <ImageViewer open={Boolean(zoom)} onClose={() => setZoom(null)} src={zoom} alt="Material photo" title={m?.number} />
    </Modal>
  );
}

function ReturnForm({ m, busy, onCancel, onSave }) {
  const [qty, setQty] = useState(() => Object.fromEntries(m.items.map((i) => [i.id, String(Math.max(0, i.qty - i.returnedQty))])));
  const [note, setNote] = useState('');
  return (
    <div className="return-form">
      <h3 className="section-title">What came back</h3>
      {m.items.filter((i) => i.returnedQty < i.qty).map((i) => (
        <label key={i.id} className="return-line">
          <span className="grow">{i.name}<span className="faint"> · {i.qty - i.returnedQty} {i.unit} still out</span></span>
          <input className="input num" type="number" min="0" step="any" max={i.qty - i.returnedQty} value={qty[i.id]} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} aria-label={`${i.name} returned`} />
        </label>
      ))}
      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note, e.g. one compressor still under repair" maxLength={200} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => onSave(Object.entries(qty).map(([item, q]) => ({ item, qty: Number(q) || 0 })), note)}>{busy ? <Spinner /> : <Check />}Record return</button>
      </div>
    </div>
  );
}
