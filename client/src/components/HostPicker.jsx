import { useEffect, useState } from 'react';
import { Search, Users } from 'lucide-react';
import { api } from '../api.js';
import { Avatar, Spinner } from './ui.jsx';

const MAX = 6;

// "Whom to meet": type-ahead over the resident/employee directory. Enter picks the top match.
// Guards never see host phone numbers.
export default function HostPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const term = q.trim();

  useEffect(() => {
    if (!term) { setRows(null); return undefined; }
    setLoading(true);
    const t = setTimeout(() => {
      api(`/api/hosts?q=${encodeURIComponent(term)}`)
        .then((d) => { setRows(d.rows.slice(0, MAX)); setError(''); })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }, 140);
    return () => clearTimeout(t);
  }, [term]);

  const pick = (h) => { onChange(h); setQ(''); };

  if (value) {
    return (
      <div className="host-picked">
        <Avatar name={value.name} size={40} />
        <span className="grow">
          <span className="name">{value.name}</span>
          <span className="unit">{value.unit}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="input-group">
        <Search />
        <input
          className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && rows?.length) { e.preventDefault(); pick(rows[0]); } }}
          placeholder="Type host name, flat or department" autoComplete="off" aria-label="Search hosts"
        />
        {loading && <span className="trail"><Spinner /></span>}
      </div>
      {error && <div className="alert alert-bad" role="alert">{error}</div>}
      {rows && (
        <div className="host-list" role="listbox" aria-label="Hosts">
          {rows.length === 0 && (
            <div className="host-none"><Users />No one matches. Try the flat number.</div>
          )}
          {rows.map((h, i) => (
            <button type="button" key={h.id} className="host-row" role="option" aria-selected={false} onClick={() => pick(h)}>
              <Avatar name={h.name} size={36} />
              <span className="grow">
                <span className="name">{h.name}</span>
                <span className="unit" style={{ display: 'block' }}>{h.unit}</span>
              </span>
              {i === 0 && <kbd className="enter-hint">Enter</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
