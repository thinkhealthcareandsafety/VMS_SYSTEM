import { useEffect, useState } from 'react';
import { Mail, Printer } from 'lucide-react';
import { api, today } from '../api.js';
import { printDailyReport, REPORT_PARTS } from '../lib/dailyReport.js';
import { Modal, useToast } from './ui.jsx';

const addDays = (ymd, n) => { const t = new Date(`${ymd}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Pick a day and the registers, then print them on A4 for the paper file.
export function DailyReportDialog({ open, onClose }) {
  const toast = useToast();
  const [day, setDay] = useState(today());
  const [parts, setParts] = useState(REPORT_PARTS.map((p) => p.key));
  const [sending, setSending] = useState(false);
  useEffect(() => { if (open) setDay(today()); }, [open]);
  const toggle = (k) => setParts((ps) => (ps.includes(k) ? ps.filter((x) => x !== k) : REPORT_PARTS.map((p) => p.key).filter((x) => x === k || ps.includes(x))));
  const go = (e) => {
    e.preventDefault();
    printDailyReport({ day, parts, onError: (m) => toast(m, 'bad') });
    onClose();
  };
  // The whole report as a PDF to the addresses in Settings (the same one that goes out every night).
  const email = async () => {
    setSending(true);
    try {
      const r = await api('/api/reports/daily/email', { method: 'POST', body: { day } });
      toast(`Report emailed to ${r.to.join(', ')}.`);
      onClose();
    } catch (x) { toast(x.message, 'bad'); } finally { setSending(false); }
  };
  const t = today();
  return (
    <Modal open={open} onClose={onClose} label="Print daily report">
      <form onSubmit={go}>
        <div className="dialog-head"><h2>Print daily report</h2><p>A4 pages for the paper file, each with lines for signatures. Or email the day as a PDF to the people listed in Settings; it also goes to them by itself every night.</p></div>
        <div className="dialog-body">
          <div className="field"><span>Day</span>
            <div className="chips">
              <button type="button" className="chip" aria-pressed={day === t} onClick={() => setDay(t)}>Today</button>
              <button type="button" className="chip" aria-pressed={day === addDays(t, -1)} onClick={() => setDay(addDays(t, -1))}>Yesterday</button>
              <input className="input" type="date" max={t} value={day} onChange={(e) => setDay(e.target.value)} aria-label="Pick a day" style={{ maxWidth: 180 }} />
            </div>
          </div>
          <div className="field"><span>Registers</span>
            {REPORT_PARTS.map((p) => (
              <label key={p.key} className={`checkbox attest-lite ${parts.includes(p.key) ? 'on' : ''}`}>
                <input type="checkbox" checked={parts.includes(p.key)} onChange={() => toggle(p.key)} />
                <span><strong>{p.label}</strong></span>
              </label>
            ))}
          </div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={sending || !day || day > t} onClick={email}><Mail />{sending ? 'Sending…' : 'Email as PDF'}</button>
          <button className="btn btn-primary" disabled={!parts.length || !day || day > t}><Printer />{parts.length ? 'Print' : 'Pick a register'}</button>
        </div>
      </form>
    </Modal>
  );
}
