import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Pencil, Upload } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Spinner } from './ui.jsx';

// One way to bring in a list, wherever a list is needed: upload an Excel or CSV file, or paste straight
// from Excel. Every line is checked first and shown with what will happen to it, so nothing is saved until
// the admin has seen it. Lines that cannot be added get a plain reason and can be downloaded, fixed and re-imported.
//
// endpoint: POST target; it answers { rows, errors } when sent dryRun: true, and saves without it.
// body:     extra fields sent with the list (a day, a host).  settings: the controls for those fields.
// columns:  [{ label, cell: (row) => node }] for the preview.  status: (row) => [label, badgeClass] for a line that is fine.
// template: CSV text offered as a ready-made sheet.  noun: ['host', 'hosts'].
export default function BulkImport({
  open, onClose, onDone, title, intro, endpoint, body = {}, ready = true, settings, columns, status, template, templateName, noun, placeholder, done,
}) {
  const [mode, setMode] = useState('file');
  const [text, setText] = useState('');
  const [source, setSource] = useState(null); // { file, filename } or { text }
  const [preview, setPreview] = useState(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setMode('file'); setText(''); setSource(null); setPreview(null); setResult(null); setErr(''); setOnlyProblems(false);
  }, [open]);

  const check = async (src) => {
    setBusy(true); setErr('');
    try {
      const r = await api(endpoint, { method: 'POST', body: { ...body, ...src, dryRun: true } });
      setSource(src);
      setPreview(r);
      setOnlyProblems(false);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const readFile = (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setErr('The file is larger than 5 MB.'); return; }
    const r = new FileReader();
    r.onload = () => check({ file: String(r.result).split(',')[1], filename: file.name });
    r.onerror = () => setErr('The file could not be read.');
    r.readAsDataURL(file);
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api(endpoint, { method: 'POST', body: { ...body, ...source } });
      setResult(r);
      onDone?.(r);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  const rows = preview?.rows || [];
  const problems = rows.filter((r) => r.action === 'error');
  const good = rows.length - problems.length;
  const willSave = rows.filter((r) => r.action === 'add' || r.action === 'update').length;
  const shown = onlyProblems ? problems : rows;
  const [one, many] = noun;
  const issues = result ? result.errors : problems;

  return (
    <Modal open={open} onClose={onClose} label={title} className="dialog dialog-wide">
      <div className="dialog-head">
        <h2>{title}</h2>
        {!preview && !result && <p>{intro}</p>}
        {preview && !result && <p>{problems.length ? 'Lines marked in red will be left out. Fix them in your sheet later, or go back and choose a corrected file.' : 'Every line is fine.'} Nothing is saved until you press {willSave ? `“Add ${willSave}”` : 'Add'}.</p>}
      </div>

      <div className="dialog-body">
        {result ? (
          <>
            <div className="alert alert-ok"><CheckCircle2 /><span className="grow">{done(result)}</span></div>
            {issues.length > 0 && (
              <div className="alert alert-warn">
                <AlertTriangle />
                <span className="grow">{issues.length} {issues.length === 1 ? 'line was' : 'lines were'} not added. Download them, fix the sheet and import it again: lines already added are recognised and not doubled.</span>
                <button type="button" className="btn btn-sm" onClick={() => downloadIssues(issues, title)}><Download />Download</button>
              </div>
            )}
          </>
        ) : preview ? (
          <>
            <div className="import-summary">
              <span className="import-stat ok"><strong className="num">{good}</strong> ready to add</span>
              <span className={`import-stat ${problems.length ? 'bad' : ''}`}><strong className="num">{problems.length}</strong> {problems.length === 1 ? 'needs' : 'need'} fixing</span>
              <span className="spacer-x" />
              {problems.length > 0 && (
                <div className="seg" role="group" aria-label="Show">
                  <button type="button" aria-pressed={!onlyProblems} onClick={() => setOnlyProblems(false)}>All lines</button>
                  <button type="button" aria-pressed={onlyProblems} onClick={() => setOnlyProblems(true)}>Only lines to fix</button>
                </div>
              )}
            </div>
            <div className="table-scroll import-preview">
              <table className="table">
                <thead><tr><th className="r">Line</th>{columns.map((c) => <th key={c.label}>{c.label}</th>)}<th>Result</th></tr></thead>
                <tbody>
                  {shown.slice(0, 300).map((r) => {
                    const [label, cls] = r.action === 'error' ? [r.error, 'badge-bad'] : status(r);
                    return (
                      <tr key={r.line} className={r.action === 'error' ? 'row-problem' : ''}>
                        <td className="r num faint">{r.line}</td>
                        {columns.map((c) => <td key={c.label}>{c.cell(r) || <span className="faint">—</span>}</td>)}
                        <td><span className={`badge ${cls}`}>{label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {shown.length > 300 && <p className="faint" style={{ fontSize: 12.5 }}>Showing the first 300 of {shown.length} lines. All of them are imported.</p>}
          </>
        ) : (
          <>
            {settings}
            <div className="seg" role="group" aria-label="How">
              <button type="button" aria-pressed={mode === 'file'} onClick={() => setMode('file')}><FileSpreadsheet size={15} />Upload a sheet</button>
              <button type="button" aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}><Pencil size={15} />Paste or type</button>
            </div>
            {mode === 'file' ? (
              <div className={`drop ${ready ? '' : 'is-off'}`} role="button" tabIndex={ready ? 0 : -1} aria-disabled={!ready}
                onClick={() => ready && !busy && fileRef.current?.click()}
                onKeyDown={(e) => { if (ready && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current?.click(); } }}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (ready) readFile(e.dataTransfer.files[0]); }}>
                {busy ? <Spinner /> : <Upload />}
                <strong>{busy ? 'Checking every line…' : 'Choose an Excel or CSV file'}</strong>
                <span className="faint">{ready ? 'or drop it here' : 'Fill in the details above first'}</span>
                <input ref={fileRef} type="file" hidden accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => { readFile(e.target.files[0]); e.target.value = ''; }} />
              </div>
            ) : (
              <label className="field"><span>Copy the rows from Excel and paste them here, one person per line.</span>
                <textarea className="textarea mono" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
              </label>
            )}
            {template && (
              <button type="button" className="link-btn" onClick={() => downloadText(template, `${templateName}.csv`)}>
                <Download size={13} />Download a ready-made sheet
              </button>
            )}
          </>
        )}
        {err && <div className="alert alert-bad" role="alert"><AlertTriangle /><span className="grow">{err}</span></div>}
      </div>

      <div className="dialog-foot">
        {result ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        ) : preview ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => { setPreview(null); setErr(''); }} disabled={busy}><ArrowLeft />Back</button>
            {problems.length > 0 && <button type="button" className="btn" onClick={() => downloadIssues(problems, title)}><Download />Download lines to fix</button>}
            <button type="button" className="btn btn-primary" disabled={busy || !willSave} onClick={save}>
              {busy ? <Spinner /> : <Upload />}{willSave ? `Add ${willSave} ${willSave === 1 ? one : many}` : 'Nothing ready to add'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            {mode === 'paste' && (
              <button type="button" className="btn btn-primary" disabled={busy || !text.trim() || !ready} onClick={() => check({ text })}>
                {busy ? <Spinner /> : <CheckCircle2 />}Check the lines
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function downloadText(text, name) {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadIssues(list, title) {
  const lines = [['Line', 'Name', 'Why it was not added'], ...list.map((x) => [x.line, x.name || x.fullName || '', x.error])];
  downloadText(lines.map((r) => r.map(csvCell).join(',')).join('\r\n'), `${title} - lines to fix.csv`);
}
