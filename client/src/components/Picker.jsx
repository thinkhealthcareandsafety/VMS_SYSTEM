import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { today as siteToday } from '../api.js';

// The site's own dropdown and calendar, in place of the browser's: same look on every tablet, phone and PC,
// in the house style, with the keyboard working as people expect.

// ---------------------------------------------------------------- the pop-up both share
// Opens under the field, or above it when there is no room below; stays inside the screen. Rendered into the open
// dialog when the field sits in one (a dialog is drawn above everything, so a list outside it would be hidden).
function usePopover(open, anchorRef, popRef, onClose) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = popRef.current;
      if (!a || !p) return;
      const h = p.offsetHeight;
      const w = Math.max(p.offsetWidth, a.width);
      const below = window.innerHeight - a.bottom;
      const up = below < h + 12 && a.top > below;
      const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
      setPos({ left, top: up ? Math.max(8, a.top - h - 6) : a.bottom + 6, minWidth: a.width, up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, anchorRef, popRef]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!anchorRef.current?.contains(e.target) && !popRef.current?.contains(e.target)) onClose(); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open, anchorRef, popRef, onClose]);
  return pos;
}

function Popover({ open, anchorRef, popRef, onClose, className, children, ...rest }) {
  const pos = usePopover(open, anchorRef, popRef, onClose);
  if (!open) return null;
  const host = anchorRef.current?.closest('dialog[open]') || document.body;
  return createPortal(
    <div ref={popRef} className={`pick-pop ${className || ''}${pos?.up ? ' is-up' : ''}`} {...rest}
      // Measured first, off screen; transparent rather than hidden, so the calendar can take the keyboard focus at once.
      style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minWidth } : { left: -9999, top: 0, opacity: 0 }}>
      {children}
    </div>,
    host,
  );
}

// ---------------------------------------------------------------- dropdown
// options: [{ value, label, note? }]. onChange gets the value. Same keys as a native select: arrows, Home/End,
// Enter or Space to choose, Escape to close, and typing a letter jumps to the first option starting with it.
export function Select({ value, onChange, options, placeholder = 'Choose', disabled, className = '', id, ...aria }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(-1);
  const btn = useRef(null);
  const pop = useRef(null);
  const typed = useRef({ text: '', t: 0 });
  const listId = useId();
  const chosen = options.findIndex((o) => String(o.value) === String(value ?? ''));
  const current = options[chosen];

  const show = () => { if (disabled) return; setAt(chosen >= 0 ? chosen : 0); setOpen(true); };
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus({ preventScroll: true }); };
  const pick = (i) => { const o = options[i]; if (!o || o.disabled) return; close(); if (String(o.value) !== String(value ?? '')) onChange(o.value); };
  const step = (from, dir) => { let i = from; for (let n = 0; n < options.length; n++) { i = (i + dir + options.length) % options.length; if (!options[i].disabled) return i; } return from; };
  useEffect(() => { if (open) pop.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, at]);

  const onKey = (e) => {
    if (e.key === 'Tab') { if (open) close(false); return; }
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => step(i, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => step(i, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setAt(step(-1, 1)); }
    else if (e.key === 'End') { e.preventDefault(); setAt(step(options.length, -1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(at); }
    else if (e.key.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.t < 700 ? typed.current.text : '') + e.key.toLowerCase(), t: now };
      const hit = options.findIndex((o) => !o.disabled && String(o.label).toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setAt(hit);
    }
  };

  return (
    <>
      <button type="button" ref={btn} id={id} className={`input pick-btn ${className}`} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && at >= 0 ? `${listId}-${at}` : undefined}
        onClick={() => (open ? close() : show())} onKeyDown={onKey} {...aria}>
        <span className={`pick-value${current ? '' : ' is-empty'}`}>{current ? current.label : placeholder}</span>
        <ChevronDown className={`pick-chev${open ? ' up' : ''}`} aria-hidden />
      </button>
      <Popover open={open} anchorRef={btn} popRef={pop} onClose={() => close(false)} className="pick-list-pop">
        <ul className="pick-list" role="listbox" id={listId} aria-label={aria['aria-label']}>
          {options.map((o, i) => (
            <li key={String(o.value)} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={i === chosen} aria-disabled={o.disabled || undefined}
              className={`${i === at ? 'is-at' : ''}${o.disabled ? ' is-off' : ''}`}
              onPointerEnter={() => !o.disabled && setAt(i)} onClick={() => pick(i)}>
              <span className="pick-label">{o.label}{o.note && <small>{o.note}</small>}</span>
              {i === chosen && <Check className="pick-tick" aria-hidden />}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------- calendar
// Days are YYYY-MM-DD strings in the site's time, like the server's. All the arithmetic is on UTC noon, so no
// device clock or timezone can shift a day.
const toDate = (ymd) => new Date(`${ymd}T12:00:00Z`);
const ymdOf = (d) => d.toISOString().slice(0, 10);
const plusDays = (ymd, n) => { const d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return ymdOf(d); };
const monthOf = (ymd) => ymd.slice(0, 7);
const plusMonths = (ym, n) => { const d = new Date(`${ym}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return ymdOf(d).slice(0, 7); };
const VALID = /^\d{4}-\d{2}-\d{2}$/;
const fmt = (ymd, o) => toDate(ymd).toLocaleDateString('en-IN', { timeZone: 'UTC', ...o });
// "Fri, 23 Oct 2026"
const long = (ymd) => `${fmt(ymd, { weekday: 'short' })}, ${fmt(ymd, { day: 'numeric' })} ${fmt(ymd, { month: 'short' })} ${ymd.slice(0, 4)}`;
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// value: 'YYYY-MM-DD' or ''. min / max limit the days that can be picked. range: [first, last] of a pair of fields
// (First day / Last day), drawn as one band so the person sees the whole stretch.
export function DateInput({ value, onChange, min, max, required, placeholder = 'Pick a day', invalid, range, dataField, style, className = '', id, ...aria }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const pop = useRef(null);
  const t = siteToday();
  const ok = VALID.test(value || '');
  const inRange = (d) => (!min || d >= min) && (!max || d <= max);
  const start = ok ? value : inRange(t) ? t : min && t < min ? min : max || t;
  const [cursor, setCursor] = useState(start);
  const [view, setView] = useState('days');
  const [year, setYear] = useState(Number(start.slice(0, 4)));
  const show = () => { setCursor(start); setView('days'); setOpen(true); };
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus({ preventScroll: true }); };
  const pick = (d) => { if (!inRange(d)) return; close(); if (d !== value) onChange(d); };
  const month = monthOf(cursor);
  const canPrev = !min || plusMonths(month, -1) >= monthOf(min);
  const canNext = !max || plusMonths(month, 1) <= monthOf(max);

  // Six weeks from the Monday on or before the 1st: the grid never changes height between months.
  const days = useMemo(() => {
    const first = `${month}-01`;
    const back = (toDate(first).getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => plusDays(first, i - back));
  }, [month]);
  useEffect(() => { if (open && view === 'days') pop.current?.querySelector(`[data-day="${cursor}"]`)?.focus({ preventScroll: true }); }, [open, view, cursor]);

  const clamp = (d) => (min && d < min ? min : max && d > max ? max : d);
  const onGridKey = (e) => {
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (move) { e.preventDefault(); setCursor((c) => clamp(plusDays(c, move))); return; }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      setCursor((c) => { const m = plusMonths(monthOf(c), e.key === 'PageUp' ? -1 : 1); const d = `${m}-${String(Math.min(Number(c.slice(8)), new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).getUTCDate())).padStart(2, '0')}`; return clamp(d); });
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); setCursor((c) => clamp(plusDays(c, -((toDate(c).getUTCDay() + 6) % 7)))); return; }
    if (e.key === 'End') { e.preventDefault(); setCursor((c) => clamp(plusDays(c, 6 - ((toDate(c).getUTCDay() + 6) % 7)))); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(cursor); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const onPopKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };

  const [r0, r1] = range && VALID.test(range[0] || '') && VALID.test(range[1] || '') && range[0] < range[1] ? range : [];
  const quick = [[t, 'Today'], [plusDays(t, 1), 'Tomorrow'], [plusDays(t, -1), 'Yesterday']].filter(([d]) => inRange(d)).slice(0, 2);

  return (
    <>
      <button type="button" ref={btn} id={id} data-field={dataField} className={`input pick-btn date-btn ${className}`} style={style}
        aria-haspopup="dialog" aria-expanded={open} aria-invalid={invalid || undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); show(); }
          // Escape closes the calendar only, never the dialog around it.
          if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); }
        }} {...aria}>
        <CalendarDays className="date-ico" aria-hidden />
        <span className={`pick-value${ok ? '' : ' is-empty'}`}>{ok ? (value === t ? `Today · ${fmt(value, { day: 'numeric', month: 'short' })}` : long(value)) : placeholder}</span>
      </button>
      {/* So a form will not send without a required day, like the browser's own date field. */}
      {required && <input className="pick-required" tabIndex={-1} aria-hidden required value={ok ? value : ''} onChange={() => {}}
        onInvalid={(e) => { e.preventDefault(); show(); }} />}
      <Popover open={open} anchorRef={btn} popRef={pop} onClose={() => close(false)} className="cal-pop" role="dialog" aria-label={aria['aria-label'] || 'Pick a day'} onKeyDown={onPopKey}>
        <div className="cal-head">
          <button type="button" className="cal-nav" disabled={view === 'days' ? !canPrev : min && year <= Number(min.slice(0, 4))} aria-label={view === 'days' ? 'Previous month' : 'Previous year'}
            onClick={() => (view === 'days' ? setCursor((c) => clamp(`${plusMonths(monthOf(c), -1)}-01`)) : setYear((y) => y - 1))}><ChevronLeft /></button>
          <button type="button" className="cal-title" aria-label={view === 'days' ? 'Pick the month' : 'Back to the days'} onClick={() => { setYear(Number(cursor.slice(0, 4))); setView((v) => (v === 'days' ? 'months' : 'days')); }}>
            {view === 'days' ? fmt(`${month}-01`, { month: 'long', year: 'numeric' }) : year}
            <ChevronDown className={view === 'months' ? 'up' : ''} />
          </button>
          <button type="button" className="cal-nav" disabled={view === 'days' ? !canNext : max && year >= Number(max.slice(0, 4))} aria-label={view === 'days' ? 'Next month' : 'Next year'}
            onClick={() => (view === 'days' ? setCursor((c) => clamp(`${plusMonths(monthOf(c), 1)}-01`)) : setYear((y) => y + 1))}><ChevronRight /></button>
        </div>
        {view === 'days' ? (
          <div className="cal-grid" role="grid" onKeyDown={onGridKey}>
            {WEEK.map((w) => <span key={w} className="cal-wd" role="columnheader">{w.slice(0, 2)}</span>)}
            {days.map((d) => {
              const other = monthOf(d) !== month;
              const off = !inRange(d);
              const band = r0 && d >= r0 && d <= r1;
              const cls = ['cal-day', other && 'is-other', off && 'is-off', d === t && 'is-today', d === value && 'is-picked',
                band && 'in-band', band && d === r0 && 'band-start', band && d === r1 && 'band-end'].filter(Boolean).join(' ');
              return (
                <button type="button" key={d} data-day={d} className={cls} role="gridcell" disabled={off} tabIndex={d === cursor ? 0 : -1}
                  aria-selected={d === value} aria-current={d === t ? 'date' : undefined} aria-label={fmt(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  onClick={() => pick(d)}>{Number(d.slice(8))}</button>
              );
            })}
          </div>
        ) : (
          <div className="cal-months">
            {MONTHS.map((m, i) => {
              const ym = `${year}-${String(i + 1).padStart(2, '0')}`;
              const off = (min && ym < monthOf(min)) || (max && ym > monthOf(max));
              return (
                <button type="button" key={m} className={`cal-month${ym === month ? ' is-picked' : ''}${ym === monthOf(t) ? ' is-today' : ''}`} disabled={off}
                  onClick={() => { setCursor(clamp(`${ym}-${cursor.slice(8) > '28' ? '28' : cursor.slice(8)}`)); setView('days'); }}>{m}</button>
              );
            })}
          </div>
        )}
        <div className="cal-foot">
          {quick.map(([d, label]) => <button type="button" key={label} className={`chip${d === value ? ' is-on' : ''}`} aria-pressed={d === value} onClick={() => pick(d)}>{label}</button>)}
          <span className="grow" />
          {!required && ok && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { close(); onChange(''); }}>Clear</button>}
        </div>
      </Popover>
    </>
  );
}
