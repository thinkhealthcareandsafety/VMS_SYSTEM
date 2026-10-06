# Visitor Desk

Gate check-in, host approval and a live roster of everyone on site.

**Guard desk** (phone or desktop)
- One-page check-in: mobile, name, company, host, live photo, Aadhaar (first 8 digits masked on the device before upload).
- Returning visitors fill in from their mobile number; expected visitors are let in without waiting; blocked visitors are stopped with a "Do not admit" warning.
- Live "Waiting for host" list with a chime on every reply; resend or cancel inline.
- Visitor pass printed from the browser on any printer (80 mm receipt layout); printing is the handover.

**Host approval**
- Telegram: one-time QR to connect, then Let them in / Decline buttons in the chat.
- Web link (by SMS once a provider is connected): photo, details and the same two buttons. Single-use, expires in 10 minutes.

**Admin console**
- Overview with live numbers and arrivals by hour; on premises with force checkout; searchable history with a per-visit timeline.
- Expected visitors, blocked visitors, hosts (CSV import, Telegram connect), staff accounts, settings (site and gate name, Aadhaar retention).
- Downloads: an Excel sheet, or the full record (sheet, printable report, a folder per visitor with photo and masked Aadhaar).
- Audit log of every action, including each Aadhaar view and download.

**Code**
- `server/`: Express + MongoDB API, background worker (messages, expiry, Aadhaar purge), end-to-end tests: `cd server && npm test`.
- `client/`: React + Vite app (guard desk, host approval, admin console).
- `docs/DEPLOY.md`: Vercel + Render + MongoDB Atlas, and Telegram setup. `docs/OPERATIONS.md`: printers, SMS, retention.
