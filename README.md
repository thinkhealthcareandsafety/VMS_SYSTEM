# Visitor Desk

Gate check-in, host approval and a live roster of everyone on site.

**Guard desk** (phone or desktop)
- One-page check-in: mobile, name, gender, optional email, company, host, live photo, Aadhaar (first 8 digits masked on the device before upload).
- Face match: the live photo is compared with the face on the Aadhaar card on the guard's device, and the guard sees a score (advice only; only the score is saved).
- Optional mobile-number check: the visitor reads out a code texted to their phone (set in Admin → Settings; off by default).
- Returning visitors fill in from their mobile number; expected visitors are let in without waiting; blocked visitors are stopped with a "Do not admit" warning.
- Live "Waiting for host" list with a chime on every reply; resend or cancel inline.
- Visitor pass printed from the browser on any printer (80 mm receipt layout); printing is the handover. Every pass carries a QR code and a typed code (K7M2-9QXP).
- Scan in and out at any gate: one scan checks someone out if they are inside, or lets them back in on a valid multi-day pass. The photo shows big so the guard can compare faces; a mistaken scan can be undone for 30 seconds; a second scan within a minute changes nothing. Lost pass: type the pass number and pick the person by photo. Event passes scan the same way.

**Host approval**
- Telegram: one-time QR to connect, then Let them in / Decline buttons in the chat.
- Web link (by SMS once a provider is connected): photo, details and the same two buttons. Single-use, expires in 10 minutes.

**Admin console**
- Search everything from one box (Ctrl+K or /): visitors by name, mobile, visitor ID or today's pass number; hosts; events; staff; common actions.
- Overview with live numbers and arrivals by hour; on premises with force checkout, one by one or several at once (end-of-day check, with one reason saved on each record); searchable history with a per-visit timeline.
- Expected visitors one by one or imported from Excel / CSV / pasted rows (a day and host for the list, or Date and Host columns), with a line-by-line check before anything is saved; cancel several at once.
- Blocked visitors, hosts (Excel / CSV import that updates people already listed instead of adding them twice, Telegram connect), staff accounts, settings (site and gate name, Aadhaar retention).
- Events at the gate: tick a family or a team to let them in, or check them out, together.
- Downloads: an Excel sheet, or the full record (sheet, printable report, a folder per visitor with photo and masked Aadhaar).
- Audit log of every action, including each Aadhaar view and download.

**Code**
- `server/`: Express + MongoDB API, background worker (messages, expiry, Aadhaar purge), end-to-end tests: `cd server && npm test`.
- `client/`: React + Vite app (guard desk, host approval, admin console).
- `docs/DEPLOY.md`: Vercel + Render + MongoDB Atlas, and Telegram setup. `docs/OPERATIONS.md`: printers, SMS, retention.
