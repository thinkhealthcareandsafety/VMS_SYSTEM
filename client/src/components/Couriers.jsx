import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, Printer, ArrowUpFromLine, Barcode, BellRing, Check, CheckCircle2, Download, Lock, Mail, Package, Search, Send, ShieldAlert,
  Truck, Undo2, UserRound, X, XCircle,
} from 'lucide-react';
import { DailyReportDialog } from './DailyReport.jsx';
import { api, fmtDateTime, fmtMobile } from '../api.js';
import HostPicker from './HostPicker.jsx';
import BarcodeScan, { carrierFromAwb } from './BarcodeScan.jsx';
import SignaturePad from './Signature.jsx';
import { PhotoPicker, PhotoRow } from './Photos.jsx';
import { Empty, Modal, Spinner, useToast } from './ui.jsx';

// Couriers at the gate. Incoming: logged with photos; the recipient sees them by email or Telegram and taps
// Accept or Decline; whoever collects it gives their name and number and is photographed, and the recipient is
// told who took it. Outgoing: a department hands it in, the courier's picker takes it and gives the docket number.
const CARRIERS = ['Blue Dart', 'Delhivery', 'DTDC', 'India Post', 'Amazon', 'Ekart (Flipkart)', 'XpressBees', 'Shadowfax', 'Ecom Express', 'Professional Couriers', 'Shree Maruti', 'Trackon', 'Gati', 'FedEx', 'DHL', 'UPS', 'Aramex', 'By hand', 'Other'];
const TYPES = [['document', 'Document'], ['parcel', 'Parcel'], ['large', 'Large item'], ['perishable', 'Perishable'], ['confidential', 'Confidential']];
const TONE = { received: 'badge-live', collected: '', forwarded: '', returned: 'badge-warn', booked: 'badge-warn', dispatched: 'badge-ok', void: '' };
const VIEWS = [['waiting', 'Waiting for pickup'], ['declined', 'Declined: return'], ['aging', 'Waiting 3+ days'], ['outgoing', 'To dispatch'], ['done', 'Handed over today'], ['inward', 'All incoming'], ['outward', 'All outgoing']];
const VIA = { whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'email', link: 'the link' };
const who = (p) => (p.recipient.kind === 'host' ? `${p.recipient.name}, ${p.recipient.unit}` : [p.recipient.name, p.recipient.room && `Room ${p.recipient.room}`, p.department].filter(Boolean).join(', '));

function Badge({ p }) {
  if (p.status === 'received' && p.response?.kind === 'declined') return <span className="badge badge-bad">Declined: return it</span>;
  if (p.aging) return <span className="badge badge-bad">Waiting 3+ days</span>;
  return <span className={`badge ${TONE[p.status] || ''}`}>{p.statusLabel}</span>;
}
function Answer({ p }) {
  if (p.direction !== 'in' || p.recipient.kind !== 'host') return null;
  if (p.response?.kind === 'accepted') return <span className="badge badge-ok"><CheckCircle2 size={12} /> Accepted</span>;
  if (p.response?.kind === 'declined') return null;
  return p.status === 'received' ? <span className="badge">{p.notifiedVia ? 'No answer yet' : 'Not reachable'}</span> : null;
}

export default function CourierBoard({ admin = false, liveTick = 0 }) {
  const toast = useToast();
  const [view, setView] = useState('waiting');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [report, setReport] = useState(false);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    api(`/api/parcels?${new URLSearchParams(term ? { q: term } : { view })}`).then(setData).catch(() => setData({ rows: [], counts: {} }));
  }, [view, term]);
  useEffect(() => { load(); }, [load, liveTick]);
  const c = data?.counts || {};
  const counted = { waiting: c.waiting, declined: c.declined, aging: c.aging, outgoing: c.outgoing };

  return (
    <section className="panel material-board">
      <div className="toolbar">
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="AWB, name, room, sender, courier" aria-label="Search couriers" /></div>
        <span className="spacer-x" />
        <button className="btn btn-sm btn-primary" onClick={() => setForm('in')}><ArrowDownToLine />Parcel arrived</button>
        <button className="btn btn-sm" onClick={() => setForm('out')}><ArrowUpFromLine />Send a parcel</button>
        {admin && <button className="btn btn-sm" onClick={() => setReport(true)}><Printer />Daily report</button>}
        {admin && <a className="btn btn-sm" href={`/api/parcels/export.xlsx?${new URLSearchParams(term ? { q: term } : { view })}`}><Download />Excel register</a>}
      </div>
      {!term && (
        <div className="material-views" role="tablist" aria-label="Registers">
          {VIEWS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={view === k} className={(k === 'aging' || k === 'declined') && counted[k] ? 'hot' : ''} onClick={() => setView(k)}>
              {l}{counted[k] ? <span className="n">{counted[k]}</span> : null}
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
                  <span className="material-top"><strong className="mono">{p.number}</strong><span className="faint">{p.carrier}{p.awb ? ` · ${p.awb}` : ''}</span><Badge p={p} /><Answer p={p} /></span>
                  <span className="material-what">{p.direction === 'in' ? `For ${who(p)}` : `To ${p.addressee || p.address}${p.recipient.name ? ` · from ${who(p)}` : ''}`}</span>
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
          toast(p.direction === 'out' ? `${p.number} logged. Press “Courier took it” when the picker comes.`
            : p.notifiedVia ? `${p.number} logged. ${p.recipient.name} has been sent the photos to accept or decline.`
              : `${p.number} logged. ${p.recipient.kind === 'host' ? `${p.recipient.name} cannot be reached by email or Telegram: call them.` : 'Nobody to ask: hand it to the desk or the room.'}`,
          p.direction === 'in' && !p.notifiedVia ? 'info' : 'ok');
          load();
        }} />
      <ParcelDetail id={openId} admin={admin} liveTick={liveTick} onClose={() => setOpenId(null)} onChanged={load} />
      <DailyReportDialog open={report} onClose={() => setReport(false)} />
    </section>
  );
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
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF({ carrier: '', awb: '', pieces: '1', type: direction === 'out' ? 'document' : 'parcel', sender: { name: '', company: '' }, person: { name: '', room: '', mobile: '' }, department: '', addressee: '', address: '', note: '' });
    setHost(null); setSomeoneElse(false); setPhotos([]); setErr('');
  }, [open, direction]);
  if (!open || !f) return <Modal open={false} onClose={onClose} label="Courier" />;
  const out = direction === 'out';
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setIn = (k, sub, v) => setF((x) => ({ ...x, [k]: { ...x[k], [sub]: v } }));
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
  const whom = someoneElse ? f.person.name.trim() || f.department.trim() : host;
  const missing = out
    ? (!whom ? 'who is sending it' : !f.addressee.trim() ? 'the name on the courier' : !f.address.trim() ? 'the address' : '')
    : (!f.carrier ? 'the courier' : !whom ? 'who it is for' : !photos.length ? 'a photo of the parcel' : '');

  return (
    <Modal open={open} onClose={onClose} className="dialog dialog-wide" label={out ? 'Send a parcel' : 'Parcel arrived'}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2>{out ? 'Send a parcel' : 'Parcel arrived'}</h2>
          <p>{out ? 'Logged now; marked dispatched when the courier’s picker takes it and gives the docket number.' : 'The person gets your photos by email and taps Accept or Decline.'}</p>
        </div>
        <div className="dialog-body">
          {!out && (
            <>
              <div className="field">
                <span>Photos <span className="faint">· the label and the parcel, up to 5</span></span>
                <PhotoPicker photos={photos} onChange={setPhotos} max={5} addLabel="Take photo" onError={setErr} />
              </div>
              <div className="field">
                <span>Courier</span>
                <div className="chips">{carriers.map((cr) => <button type="button" key={cr} className="chip" aria-pressed={f.carrier === cr} onClick={() => set('carrier', cr)}>{cr}</button>)}</div>
              </div>
            </>
          )}
          <div className="grid-2">
            {!out && (
              <div className="field">
                <span>AWB / tracking no. <span className="faint">· scan the label barcode, or type</span></span>
                <div className="awb-row">
                  <input className="input mono" value={f.awb} onChange={(e) => set('awb', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} maxLength={40} autoComplete="off" aria-label="AWB or tracking number" />
                  <button type="button" className="btn" onClick={() => setScanning(true)}><Barcode />Scan</button>
                </div>
              </div>
            )}
            <label className="field"><span>Pieces</span><input className="input num" type="number" min="1" max="500" value={f.pieces} onChange={(e) => set('pieces', e.target.value)} /></label>
          </div>
          <div className="field">
            <span>Type</span>
            <div className="chips">{TYPES.map(([k, l]) => <button type="button" key={k} className="chip" aria-pressed={f.type === k} onClick={() => set('type', k)}>{l}</button>)}</div>
          </div>

          <div className="field">
            <span>{out ? 'Sent by' : 'For (name on the courier)'}</span>
            <div className="seg" role="radiogroup" aria-label="Person">
              <button type="button" role="radio" aria-checked={!someoneElse} aria-pressed={!someoneElse} onClick={() => setSomeoneElse(false)}><UserRound size={15} /> A person on the list</button>
              <button type="button" role="radio" aria-checked={someoneElse} aria-pressed={someoneElse} onClick={() => setSomeoneElse(true)}>{out ? 'Someone else' : 'Someone else (guest, department)'}</button>
            </div>
            {someoneElse ? (
              <div className="grid-2" style={{ marginTop: 8 }}>
                <label className="field"><span>Name</span><input className="input" value={f.person.name} onChange={(e) => setIn('person', 'name', e.target.value)} maxLength={80} /></label>
                {!out && <label className="field"><span>Room no. <span className="faint">· optional</span></span><input className="input mono" value={f.person.room} onChange={(e) => setIn('person', 'room', e.target.value)} maxLength={30} /></label>}
                <label className="field"><span>Department <span className="faint">· optional</span></span><input className="input" value={f.department} onChange={(e) => set('department', e.target.value)} maxLength={60} /></label>
                {!out && <label className="field"><span>Mobile <span className="faint">· optional</span></span><input className="input num" inputMode="numeric" value={f.person.mobile} onChange={(e) => setIn('person', 'mobile', e.target.value)} maxLength={15} /></label>}
              </div>
            ) : <div style={{ marginTop: 8 }}><HostPicker value={host} onChange={setHost} /></div>}
          </div>

          {out ? (
            <>
              {!someoneElse && <label className="field"><span>Sender department <span className="faint">· optional</span></span><input className="input" value={f.department} onChange={(e) => set('department', e.target.value)} maxLength={60} /></label>}
              <label className="field"><span>Name on the courier (to)</span><input className="input" value={f.addressee} onChange={(e) => set('addressee', e.target.value)} maxLength={80} /></label>
              <label className="field"><span>Address</span><textarea className="textarea" rows={3} value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={300} /></label>
              <div className="field">
                <span>Photos <span className="faint">· optional, up to 5</span></span>
                <PhotoPicker photos={photos} onChange={setPhotos} max={5} onError={setErr} />
              </div>
              <label className="field"><span>Remarks <span className="faint">· optional</span></span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={300} /></label>
            </>
          ) : (
            <div className="grid-2">
              <label className="field"><span>From (sender) <span className="faint">· optional</span></span><input className="input" value={f.sender.company} onChange={(e) => setIn('sender', 'company', e.target.value)} placeholder="Amazon, HDFC Bank…" maxLength={100} /></label>
              <label className="field"><span>Remarks <span className="faint">· optional</span></span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Box damaged, cash on delivery…" maxLength={300} /></label>
            </div>
          )}
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <BarcodeScan open={scanning} onClose={() => setScanning(false)} onResult={(text) => {
          setScanning(false);
          const awb = text.replace(/\s+/g, '').toUpperCase().slice(0, 40);
          setF((x) => ({ ...x, awb, carrier: x.carrier || carrierFromAwb(awb) }));
        }} />
        <div className="dialog-foot">
          {missing && <span className="faint foot-hint">Add {missing} to continue.</span>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || Boolean(missing)}>{busy ? <Spinner /> : out ? <Check /> : <Send />}{out ? 'Log parcel' : 'Log and ask them'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- one parcel
function ParcelDetail({ id, admin, liveTick, onClose, onChanged }) {
  const toast = useToast();
  const [p, setP] = useState(null);
  const [mode, setMode] = useState(''); // handover | return | dispatch | void
  const [f, setF] = useState({});
  const [photos, setPhotos] = useState([]);
  const [signature, setSignature] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [scanning, setScanning] = useState(false);
  const load = useCallback(() => { if (id) api(`/api/parcels/${id}`).then(setP).catch((e) => toast(e.message, 'bad')); }, [id, toast]);
  useEffect(() => { setP(null); setMode(''); setErr(''); load(); }, [load]);
  useEffect(() => { if (id && liveTick) load(); }, [liveTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (m) => {
    setMode(m); setErr(''); setPhotos([]); setSignature(null);
    setF({ collector: '', mobile: '', note: '', reason: p?.response?.kind === 'declined' ? `Declined by ${p.response.by}` : '', agent: '', awb: '', carrier: p?.carrier || '' });
  };

  const post = async (path, body, msg) => {
    setBusy(true); setErr('');
    try {
      const r = await api(`/api/parcels/${id}/${path}`, { method: 'POST', body });
      setP(r); setMode(''); onChanged();
      toast(path === 'collect' ? (r.acknowledgedVia ? `Handed over. ${r.recipient.name} was told on ${VIA[r.acknowledgedVia]} who took it.` : 'Handed over.') : msg, 'ok');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remind = async () => {
    setBusy(true);
    try { const r = await api(`/api/parcels/${id}/notify`, { method: 'POST' }); toast(`Sent again by ${VIA[r.via]}.`, 'ok'); load(); } catch (e) { toast(e.message, 'bad'); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const waiting = p?.status === 'received';
  const declined = waiting && p.response?.kind === 'declined';
  const handoverReady = f.collector?.trim().length >= 2 && /^\+?[\d\s-]{10,15}$/.test(f.mobile || '') && Boolean(signature);

  return (
    <Modal open={Boolean(id)} onClose={onClose} className="drawer" label="Parcel">
      <div className="drawer-head">
        <strong>{p ? `${p.number} · ${p.carrier || 'Courier'}` : 'Parcel'}</strong>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="drawer-body">
        {!p ? <div className="skeleton" style={{ height: 200, borderRadius: 12 }} /> : (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Badge p={p} /><Answer p={p} />{p.type === 'confidential' && <span className="badge badge-warn"><Lock size={12} /> Confidential</span>}{p.type === 'perishable' && <span className="badge badge-warn">Perishable</span>}</div>
            {waiting && p.direction === 'in' && (
              declined ? <div className="alert alert-bad"><XCircle /><span className="grow">{p.response.by} declined it ({fmtDateTime(p.response.at)}): not theirs. Return it to the courier.</span></div>
                : p.response?.kind === 'accepted' ? <div className="alert alert-ok"><CheckCircle2 /><span className="grow">{p.response.by} accepted it ({fmtDateTime(p.response.at)}, on {VIA[p.response.via] || p.response.via}). Hand it over when they or their person come.</span></div>
                  : p.recipient.kind === 'host' && p.notifiedVia ? <div className="alert"><BellRing /><span className="grow">Sent to {p.recipient.name} on {VIA[p.notifiedVia]} at {fmtDateTime(p.notifiedAt)} with the photos. No answer yet.</span></div>
                    : p.recipient.kind === 'host' ? <div className="alert alert-warn"><AlertTriangle /><span className="grow">{p.recipient.name} cannot be reached by email or Telegram. Call them.</span></div>
                      : <div className="alert"><UserRound /><span className="grow">Nobody to ask. Hand it to the front desk or the room, with the receiver’s name, number and a photo.</span></div>
            )}

            <dl className="dl">
              <dt>{p.direction === 'in' ? 'For' : 'From'}</dt><dd>{who(p) || '—'}{p.recipient.mobile ? ` · ${fmtMobile(p.recipient.mobile)}` : ''}</dd>
              {p.addressee && <><dt>To</dt><dd>{p.addressee}</dd></>}
              {p.address && <><dt>Address</dt><dd style={{ whiteSpace: 'pre-line' }}>{p.address}</dd></>}
              <dt>Courier</dt><dd>{p.carrier || '—'}{p.awb ? <span className="mono"> · {p.awb}</span> : ''}</dd>
              <dt>What</dt><dd>{p.pieces} × {p.typeLabel}</dd>
              {(p.sender?.company || p.sender?.name) && <><dt>Sender</dt><dd>{[p.sender.company, p.sender.name].filter(Boolean).join(', ')}</dd></>}
              {p.note && <><dt>Remarks</dt><dd>{p.note}</dd></>}
              <dt>Logged</dt><dd>{p.createdBy} · {fmtDateTime(p.createdAt)}</dd>
              {p.reminders > 0 && <><dt>Reminders</dt><dd>{p.reminders} sent</dd></>}
              {p.handover && (
                <><dt>{p.handover.how === 'dispatch' ? 'Picked up by' : p.handover.how === 'return' ? 'Returned' : 'Handed to'}</dt>
                  <dd>{p.handover.to}{p.handover.mobile ? ` · ${fmtMobile(p.handover.mobile)}` : ''} · {fmtDateTime(p.handover.at)}<br />
                    <span className="faint">{p.handover.by}{p.handover.gate ? `, ${p.handover.gate}` : ''}{p.handover.reason ? ` · ${p.handover.reason}` : ''}{p.ackSentAt ? ' · recipient told' : ''}</span></dd></>
              )}
              {p.voidReason && <><dt>Voided</dt><dd>{p.voidReason}</dd></>}
            </dl>
            <PhotoRow srcs={p.photos} title={p.number} label="Parcel photo" />
            {p.signature && <div><h3 className="section-title">Signature</h3><img className="sign-saved" src={p.signature} alt={`Signature of ${p.handover?.to || 'the receiver'}`} /></div>}
            {p.handoverPhotos.length > 0 && <div><h3 className="section-title">{p.direction === 'out' ? 'Courier picker' : 'Handover'}</h3><PhotoRow srcs={p.handoverPhotos} title={p.number} label="Handover photo" /></div>}

            {mode === 'handover' && (
              <div className="return-form">
                <h3 className="section-title">Hand over</h3>
                {declined && <div className="alert alert-warn"><AlertTriangle /><span className="grow">The recipient declined this parcel. Hand it over only if they now confirm it is theirs.</span></div>}
                <div className="grid-2">
                  <label className="field"><span>Taken by (name)</span><input className="input" value={f.collector} onChange={set('collector')} maxLength={80} autoFocus /></label>
                  <label className="field"><span>Their mobile</span><input className="input num" inputMode="numeric" value={f.mobile} onChange={set('mobile')} maxLength={15} /></label>
                </div>
                <div className="field">
                  <span>Signature of the person taking it</span>
                  <SignaturePad value={signature} onChange={setSignature} label="Hand the tablet over: sign here with a finger" />
                </div>
                <div className="field">
                  <span>Photo <span className="faint">· optional</span></span>
                  <PhotoPicker photos={photos} onChange={setPhotos} max={3} addLabel="Take photo" onError={setErr} />
                </div>
                <input className="input" value={f.note} onChange={set('note')} placeholder="Remarks, e.g. department or room it went to" maxLength={200} />
                {err && <div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div>}
                {!handoverReady && !err && <p className="faint" style={{ fontSize: 13, margin: 0 }}>Enter the name and mobile number, and have them sign, to hand it over.</p>}
                <div className="row-end">
                  <button className="btn btn-ghost" onClick={() => setMode('')}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy || !handoverReady} onClick={() => post('collect', { collector: f.collector, mobile: f.mobile, signature, photos, note: f.note })}>{busy ? <Spinner /> : <CheckCircle2 />}Hand over</button>
                </div>
              </div>
            )}
            {mode === 'dispatch' && (
              <div className="return-form">
                <h3 className="section-title">Courier picker takes it</h3>
                <div className="grid-2">
                  <label className="field"><span>Picker’s name</span><input className="input" value={f.agent} onChange={set('agent')} maxLength={80} autoFocus /></label>
                  <label className="field"><span>Picker’s mobile <span className="faint">· optional</span></span><input className="input num" inputMode="numeric" value={f.mobile} onChange={set('mobile')} maxLength={15} /></label>
                  <label className="field"><span>Courier</span><select className="select" value={f.carrier} onChange={set('carrier')}><option value="">Choose</option>{CARRIERS.map((c) => <option key={c}>{c}</option>)}</select></label>
                  <div className="field"><span>Tracking / docket / AWB no.</span>
                    <div className="awb-row">
                      <input className="input mono" value={f.awb} onChange={set('awb')} maxLength={40} aria-label="Tracking number" />
                      <button type="button" className="btn" onClick={() => setScanning(true)}><Barcode />Scan</button>
                    </div>
                  </div>
                </div>
                <div className="field">
                  <span>Signature of the courier picker <span className="faint">· optional</span></span>
                  <SignaturePad value={signature} onChange={setSignature} label="Picker signs here with a finger" />
                </div>
                <div className="field">
                  <span>Photo of the picker <span className="faint">· optional</span></span>
                  <PhotoPicker photos={photos} onChange={setPhotos} max={3} addLabel="Take photo" onError={setErr} />
                </div>
                <input className="input" value={f.note} onChange={set('note')} placeholder="Remarks" maxLength={200} />
                {err && <div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div>}
                <div className="row-end">
                  <button className="btn btn-ghost" onClick={() => setMode('')}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy || f.agent.trim().length < 2 || !f.carrier || !f.awb.trim()} onClick={() => post('dispatch', { agent: f.agent, signature: signature || undefined, mobile: f.mobile || undefined, carrier: f.carrier, awb: f.awb, photos, note: f.note }, 'Dispatched.')}>{busy ? <Spinner /> : <Truck />}Dispatched</button>
                </div>
              </div>
            )}
            {(mode === 'return' || mode === 'void') && (
              <div className="return-form">
                <h3 className="section-title">{mode === 'return' ? 'Return to the courier' : 'Entered by mistake'}</h3>
                <input className="input" value={f.reason} onChange={set('reason')} placeholder={mode === 'return' ? 'Why, e.g. no such person, refused' : 'Why, e.g. scanned twice'} maxLength={200} autoFocus />
                {err && <div className="alert alert-bad"><AlertTriangle /><span className="grow">{err}</span></div>}
                <div className="row-end">
                  <button className="btn btn-ghost" onClick={() => setMode('')}>Cancel</button>
                  <button className="btn btn-danger" disabled={busy || f.reason.trim().length < (mode === 'void' ? 5 : 3)}
                    onClick={() => (mode === 'return' ? post('return', { reason: f.reason }, 'Returned to the courier.') : post('void', { reason: f.reason }, 'Voided.'))}>
                    {busy ? <Spinner /> : <Check />}{mode === 'return' ? 'Returned' : 'Void it'}
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
          {waiting && !declined && <button className="btn btn-ghost" onClick={() => start('return')}><Undo2 />Return</button>}
          {waiting && p.recipient.kind === 'host' && !declined && <button className="btn" disabled={busy} onClick={remind}><BellRing />{p.response ? 'Remind to collect' : 'Ask again'}</button>}
          {declined && <button className="btn" onClick={() => start('handover')}><ShieldAlert />Hand over anyway</button>}
          {declined && <button className="btn btn-primary" onClick={() => start('return')}><Undo2 />Return to courier</button>}
          {waiting && !declined && <button className="btn btn-primary" onClick={() => start('handover')}><Package />Hand over</button>}
          {p.status === 'booked' && <button className="btn btn-primary" onClick={() => start('dispatch')}><Truck />Courier took it</button>}
        </div>
      )}
      <BarcodeScan open={scanning} onClose={() => setScanning(false)} onResult={(text) => { setScanning(false); setF((x) => ({ ...x, awb: text.replace(/\s+/g, '').toUpperCase().slice(0, 40) })); }} />
    </Modal>
  );
}
