import { Fragment, useRef, useState } from 'react';

// A row of single-digit boxes backed by ONE real input laid invisibly over them. Typing, Backspace, paste,
// the numeric keypad and SMS code autofill all behave like a normal field; the boxes only show its value.
// `gapAfter`: box indexes followed by a small gap (e.g. [4] shows a mobile number as 98765 43210).
// `clean`: turns whatever was typed or pasted into the value (digits only, right length).
export default function DigitBoxes({
  length, value, onChange, clean, gapAfter = [], invalid = false, label, autoFocus, autoComplete = 'off', onEnter, inputRef, size = 'md',
}) {
  const own = useRef(null);
  const ref = inputRef || own;
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, length - 1); // where the next digit lands
  const tidy = clean || ((d) => d.slice(0, length));

  // Keep the caret at the end: the boxes have no visible selection, so editing always happens at the end.
  const toEnd = (el) => { const n = el.value.length; if (el.selectionStart !== n || el.selectionEnd !== n) el.setSelectionRange(n, n); };

  return (
    <div className={`digits digits-${size}${invalid ? ' is-invalid' : ''}${focused ? ' is-focused' : ''}`}>
      {Array.from({ length }, (_, i) => (
        <Fragment key={i}>
          <span className={`digit${value[i] ? ' is-filled' : ''}${focused && i === active ? ' is-active' : ''}`} aria-hidden="true">{value[i] || ''}</span>
          {gapAfter.includes(i) && <span className="digits-gap" aria-hidden="true" />}
        </Fragment>
      ))}
      <input
        ref={ref}
        className="digits-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-label={label}
        aria-invalid={invalid}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(tidy(e.target.value.replace(/\D/g, '')))}
        onFocus={(e) => { setFocused(true); toEnd(e.target); }}
        onBlur={() => setFocused(false)}
        onSelect={(e) => toEnd(e.target)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }}
      />
    </div>
  );
}

// Indian mobile: a pasted "+91 98765 43210" or "098765 43210" keeps just the 10-digit number.
export const cleanMobile = (d) => {
  if (d.length >= 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.slice(0, 10);
};
