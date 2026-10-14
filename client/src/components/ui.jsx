import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';

// The two houses this desk serves. Marks: Marriott's M and the St. Regis monogram, divided by a silver hairline,
// with the house name beside them unless `name` is empty. `dark` uses the versions drawn for ink grounds.
export function Logo({ name = 'Marquis & St. Regis', dark = false }) {
  return (
    <span className={`cobrand${dark ? ' on-ink' : ''}`}>
      <img src="/brand/marquis-mark.png" alt="Marriott Marquis" />
      <span className="rule" aria-hidden="true" />
      <img className="sr" src={dark ? '/brand/stregis-mark-light.png' : '/brand/stregis-mark.png'} alt="St. Regis" />
      {name && <span className="name"><strong>{name}</strong><small>New Delhi</small></span>}
    </span>
  );
}

// Both full logos, as the hotels draw them: for the sign-in panel and the pages hosts and guests open.
export function Lockup({ dark = false }) {
  return (
    <span className="lockup" role="img" aria-label="Marriott Marquis New Delhi and St. Regis New Delhi">
      <img className="marquis" src={dark ? '/brand/marquis-light.png' : '/brand/marquis.png'} alt="" />
      <span className="rule" aria-hidden="true" />
      <img className="stregis" src={dark ? '/brand/stregis-light.png' : '/brand/stregis.png'} alt="" />
    </span>
  );
}

// Each screen names itself in the browser tab.
export function useTitle(title) {
  useEffect(() => { document.title = title ? `${title} · Marquis & St. Regis` : 'Marquis & St. Regis · New Delhi'; }, [title]);
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
  away: ['Out on pass', 'badge-ok'],
  rejected: ['Declined', 'badge-bad'],
  expired: ['No response', ''],
  cancelled: ['Cancelled', ''],
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
    if (open && !d.open) {
      d.showModal();
      // Native dialogs focus their first button; inputs that ask for focus keep it, buttons give it back to the dialog.
      if (document.activeElement?.tagName === 'BUTTON' && !document.activeElement.hasAttribute('autofocus')) d.focus({ preventScroll: true });
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-label={label}
      // React passes cancel up through nested dialogs; Escape closes only the top one.
      onCancel={(e) => { e.preventDefault(); if (e.target !== ref.current) return; e.stopPropagation(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && <div className={className}>{children}</div>}
    </dialog>
  );
}
