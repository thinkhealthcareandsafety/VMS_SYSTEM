import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, Printer, Check, CheckCircle2, Download, FileText, Loader2, LogIn, LogOut, Package, Plus, ScanText, Search, Trash2, Truck, X,
} from 'lucide-react';
import { DailyReportDialog } from './DailyReport.jsx';
import { api, fmtDateTime, fmtMobile } from '../api.js';
import { PhotoPicker, PhotoRow } from './Photos.jsx';
import SignaturePad from './Signature.jsx';
import Camera from './Camera.jsx';
import { readInvoice, warmUpInvoiceReader } from '../lib/invoiceRead.js';
import { Empty, Modal, Spinner, useToast } from './ui.jsx';

// The material inward register. A vendor arrives: the guard photographs the invoice or challan (its details are read
// on the device and checked by the guard), or types the supplier in when there is none. When the vendor leaves, the
// guard records what was accepted and who received it, and that person signs on the tablet; the rest went back with them.
// Outward gate passes are not handled here: the hotel's own gate pass system does that.
const UNITS = ['nos', 'pcs', 'box', 'carton', 'set', 'pair', 'kg', 'g', 'litre', 'ml', 'metre', 'roll', 'bag', 'drum', 'bundle', 'packet'];
const VIEWS = [['atgate', 'Vendor inside'], ['today', 'Today'], ['short', 'Part taken back'], ['nodocs', 'No invoice or challan'], ['inward', 'All entries']];
const READ_LABEL = { company: 'supplier', address: 'address', gstin: 'GSTIN', mobile: 'mobile', invoice: 'invoice no.', challan: 'challan no.' };
const num = (n) => Math.round(n * 1000) / 1000;
const itemsLine = (m) => m.items.map((i) => `${i.qty} ${i.unit} ${i.name}`).join(', ');
const supplier = (p) => p?.company || p?.name || '—';
const docsLine = (d) => [d?.invoice && `Inv ${d.invoice}`, d?.dc && `Challan ${d.dc}`].filter(Boolean).join(' · ');

export function StatusBadge({ m }) {
  if (m.status === 'received') return <span className="badge badge-live">Vendor inside</span>;
  if (m.status === 'checked_out') return <span className={`badge ${m.takenBack ? 'badge-warn' : 'badge-ok'}`}>{m.takenBack ? 'Checked out · part taken back' : 'Checked out'}</span>;
  return <span className="badge">{m.statusLabel}</span>;
}

// ----------------------------------------------------------------------------- the register
export default function MaterialBoard({ admin = false, liveTick = 0, lanyard = false }) {
  const toast = useToast();
  const [view, setView] = useState(admin ? 'today' : 'atgate');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [report, setReport] = useState(false);

  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    const p = new URLSearchParams(term ? { q: term, view: 'inward' } : { view });
    api(`/api/material?${p}`).then(setData).catch(() => setData({ rows: [], counts: {} }));
  }, [view, term]);
  useEffect(() => { load(); }, [load, liveTick]);
  const c = data?.counts || {};

  return (
    <section className="panel material-board">
      <div className="toolbar">
        <div className="input-group field wide"><Search /><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Entry no., supplier, item, invoice, challan, vehicle, GSTIN" aria-label="Search material" /></div>
        <span className="spacer-x" />
        <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><ArrowDownToLine />Vendor arrived: record goods</button>
        {admin && <button className="btn btn-sm" onClick={() => setReport(true)}><Printer />Daily report</button>}
        {admin && <a className="btn btn-sm" href={`/api/material/export.xlsx?${new URLSearchParams(term ? { q: term, view: 'inward' } : { view })}`}><Download />Excel register</a>}
      </div>
      {!term && (
        <div className="material-views" role="tablist" aria-label="Registers">
          {VIEWS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>
              {l}{c[k] ? <span className="n">{c[k]}</span> : null}
            </button>
          ))}
        </div>
      )}
      {!data ? <div style={{ padding: 18 }}><div className="skeleton" style={{ height: 140, borderRadius: 12 }} /></div> : data.rows.length === 0 ? (
        <Empty icon={term ? Search : Package} title={term ? 'Nothing matches' : view === 'atgate' ? 'No vendor inside' : 'Nothing here'}>
          {term ? 'Try the entry number, the supplier or the invoice number.' : 'Press “Vendor arrived” when goods come in at the gate.'}
        </Empty>
      ) : (
        <ul className="material-list">
          {data.rows.map((m) => (
            <li key={m.id}>
              <button type="button" className="material-row" onClick={() => setOpenId(m.id)}>
                <span className={`material-dir ${m.direction}`}>{m.status === 'received' ? <LogIn /> : <LogOut />}</span>
                <span className="material-main">
                  <span className="material-top"><strong className="mono">{m.number}</strong><span className="faint">{supplier(m.party)}</span><StatusBadge m={m} /></span>
                  <span className="material-what">{itemsLine(m)}</span>
                  <span className="faint">
                    {docsLine(m.docs) || 'No invoice or challan'}{m.cardNo ? ` · card ${m.cardNo}` : ''}{m.department ? ` · ${m.department}` : ''}{m.vehicle?.number ? ` · ${m.vehicle.number}` : ''}
                    {` · in ${fmtDateTime(m.createdAt)}`}{m.checkedOutAt ? ` · out ${fmtDateTime(m.checkedOutAt)}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <InwardForm open={adding} lanyard={lanyard} units={data?.units || UNITS} onClose={() => setAdding(false)}
        onDone={(m) => { setAdding(false); toast(`${m.number} recorded. When the vendor leaves, open it and press Check out vendor.`); load(); setOpenId(m.id); }} />
      <MaterialDetail id={openId} liveTick={liveTick} onClose={() => setOpenId(null)} onChanged={load} />
      <DailyReportDialog open={report} onClose={() => setReport(false)} />
    </section>
  );
}

// ----------------------------------------------------------------------------- goods coming in
const ID_KINDS = [['aadhaar', 'Aadhaar'], ['pan', 'PAN'], ['dl', 'Licence'], ['voter', 'Voter ID'], ['other', 'Other']];
const blankItem = () => ({ code: '', name: '', qty: '1', unit: 'nos' });
const blank = () => ({
  items: [blankItem()], party: { company: '', name: '', address: '', mobile: '', gstin: '' }, docs: { invoice: '', dc: '' },
  department: '', vehicle: { number: '', driver: '' }, note: '', cardNo: '',
});

function InwardForm({ open, units, onClose, onDone, lanyard }) {
  const [f, setF] = useState(blank);
  const [docPhotos, setDocPhotos] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [face, setFace] = useState(null);       // live photo of the person who brought the goods
  const [idCard, setIdCard] = useState(null);   // their ID card, masked on this device (optional)
  const [idInfo, setIdInfo] = useState(null);
  const [idType, setIdType] = useState('aadhaar');
  const [cam, setCam] = useState(null);         // 'face' | 'id' | null
  const [reading, setReading] = useState(null); // null | 'busy' | { found: [...] } | { error }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const readFor = useRef(null);
  useEffect(() => {
    if (!open) return;
    setF(blank()); setDocPhotos([]); setPhotos([]); setReading(null); setErr('');
    setFace(null); setIdCard(null); setIdInfo(null); setIdType('aadhaar'); setCam('face');
    warmUpInvoiceReader();
  }, [open]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setIn = (k, sub, v) => setF((x) => ({ ...x, [k]: { ...x[k], [sub]: v } }));
  const setItem = (i, k, v) => setF((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) }));

  // Reads the invoice photo on this device and fills only the fields the guard has not typed.
  const read = async (src) => {
    readFor.current = src;
    setReading('busy');
    try {
      const r = await readInvoice(src);
      if (readFor.current !== src) return;
      const found = [];
      setF((x) => {
        const n = { ...x, party: { ...x.party }, docs: { ...x.docs } };
        const fill = (obj, key, val, label) => { if (val && !obj[key]) { obj[key] = val; found.push(label); } };
        fill(n.party, 'company', r.company, READ_LABEL.company);
        fill(n.party, 'address', r.address, READ_LABEL.address);
        fill(n.party, 'gstin', r.gstin, READ_LABEL.gstin);
        fill(n.party, 'mobile', r.mobile, READ_LABEL.mobile);
        fill(n.docs, 'invoice', r.invoice, READ_LABEL.invoice);
        fill(n.docs, 'dc', r.challan, READ_LABEL.challan);
        return n;
      });
      setReading({ found });
    } catch {
      if (readFor.current === src) setReading({ error: true });
    }
  };
  const onDocPhotos = (next) => {
    const first = !docPhotos.length && next.length;
    setDocPhotos(next);
    if (first) read(next[0]);
    if (!next.length) setReading(null);
  };

  const mobileOk = /^[6-9]\d{9}$/.test(f.party.mobile.replace(/\D/g, '').slice(-10));
  const personOk = f.party.name.trim().length >= 2 && mobileOk && Boolean(face);
  const ready = personOk && f.items.some((it) => it.name.trim()) && (f.party.company.trim() || f.party.name.trim());
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      onDone(await api('/api/material', {
        method: 'POST',
        body: {
          ...f, direction: 'in', kind: 'delivery', photos, docPhotos, personPhoto: face,
          ...(idCard ? { personIdImage: idCard, personIdType: idType } : {}),
          items: f.items.filter((it) => it.name.trim()).map((it) => ({ ...it, qty: Number(it.qty) })),
          party: { ...f.party, mobile: f.party.mobile || undefined },
        },
      }));
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} className="dialog dialog-wide" label="Goods coming in">
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2>Vendor check-in: goods coming in</h2>
          <p>Record the person bringing the goods, then photograph the invoice: its details fill in by themselves. No invoice? Type the supplier.</p>
        </div>
        <div className="dialog-body">
          <div className="person-block">
            <h3 className="section-title">Person bringing the goods</h3>
            <div className="grid-2">
              <label className="field"><span>Name</span><input className="input" value={f.party.name} onChange={(e) => setIn('party', 'name', e.target.value)} maxLength={80} autoFocus /></label>
              <label className="field"><span>Mobile</span><input className="input num" inputMode="numeric" value={f.party.mobile} onChange={(e) => setIn('party', 'mobile', e.target.value)} maxLength={15} placeholder="98765 43210" />
                {f.party.mobile && !mobileOk && <span className="hint err">Enter a 10-digit mobile number</span>}</label>
            </div>
            <div className="capture-grid">
              <div className="field">
                <span>Live photo</span>
                {face || cam === 'face'
                  ? <Camera mode="face" captured={face} onCapture={(p) => { setFace(p); setCam(null); }} onRetake={() => { setFace(null); setCam('face'); }} />
                  : <button type="button" className="cam-tile" onClick={() => setCam('face')}><Plus /><span>Take photo</span></button>}
              </div>
              <div className="field">
                <span>ID card <span className="faint">· optional{idType === 'aadhaar' ? ', first 8 digits blacked out' : ''}</span></span>
                <div className="chips" role="radiogroup" aria-label="Which ID">
                  {ID_KINDS.map(([k, l]) => <button type="button" key={k} className="chip" role="radio" aria-checked={idType === k} aria-pressed={idType === k} onClick={() => { if (k === idType) return; setIdType(k); setIdCard(null); setIdInfo(null); }}>{l}</button>)}
                </div>
                {idCard || cam === 'id'
                  ? <Camera mode="aadhaar" key={idType} idType={idType} idLabel={ID_KINDS.find(([k]) => k === idType)[1]} captured={idCard} info={idInfo} onCapture={(p, info) => { setIdCard(p); setIdInfo(info); setCam(null); }} onEdit={(p) => setIdCard(p)} onRetake={() => { setIdCard(null); setIdInfo(null); setCam('id'); }} />
                  : <button type="button" className="cam-tile" onClick={() => setCam('id')}><Plus /><span>Scan ID card</span></button>}
              </div>
            </div>
          </div>
          <div className="field">
            <span>Invoice or challan <span className="faint">· printed or handwritten, up to 4 photos</span></span>
            <PhotoPicker photos={docPhotos} onChange={onDocPhotos} max={4} addLabel="Photo of invoice" onError={setErr} />
            {reading === 'busy' && <div className="read-state"><Loader2 className="spin" />Reading the invoice on this device…</div>}
            {reading?.found && (reading.found.length
              ? <div className="read-state ok"><CheckCircle2 />Filled in: {reading.found.join(', ')}. Check them against the paper.</div>
              : <div className="read-state"><ScanText />Nothing could be read clearly. Type the details below.</div>)}
            {reading?.error && <div className="read-state"><AlertTriangle />This device could not read the photo. Type the details below.</div>}
            {docPhotos.length > 0 && reading !== 'busy' && <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => read(docPhotos[docPhotos.length - 1])}><ScanText />Read the last photo again</button>}
          </div>

          <div className="grid-2">
            <label className="field"><span>Supplier / company</span><input className="input" value={f.party.company} onChange={(e) => setIn('party', 'company', e.target.value)} placeholder="As on the invoice" maxLength={100} /></label>
            <label className="field"><span>GSTIN <span className="faint">· optional</span></span><input className="input mono" value={f.party.gstin} onChange={(e) => setIn('party', 'gstin', e.target.value.toUpperCase())} placeholder="07AABCU9603R1ZM" maxLength={15} /></label>
          </div>
          <label className="field"><span>Address <span className="faint">· optional</span></span><input className="input" value={f.party.address} onChange={(e) => setIn('party', 'address', e.target.value)} maxLength={200} /></label>
          <div className="grid-2">
            <label className="field"><span>Invoice no. <span className="faint">· optional</span></span><input className="input mono" value={f.docs.invoice} onChange={(e) => setIn('docs', 'invoice', e.target.value)} maxLength={40} /></label>
            <label className="field"><span>Challan no. <span className="faint">· optional</span></span><input className="input mono" value={f.docs.dc} onChange={(e) => setIn('docs', 'dc', e.target.value)} maxLength={40} /></label>
          </div>

          <div className="field">
            <span>Goods</span>
            <div className="items-editor">
              {f.items.map((it, i) => (
                <div className="item-row" key={i}>
                  <input className="input mono" placeholder="Item no." value={it.code} onChange={(e) => setItem(i, 'code', e.target.value)} maxLength={30} aria-label={`Item ${i + 1} number`} />
                  <input className="input" placeholder="Goods, e.g. Tomatoes" value={it.name} onChange={(e) => setItem(i, 'name', e.target.value)} maxLength={120} aria-label={`Item ${i + 1}`} />
                  <input className="input num" type="number" min="0" step="any" value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} aria-label="Quantity" />
                  <select className="select" value={it.unit} onChange={(e) => setItem(i, 'unit', e.target.value)} aria-label="Unit">{units.map((u) => <option key={u}>{u}</option>)}</select>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={f.items.length === 1} onClick={() => set('items', f.items.filter((_, j) => j !== i))} aria-label="Remove item"><Trash2 /></button>
                </div>
              ))}
              <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} disabled={f.items.length >= 50} onClick={() => set('items', [...f.items, blankItem()])}><Plus />Add item</button>
            </div>
          </div>

          <div className="grid-2">
            <label className="field"><span>For department <span className="faint">· optional</span></span><input className="input" value={f.department} onChange={(e) => set('department', e.target.value)} placeholder="Kitchen, Engineering, Stores…" maxLength={60} /></label>
            <label className="field"><span>Vehicle no. <span className="faint">· optional</span></span><input className="input mono" value={f.vehicle.number} onChange={(e) => setIn('vehicle', 'number', e.target.value.toUpperCase())} placeholder="DL 1L AB 1234" maxLength={20} /></label>
          </div>
          {lanyard && <label className="field" style={{ maxWidth: 260 }}><span>Vendor card no. <span className="faint">· the hotel lanyard card you hand over</span></span>
            <input className="input mono" value={f.cardNo} onChange={(e) => set('cardNo', e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10))} placeholder="e.g. 01" autoComplete="off" />
          </label>}
          <div className="field">
            <span>Photos of the goods <span className="faint">· optional, up to 3</span></span>
            <PhotoPicker photos={photos} onChange={setPhotos} max={3} onError={setErr} />
          </div>
          <label className="field"><span>Remarks <span className="faint">· optional</span></span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={300} /></label>
          {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
        </div>
        <div className="dialog-foot">
          {!ready && <span className="faint foot-hint">{!personOk ? 'Enter the person’s name and mobile, and take their photo.' : 'Enter the supplier and at least one item.'}</span>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !ready}>{busy ? <Spinner /> : <Check />}Check in vendor</button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------- one entry
function MaterialDetail({ id, liveTick, onClose, onChanged }) {
  const toast = useToast();
  const [m, setM] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const load = useCallback(() => { if (id) api(`/api/material/${id}`).then(setM).catch((e) => toast(e.message, 'bad')); }, [id, toast]);
  useEffect(() => { setM(null); setLeaving(false); load(); }, [load]);
  useEffect(() => { if (id && liveTick) load(); }, [liveTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = m?.status === 'checked_out';

  return (
    <Modal open={Boolean(id)} onClose={onClose} className="drawer" label="Material entry">
      <div className="drawer-head">
        <strong>{m ? `${m.number} · ${supplier(m.party)}` : 'Material'}</strong>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="drawer-body">
        {!m ? <div className="skeleton" style={{ height: 200, borderRadius: 12 }} /> : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StatusBadge m={m} /></div>
            {m.status === 'received' && !leaving && <div className="alert"><LogOut /><span className="grow">When the vendor leaves, press <strong>Check out vendor</strong>: enter what was accepted and who received it, and ask them to sign on the tablet.</span></div>}

            <table className="table items-table">
              <thead><tr><th>Item no.</th><th>Goods</th><th className="r">Came in</th>{done && <th className="r">Accepted</th>}{done && <th className="r">Taken back</th>}</tr></thead>
              <tbody>
                {m.items.map((i) => {
                  const back = i.acceptedQty == null ? 0 : num(i.qty - i.acceptedQty);
                  return (
                    <tr key={i.id}>
                      <td className="mono">{i.code || <span className="faint">—</span>}</td><td>{i.name}</td><td className="r num">{i.qty} {i.unit}</td>
                      {done && <td className="r num">{i.acceptedQty ?? i.qty} {i.unit}</td>}
                      {done && <td className={`r num ${back > 0 ? 'tone-warn' : ''}`}>{back > 0 ? `${back} ${i.unit}` : '—'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <dl className="dl">
              <dt>Supplier</dt><dd>{supplier(m.party)}{m.party?.company && m.party?.name ? ` · ${m.party.name}` : ''}{m.party?.mobile ? ` · ${fmtMobile(m.party.mobile)}` : ''}</dd>
              {m.party?.address && <><dt>Address</dt><dd>{m.party.address}</dd></>}
              {m.party?.gstin && <><dt>GSTIN</dt><dd className="mono">{m.party.gstin}</dd></>}
              <dt>Invoice / challan</dt><dd className="mono">{docsLine(m.docs) || <span className="faint">None given</span>}</dd>
              {m.department && <><dt>For</dt><dd>{m.department}</dd></>}
              {m.cardNo && <><dt>Vendor card</dt><dd className="mono">{m.cardNo}</dd></>}
              {m.vehicle?.number && <><dt>Vehicle</dt><dd className="mono">{m.vehicle.number}{m.vehicle.driver ? ` · ${m.vehicle.driver}` : ''}</dd></>}
              {m.note && <><dt>Remarks</dt><dd>{m.note}</dd></>}
              <dt>Recorded</dt><dd>{m.createdBy} · {fmtDateTime(m.createdAt)}</dd>
              {m.receivedBy && <><dt>Received by</dt><dd>{[m.receivedBy.department, m.receivedBy.name].filter(Boolean).join(' · ')}</dd></>}
              {m.exitNote && <><dt>At checkout</dt><dd>{m.exitNote}</dd></>}
              {m.handedTo && <><dt>Handed to</dt><dd>{m.handedTo} · {fmtDateTime(m.handedAt)}</dd></>}
            </dl>

            {(m.personPhoto || m.personIdImage) && (
              <div><h3 className="section-title">Person who brought it: {m.party?.name}{m.party?.mobile ? ` · ${fmtMobile(m.party.mobile)}` : ''}</h3>
                <PhotoRow srcs={[m.personPhoto, m.personIdImage].filter(Boolean)} title={m.party?.name || m.number} label="Person" />
              </div>
            )}
            {m.docPhotos.length > 0 && <div><h3 className="section-title"><FileText size={15} /> Invoice / challan as it came</h3><PhotoRow srcs={m.docPhotos} title={m.number} label="Invoice" /></div>}
            {m.signature && <div><h3 className="section-title">Signature of {m.receivedBy?.name || 'the receiver'}</h3><img className="sign-saved" src={m.signature} alt={`Signature of ${m.receivedBy?.name || 'the receiver'}`} /></div>}
            {m.exitPhotos.length > 0 && <div><h3 className="section-title"><FileText size={15} /> Invoice as stamped by the hotel</h3><PhotoRow srcs={m.exitPhotos} title={m.number} label="Stamped invoice" /></div>}
            {m.photos.length > 0 && <div><h3 className="section-title"><Package size={15} /> Goods</h3><PhotoRow srcs={m.photos} title={m.number} label="Goods" /></div>}
            {m.movements.length > 0 && (
              <div>
                <h3 className="section-title"><Truck size={15} /> Through the gate</h3>
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
            {leaving && <CheckoutForm m={m} onCancel={() => setLeaving(false)} onDone={(next) => { setM(next); setLeaving(false); onChanged(); toast(`${next.number}: vendor checked out${next.takenBack ? ' with part of the goods' : ''}.${next.cardNo ? ` Collect vendor card ${next.cardNo}.` : ''}`); }} />}
          </>
        )}
      </div>
      {m && m.status === 'received' && m.kind === 'delivery' && !leaving && (
        <div className="drawer-foot">
          <button className="btn btn-primary" onClick={() => setLeaving(true)}><LogOut />Check out vendor</button>
        </div>
      )}
    </Modal>
  );
}

// The vendor leaves: what the hotel accepted (the rest goes back), who received it, and their signature on the tablet.
function CheckoutForm({ m, onCancel, onDone }) {
  const [kept, setKept] = useState(() => Object.fromEntries(m.items.map((i) => [i.id, String(i.qty)])));
  const [by, setBy] = useState({ department: m.department || '', name: '' });
  const [signature, setSignature] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bad = m.items.some((i) => kept[i.id] === '' || Number(kept[i.id]) < 0 || Number(kept[i.id]) > i.qty);
  const ready = !bad && (by.department.trim() || by.name.trim()) && signature;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      onDone(await api(`/api/material/${m.id}/checkout`, { method: 'POST', body: { receivedBy: by, items: m.items.map((i) => ({ item: i.id, accepted: Number(kept[i.id]) })), signature, note } }));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="return-form">
      <h3 className="section-title">Check out vendor</h3>
      {m.cardNo && <div className="alert alert-warn"><AlertTriangle /><span className="grow">Collect vendor card <strong>{m.cardNo}</strong> before they leave.</span></div>}
      <div className="field">
        <span>Accepted by the hotel <span className="faint">· the rest goes back with the vendor</span></span>
        {m.items.map((i) => {
          const back = num(i.qty - (Number(kept[i.id]) || 0));
          return (
            <label key={i.id} className="return-line">
              <span className="grow">{i.name}<span className="faint"> · {i.qty} {i.unit} came in{back > 0 && kept[i.id] !== '' ? ` · ${back} ${i.unit} goes back` : ''}</span></span>
              <input className="input num" type="number" min="0" step="any" max={i.qty} value={kept[i.id]} onChange={(e) => setKept({ ...kept, [i.id]: e.target.value })} aria-label={`${i.name} accepted`} aria-invalid={Number(kept[i.id]) > i.qty || undefined} />
            </label>
          );
        })}
      </div>
      <div className="grid-2">
        <label className="field"><span>Received by (department)</span><input className="input" value={by.department} onChange={(e) => setBy({ ...by, department: e.target.value })} maxLength={60} /></label>
        <label className="field"><span>Received by (name)</span><input className="input" value={by.name} onChange={(e) => setBy({ ...by, name: e.target.value })} maxLength={80} /></label>
      </div>
      <div className="field">
        <span>Signature of the person receiving the goods</span>
        <SignaturePad value={signature} onChange={setSignature} label="Hand the tablet over: sign here with a finger" />
      </div>
      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Remarks, e.g. 50 kg tomatoes rejected: not fresh" maxLength={300} />
      {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
      {!ready && !err && <p className="faint" style={{ fontSize: 13, margin: 0 }}>{bad ? 'An accepted quantity is more than came in.' : !(by.department.trim() || by.name.trim()) ? 'Enter who received it.' : 'Ask them to sign on the tablet.'}</p>}
      <div className="row-end">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={save}>{busy ? <Spinner /> : <CheckCircle2 />}Check out vendor</button>
      </div>
    </div>
  );
}
