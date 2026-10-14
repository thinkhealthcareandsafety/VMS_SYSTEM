import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, BellRing, Camera, Check, CheckCircle2, Download, KeyRound, Lock, LogIn, LogOut,
  Mail, Package, Search, Send, ShieldAlert, Truck, Undo2, UserRound, X,
} from 'lucide-react';
import { api, fmtDateTime, fmtMobile } from '../api.js';
import DigitBoxes from './DigitBoxes.jsx';
import HostPicker from './HostPicker.jsx';
import ImageViewer from './ImageViewer.jsx';
import { Empty, Modal, Spinner, useToast } from './ui.jsx';

// Couriers at the gate: parcels that arrive for someone (logged, the person is told a pickup code, handed over
// with it) and parcels a department sends out. One board for the guard desk and the admin console.
const CARRIERS = ['Blue Dart', 'Delhivery', 'DTDC', 'India Post', 'Amazon', 'Ekart (Flipkart)', 'XpressBees', 'Shadowfax', 'Ecom Express', 'Professional Couriers', 'Shree Maruti', 'Trackon', 'Gati', 'FedEx', 'DHL', 'UPS', 'Aramex', 'By hand', 'Other'];
const TYPES = [['document', 'Document'], ['parcel', 'Parcel'], ['large', 'Large item'], ['perishable', 'Perishable'], ['confidential', 'Confidential']];
const TONE = { received: 'badge-live', collected: '', forwarded: '', returned: 'badge-warn', booked: 'badge-warn', dispatched: 'badge-ok', void: '' };
const VIEWS = [['waiting', 'Waiting for pickup'], ['aging', 'Waiting 3+ days'], ['outgoing', 'To dispatch'], ['done', 'Handed over today'], ['inward', 'All incoming'], ['outward', 'All outgoing']];
const who = (p) => (p.recipient.kind === 'host' ? `${p.recipient.name}, ${p.recipient.unit}` : [p.recipient.name, p.recipient.room && `Room ${p.recipient.room}`, p.department].filter(Boolean).join(', '));

function Badge({ p }) {
  if (p.aging) return <span className="badge badge-bad">Waiting 3+ days</span>;
  return <span className={`badge ${TONE[p.status] || ''}`}>{p.statusLabel}</span>;
}

export default function CourierBoard({ admin = false, liveTick = 0 }) {
  const toast = useToast();
  const [view, setView] = useState('waiting');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    api(`/api/parcels?${new URLSearchParams(term ? { q: term } : { view })}`).then(setData).catch(() => setData({ rows: [], counts: {} }));
  }, [view, term]);
  useEffect(() => { load(); }, [load, liveTick]);
  const c = data?.counts || {};

  return (
    <section className="panel material-board">
      <div className="toolbar">
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="AWB, name, room, sender, courier" aria-label="Search couriers" /></div>
        <span className="spacer-x" />
        <button className="btn btn-sm btn-primary" onClick={() => setForm('in')}><ArrowDownToLine />Parcel arrived</button>
        <button className="btn btn-sm" onClick={() => setForm('out')}><ArrowUpFromLine />Send a parcel</button>
        {admin && <a className="btn btn-sm" href={`/api/parcels/export.xlsx?${new URLSearchParams(term ? { q: term } : { view })}`}><Download />Excel</a>}
      </div>
      {!term && (
        <div className="material-views" role="tablist" aria-label="Registers">
          {VIEWS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={view === k} className={k === 'aging' && c.aging ? 'hot' : ''} onClick={() => setView(k)}>
              {l}{{ waiting: c.waiting, aging: c.aging, outgoing: c.outgoing }[k] ? <span className="n">{{ waiting: c.waiting, aging: c.aging, outgoing: c.outgoing }[k]}</span> : null}
            </button>
          ))}
        </div>
      )}
      {!data ? <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 140, borderRadius: 12 }} /></div> : data.rows.length === 0 ? (
        <Empty icon={term ? Search : Mail} title={term ? 'Nothing matches' : 'Nothing here'}>{term ? 'Try the AWB, the name or the room.' : 'Parcels appear here as they arrive and leave.'}</Empty>
      ) : (
        <ul className="material-list">
          {data.rows.map((p) => (
            <li key={p.id}>
              <button type="button" className="material-row" onClick={() => setOpenId(p.id)}>
                <span className={`material-dir ${p.direction}`}>{p.direction === 'out' ? <ArrowUpFromLine /> : <ArrowDownToLine />}</span>
                <span className="material-main">
                  <span className="material-top"><strong className="mono">{p.number}</strong><span className="faint">{p.carrier}{p.awb ? ` · ${p.awb}` : ''}</span><Badge p={p} /></span>
                  <span className="material-what">{p.direction === 'in' ? 'For ' : 'From '}{who(p)}</span>
                  <span className="faint">{p.pieces > 1 ? `${p.pieces} pieces · ` : ''}{p.typeLabel}{p.sender?.company || p.sender?.name ? ` · from ${[p.sender.company, p.sender.name].filter(Boolean).join(', ')}` : ''} · {fmtDateTime(p.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ParcelForm direction={form} carriers={data?.carriers || CARRIERS} onClose={() => setForm(null)}
        onDone={(p) => {
          setForm(null);
          toast(p.direction === 'out' ? `${p.number} ready to dispatch.` : p.notifiedVia ? `${p.number} logged. ${p.recipient.name} has been sent a pickup code.` : `${p.number} logged. ${p.recipient.kind === 'host' ? `${p.recipient.name} cannot be reached on WhatsApp or Telegram: call them.` : 'No one to notify: hand it to the desk or room.'}`, p.direction === 'in' && !p.notifiedVia ? 'info' : 'ok');
          load();
        }} />
      <ParcelDetail id={openId} admin={admin} liveTick={liveTick} onClose={() => setOpenId(null)} onChanged={load} />
    </section>
  );
}

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

// ----------------------------------------------------------------------------- log a parcel
function ParcelForm({ direction, carriers, onClose, onDone }) {
  const open = Boolean(direction);
  const [f, setF] = useState(null);
  const [host, setHost] = useState(null);
  const [someoneElse, setSomeoneElse] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  const awbRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    setF({ carrier: '', awb: '', pieces: '1', type: direction === 'out' ? 'document' : 'parcel', sender: { name: '', company: '' }, person: { name: '', room: '', mobile: '' }, department: '', address: '', note: '' });
    setHost(null); setSomeoneElse(false); setPhotos([]); setErr('');
  }, [open, direction]);
  if (!open || !f) return <Modal open={false} onClose={onClose} label="Courier" />;
  const out = direction === 'out';
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setIn = (k, sub, v) => setF((x) => ({ ...x, [k]: { ...x[k], [sub]: v } }));
  const addPhoto = async (file) => { if (!file) return; try { const d = await shrink(file); setPhotos((p) => [...p, d].slice(0, 2)); } catch (e) { setErr(e.message); } };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      onDone(await api('/api/parcels', {
        method: 'POST',
        body: { ...f, direction, pieces: Number(f.pieces) || 1, hostId: someoneElse ? undefined : host?.id, person: someoneElse ? { ...f.person, mobile: f.person.mobile || undefined } : undefined, photos },
      }));
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const ready = (out ? (f.address.trim() || (someoneElse ? f.person.name.trim() : host)) : f.carrier) && (someoneElse ? f.person.name.trim() || f.department.trim() : host);

  return (
    <Modal open={open} onClose={onClose} className="dialog dialog-wide" label={out ? 'Send a parcel' : 'Parcel arrived'}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2>{out ? 'Send a parcel' : 'Parcel arrived'}</h2>
          <p>{out ? 'Logged now; marked dispatched when the courier’s agent takes it.' : 'The person gets a WhatsApp or Telegram message with a pickup code. Whoever collects it must give that code.'}</p>
        </div>
        <div className="dialog-body">
          {!out && (
            <div className="field">
              <span>Courier</span>
              <div className="chips">{carriers.map((cr) => <button type="button" key={cr} className="chip" aria-pressed={f.carrier === cr} onClick={() => { set('carrier', cr); setTimeout(() => awbRef.current?.focus(), 0); }}>{cr}</button>)}</div>
            </div>
          )}
          <div className="grid-2">
            {!out && <label className="field"><span>AWB / tracking no. <span className="faint">· scan or type</span></span><input ref={awbRef} className="input mono" value={f.awb} onChange={(e) => set('awb', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} maxLength={40} autoComplete="off" /></label>}
            <label className="field"><span>Pieces</span><input className="input num" type="number" min="1" max="500" value={f.pieces} onChange={(e) => set('pieces', e.target.value)} /></label>
          </div>
          <div className="field">
            <span>Type</span>
            <div className="chips">{TYPES.map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={f.type === k} onClick={() => set('type', k)}>{l}</button>)}</div>
          </div>

          <div className="field">
            <span>{out ? 'Sent by' : 'For'}</span>
            <div className="seg" role="radiogroup" aria-label="Recipient">
              <button type="button" role="radio" aria-checked={!someoneElse} aria-pressed={!someoneElse} onClick={() => setSomeoneElse(false)}><UserRound size={15} /> A person on the list</button>
              <button type="button" role="radio" aria-checked={someoneElse} aria-pressed={someoneElse} onClick={() => setSomeoneElse(true)}>Someone else (guest, department)</button>
            </div>
            {someoneElse ? (
              <div className="grid-2" style={{ marginTop: 8 }}>
                <label className="field"><span>Name</span><input className="input" value={f.person.name} onChange={(e) => setIn('person', 'name', e.target.value)} maxLength={80} /></label>
                <label className="field"><span>Room no. <span className="faint">· optional</span></span><input className="input mono" value={f.person.room} onChange={(e) => setIn('person', 'room', e.target.value)} maxLength={30} /></label>
                <label className="field"><span>Department <span className="faint">· optional</span></span><input className="input" value={f.department} onChange={(e) => set('department', e.target.value)} maxLength={60} /></label>
                <label className="field"><span>Mobile <span className="faint">· optional</span></span><input className="input num" inputMode="numeric" value={f.person.mobile} onChange={(e) => setIn('person', 'mobile', e.target.value)} maxLength={15} /></label>
              </div>
            ) : <div style={{ marginTop: 8 }}><HostPicker value={host} onChange={setHost} /></div>}
          </div>

          {out ? (
            <>
              <label className="field"><span>Send to (name and address)</span><textarea className="textarea" rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={300} /></label>
              {!someoneElse && <label className="field"><span>Department <span className="faint">· optional</span></span><input className="input" value={f.department} onChange={(e) => set('department', e.target.value)} maxLength={60} /></label>}
            </>
          ) : (
            <div className="grid-2">
              <label className="field"><span>Sender <span className="faint">· optional</span></span><input className="input" value={f.sender.company} onChange={(e) => setIn('sender', 'company', e.target.value)} placeholder="Amazon, HDFC Bank…" maxLength={100} /></label>
              <label className="field"><span>Note <span className="faint">· optional</span></span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Box damaged, cash on delivery…" maxLength={300} /></label>
            </div>
          )}

          {!out && (
            <div className="field">
              <span>Photo <span className="faint">· the label or the parcel</span></span>
              <div className="photo-strip">
                {photos.map((p, i) => <span key={i} className="photo-thumb"><img src={p} alt={`Photo ${i + 1}`} /><button type="button" onClick={() => setPhotos(photos.filter((_, j) => j !== i))} aria-label="Remove photo"><X /></button></span>)}
                {photos.length < 2 && <button type="button" className="photo-add" onClick={() => fileRef.current?.click()}><Camera />Add photo</button>}
                <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addPhoto(e.target.files[0]); e.target.value = ''; }} />
              </div>
            </div>
          )}
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !ready}>{busy ? <Spinner /> : out ? <Check /> : <Send />}{out ? 'Log parcel' : 'Log and notify'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- one parcel
function ParcelDetail({ id, admin, liveTick, onClose, onChanged }) {
  const toast = useToast();
  const [p, setP] = useState(null);
  const [mode, setMode] = useState(''); // collect | override | forward | return | dispatch | void
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [zoom, setZoom] = useState(null);
  const load = useCallback(() => { if (id) api(`/api/parcels/${id}`).then(setP).catch((e) => toast(e.message, 'bad')); }, [id, toast]);
  useEffect(() => { setP(null); setMode(''); setErr(''); load(); }, [load]);
  useEffect(() => { if (id && liveTick) load(); }, [liveTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (m) => { setMode(m); setErr(''); setF({ collector: p?.recipient?.kind === 'host' ? p.recipient.name : p?.recipient?.name || '', code: '', mobile: '', reason: '', to: '', agent: '', awb: '', carrier: p?.carrier || '' }); };

  const post = async (path, body, msg) => {
    setBusy(true); setErr('');
    try { setP(await api(`/api/parcels/${id}/${path}`, { method: 'POST', body })); toast(msg, 'ok'); setMode(''); onChanged(); } catch (e) {
      setErr(e.message);
      if (e.data?.locked) load();
    } finally { setBusy(false); }
  };
  const remind = async () => {
    setBusy(true);
    try { const r = await api(`/api/parcels/${id}/notify`, { method: 'POST' }); toast(`Reminder sent by ${r.via === 'whatsapp' ? 'WhatsApp' : 'Telegram'}.`, 'ok'); load(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <Modal open={Boolean(id)} onClose={onClose} className="drawer" label="Parcel">
      <div className="drawer-head">
        <strong>{p ? `${p.number} · ${p.carrier || 'Courier'}` : 'Parcel'}</strong>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="drawer-body">
        {!p ? <div className="skeleton" style={{ height: 200, borderRadius: 12 }} /> : (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Badge p={p} />{p.type === 'confidential' && <span className="badge badge-warn"><Lock size={12} /> Confidential</span>}{p.type === 'perishable' && <span className="badge badge-warn">Perishable</span>}</div>
            {p.status === 'received' && p.hasCode && (
              <div className={`alert ${p.codeLocked ? 'alert-bad' : 'alert-ok'}`}>
                {p.codeLocked ? <ShieldAlert /> : <KeyRound />}
                <span className="grow">{p.codeLocked ? 'Locked after too many wrong codes. Confirm with the recipient, then use an override.' : `${p.recipient.name} was sent a pickup code${p.notifiedVia ? ` by ${p.notifiedVia === 'whatsapp' ? 'WhatsApp' : 'Telegram'}` : ''}. Ask the collector for it.`}</span>
              </div>
            )}
            {p.status === 'received' && !p.hasCode && <div className="alert"><UserRound /><span className="grow">No pickup code for this person. Check the collector’s ID, or hand it to the front desk or the room.</span></div>}
            {p.status === 'received' && p.hasCode && !p.notifiedVia && <div className="alert alert-warn"><AlertTriangle /><span className="grow">The notice could not be sent. Call {p.recipient.name}.</span></div>}

            <dl className="dl">
              <dt>{p.direction === 'in' ? 'For' : 'From'}</dt><dd>{who(p)}{p.recipient.mobile ? ` · ${fmtMobile(p.recipient.mobile)}` : ''}</dd>
              <dt>Courier</dt><dd>{p.carrier || '—'}{p.awb ? <span className="mono"> · {p.awb}</span> : ''}</dd>
              <dt>What</dt><dd>{p.pieces} × {p.typeLabel}</dd>
              {(p.sender?.company || p.sender?.name) && <><dt>Sender</dt><dd>{[p.sender.company, p.sender.name].filter(Boolean).join(', ')}</dd></>}
              {p.address && <><dt>Send to</dt><dd style={{ whiteSpace: 'pre-line' }}>{p.address}</dd></>}
              {p.note && <><dt>Note</dt><dd>{p.note}</dd></>}
              <dt>Logged</dt><dd>{p.createdBy} · {fmtDateTime(p.createdAt)}</dd>
              {p.reminders > 0 && <><dt>Reminders</dt><dd>{p.reminders} sent</dd></>}
              {p.handover && <><dt>Handed to</dt><dd>{p.handover.to}{p.handover.mobile ? ` · ${fmtMobile(p.handover.mobile)}` : ''} · {fmtDateTime(p.handover.at)}<br /><span className="faint">{{ code: 'With the pickup code', override: 'Override', forward: 'Handed on', return: 'Returned', dispatch: 'Dispatched' }[p.handover.how]} · {p.handover.by}{p.handover.gate ? `, ${p.handover.gate}` : ''}{p.handover.reason ? ` · ${p.handover.reason}` : ''}</span></dd></>}
              {p.voidReason && <><dt>Voided</dt><dd>{p.voidReason}</dd></>}
            </dl>
            {p.photos.length > 0 && <div className="photo-strip">{p.photos.map((src, i) => <button type="button" key={src} className="photo-thumb" onClick={() => setZoom(src)}><img src={src} alt={`Photo ${i + 1}`} /></button>)}</div>}

            {mode === 'collect' && (
              <div className="return-form">
                <h3 className="section-title">Pickup code</h3>
                <DigitBoxes length={4} size="lg" value={f.code} onChange={(code) => setF({ ...f, code })} label="4-digit pickup code" invalid={Boolean(err)} autoFocus
                  onEnter={() => f.code.length === 4 && post('collect', { code: f.code, collector: f.collector, mobile: f.mobile || undefined }, 'Handed over.')} />
                <div className="grid-2">
                  <label className="field"><span>Collected by</span><input className="input" value={f.collector} onChange={set('collector')} maxLength={80} /></label>
                  <label className="field"><span>Their mobile <span className="faint">· optional</span></span><input className="input num" inputMode="numeric" value={f.mobile} onChange={set('mobile')} maxLength={15} /></label>
                </div>
                {err && <div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div>}
                <div className="row-end">
                  <button className="btn btn-ghost" onClick={() => start('override')}>No code?</button>
                  <button className="btn btn-primary" disabled={busy || f.code.length !== 4 || f.collector.trim().length < 2} onClick={() => post('collect', { code: f.code, collector: f.collector, mobile: f.mobile || undefined }, 'Handed over.')}>{busy ? <Spinner /> : <CheckCircle2 />}Hand over</button>
                </div>
              </div>
            )}
            {mode === 'override' && (
              <div className="return-form">
                <h3 className="section-title">Hand over without the code</h3>
                <p className="faint" style={{ fontSize: 13 }}>Only after confirming with the recipient (call them) and checking the collector’s ID. Recorded with your name.</p>
                <div className="grid-2">
                  <label className="field"><span>Collected by</span><input className="input" value={f.collector} onChange={set('collector')} maxLength={80} /></label>
                  <label className="field"><span>Their mobile</span><input className="input num" inputMode="numeric" value={f.mobile} onChange={set('mobile')} maxLength={15} /></label>
                </div>
                <label className="field"><span>Why no code</span><input className="input" value={f.reason} onChange={set('reason')} placeholder="e.g. Called Asha, she sent her assistant Ravi" maxLength={200} /></label>
                {err && <div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div>}
                <div className="row-end">
                  <button className="btn btn-ghost" onClick={() => setMode('')}>Cancel</button>
                  <button className="btn btn-danger" disabled={busy || f.reason.trim().length < 5 || f.collector.trim().length < 2} onClick={() => post('collect', { override: true, collector: f.collector, mobile: f.mobile, reason: f.reason }, 'Handed over by override.')}>{busy ? <Spinner /> : <ShieldAlert />}Hand over</button>
                </div>
              </div>
            )}
            {['forward', 'return', 'dispatch', 'void'].includes(mode) && (
              <div className="return-form">
                <h3 className="section-title">{{ forward: 'Hand to department / room', return: 'Return to the courier', dispatch: 'Courier agent takes it', void: 'Entered by mistake' }[mode]}</h3>
                {mode === 'forward' && <input className="input" value={f.to} onChange={set('to')} placeholder="e.g. Front desk, Priya / Room 1204 via bell desk" maxLength={80} autoFocus />}
                {mode === 'return' && <input className="input" value={f.reason} onChange={set('reason')} placeholder="Why, e.g. no such person, refused" maxLength={200} autoFocus />}
                {mode === 'void' && <input className="input" value={f.reason} onChange={set('reason')} placeholder="Why, e.g. scanned twice" maxLength={200} autoFocus />}
                {mode === 'dispatch' && (
                  <div className="grid-2">
                    <label className="field"><span>Agent’s name</span><input className="input" value={f.agent} onChange={set('agent')} maxLength={80} autoFocus /></label>
                    <label className="field"><span>Courier</span><select className="select" value={f.carrier} onChange={set('carrier')}><option value="">Choose</option>{CARRIERS.map((c) => <option key={c}>{c}</option>)}</select></label>
                    <label className="field"><span>AWB / tracking no.</span><input className="input mono" value={f.awb} onChange={set('awb')} maxLength={40} /></label>
                  </div>
                )}
                {err && <div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div>}
                <div className="row-end">
                  <button className="btn btn-ghost" onClick={() => setMode('')}>Cancel</button>
                  <button className={`btn ${mode === 'void' || mode === 'return' ? 'btn-danger' : 'btn-primary'}`} disabled={busy}
                    onClick={() => (mode === 'forward' ? post('forward', { to: f.to }, 'Handed on.') : mode === 'return' ? post('return', { reason: f.reason }, 'Returned to the courier.') : mode === 'void' ? post('void', { reason: f.reason }, 'Voided.') : post('dispatch', { agent: f.agent, carrier: f.carrier, awb: f.awb }, 'Dispatched.'))}>
                    {busy ? <Spinner /> : <Check />}Confirm
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {p && !mode && (
        <div className="drawer-foot">
          {admin && ['received', 'booked'].includes(p.status) && <button className="btn btn-ghost" onClick={() => start('void')}>Void</button>}
          {p.status === 'received' && <button className="btn btn-ghost" onClick={() => start('return')}><Undo2 />Return</button>}
          {p.status === 'received' && <button className="btn" onClick={() => start('forward')}><LogIn />To department / room</button>}
          {p.status === 'received' && p.hasCode && <button className="btn" disabled={busy} onClick={remind}><BellRing />Remind</button>}
          {p.status === 'received' && <button className="btn btn-primary" onClick={() => start(p.hasCode && !p.codeLocked ? 'collect' : 'override')}><Package />Hand over</button>}
          {p.status === 'booked' && <button className="btn btn-primary" onClick={() => start('dispatch')}><Truck />Courier took it</button>}
        </div>
      )}
      <ImageViewer open={Boolean(zoom)} onClose={() => setZoom(null)} src={zoom} alt="Parcel photo" title={p?.number} />
    </Modal>
  );
}
