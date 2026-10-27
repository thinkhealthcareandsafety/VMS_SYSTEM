import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { COUNTRIES, FAVOURITES } from '../lib/countries.js';

// The country of a mobile number: a button with the code, opening a searchable list of every country.
// Type a name, an ISO code or digits ("44"); arrow keys and Enter choose; Escape or a click outside closes.
export default function CountryPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef(null);
  const listRef = useRef(null);
  const current = COUNTRIES.find((c) => c.iso === value) || COUNTRIES.find((c) => c.iso === 'IN');

  const list = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^\+/, '');
    if (!t) {
      const fav = FAVOURITES.map((iso) => COUNTRIES.find((c) => c.iso === iso));
      return [...fav, ...COUNTRIES.filter((c) => !FAVOURITES.includes(c.iso))];
    }
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(t) || c.iso.toLowerCase() === t || c.dial.slice(1).startsWith(t))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(t)) - Number(!b.name.toLowerCase().startsWith(t)));
  }, [q]);

  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => { listRef.current?.children[at]?.scrollIntoView({ block: 'nearest' }); }, [at, open]);

  const pick = (c) => { onChange(c); setOpen(false); setQ(''); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(list.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[at]) pick(list[at]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="cp" ref={box}>
      <button type="button" className="cp-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={`Country: ${current.name} ${current.dial}`} onClick={() => setOpen(!open)}>
        <span className="cp-iso">{current.iso}</span><span className="cp-dial">{current.dial}</span><ChevronDown />
      </button>
      {open && (
        <div className="cp-pop" role="dialog" aria-label="Choose the country">
          <div className="cp-search"><Search /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Search country or code" aria-label="Search country or code" /></div>
          <ul className="cp-list" role="listbox" ref={listRef}>
            {list.length === 0 && <li className="cp-empty">No country matches</li>}
            {list.map((c, i) => (
              <li key={c.iso} role="option" aria-selected={c.iso === current.iso} className={`${i === at ? 'is-at' : ''}${!q && i === FAVOURITES.length - 1 ? ' cp-sep' : ''}`}
                onPointerEnter={() => setAt(i)} onClick={() => pick(c)}>
                <span className="cp-iso">{c.iso}</span><span className="cp-name">{c.name}</span><span className="cp-code">{c.dial}</span>
                {c.iso === current.iso && <Check className="cp-tick" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
