# Design system: Visitor Desk

Source of truth: `client/src/styles.css` (tokens on `:root`). Mode: operate. Calm neutral ground, ink for primary actions, one teal accent for live state.

## Colour
- Ground `#f4f5f7`, surface `#ffffff`, sunken `#eef0f3`, border `#e3e6eb`.
- Ink `#0b0d10`: primary buttons, pass numbers, active chips.
- Teal accent `#00876a`: live state only (live dot, completed section, selected host, chart bars, focus ring).
- State: ok `#12704f`, bad `#b8322b`, warn `#965407`, each with a soft background. Every state also carries a text label; colour is never the only signal.

## Type
- Geist (400/500/600) and Geist Mono for visitor IDs and code. Tabular numerals on every counted, timed, or numbered value.
- Body 14px (guard app 15px, inputs 16px so phones do not zoom). Sentence case throughout.

## Components
- Buttons: primary (ink), success, danger, danger-outline, ghost; sizes sm 32px, default 38px, lg 48px, xl 56px (guard actions).
- Icons: Lucide, 16px in buttons, always next to a text label except well-known icon buttons with an `aria-label`.
- Pass: the one authored moment. Ink header with the daily number at display size.
- Tables: sticky header, hairline rows, clickable rows open the visit drawer. Numbers and IDs never wrap.
- Dialogs and the visit drawer use native `<dialog>` (focus trap and Esc for free).
- Charts: single series, one hue (teal), 4px rounded caps square at the baseline, solid hairline grid, hover tooltip, screen-reader table.

## Layout
- Guard: single-page check-in (Visitor, Whom to meet, Photo and Aadhaar) with a send bar that sticks to the bottom of the form column. Only one camera runs at a time.
- Admin: sidebar (Today / Records / Setup / Data) over sticky page header with the live indicator and Download. Under 860px the sidebar becomes a scrolling top strip.

## Motion
- Pass lands with a short ease-out; waiting ring pulses while the host decides. Everything is off under reduced motion.
