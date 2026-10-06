import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';

// Product mark: a gate arch with a check, drawn on a 32 grid.
export function Logo({ name = 'Visitor Desk', dark = false }) {
  return (
    <span className="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill={dark ? '#fff' : '#0b0d10'} />
        <path d="M9 24V14a7 7 0 0 1 14 0v10" fill="none" stroke={dark ? '#0b0d10' : '#fff'} strokeWidth="2.4" strokeLinecap="round" />
        <path d="m12.5 18.5 2.6 2.6 4.6-5" fill="none" stroke="#2fd0a2" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{name}</span>
    </span>
  );
}

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

export function Avatar({ src, name, size = 36, square = false }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`avatar ${square ? 'avatar-sq' : ''}`} style={{ '--s': `${size}px` }} aria-hidden="true">
      {src && !broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : initials(name)}
    </span>
  );
}

export const STATUS = {
  pending: ['Awaiting host', 'badge-warn'],
  approved: ['On premises', 'badge-live'],
  rejected: ['Declined', 'badge-bad'],
  expired: ['No response', ''],
  checked_out: ['Checked out', ''],
  force_checked_out: ['Force checked out', 'badge-warn'],
};
export function StatusBadge({ status }) {
  const [label, cls] = STATUS[status] || [status, ''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Spinner({ size = 16 }) {
  return <Loader2 className="spin" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && <div className="icon"><Icon /></div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs, { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200);
  }, []);
  const Icon = { ok: CheckCircle2, bad: AlertCircle, info: Info };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const I = Icon[t.tone] || Info;
          return <div key={t.id} className={`toast ${t.tone}`}><I />{t.text}</div>;
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Dialog / drawer on native <dialog> (focus trap + Esc for free) ----------
export function Modal({ open, onClose, children, className = 'dialog', label }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && <div className={className}>{children}</div>}
    </dialog>
  );
}
