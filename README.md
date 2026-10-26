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

- Pass validity chosen at check-in (2 hours to 30 days, or a date); any pass can be extended at the gate or in the console, recorded with who and why.
- Pass ended but still inside: a red bar and a pop-up on every guard desk and the admin console. The guard acknowledges it; an hour after the pass ended it is escalated to the host and the escalation contacts (Settings), and shows red on the console.

**Material inward register** (outward gate passes stay in the hotel's own gate pass system)
- Vendor arrives: photograph the invoice or challan (printed or handwritten); supplier name, address, mobile, GSTIN, invoice and challan numbers are read on the guard's device and checked by the guard. No invoice: type the supplier in. Items with item no., quantity and unit.
- Vendor leaves: photograph the invoice as the hotel stamped it, enter what was accepted per item (the rest is recorded as taken back), and who received it.
- Admin views: vendor inside, today, part taken back, no invoice or challan; Excel in the columns of the paper register.

**Couriers**
- Incoming: logged with up to 5 photos; the recipient gets the photo on WhatsApp (or Telegram, email) with Accept / Decline. Handover needs the collector's name, mobile and a photo; the recipient is then told who took it. Declined parcels are listed for return.
- Outgoing: name on the courier, address, sender and department; the picker's name, mobile, docket (AWB) number and photo when they take it.
- Excel: incoming and outgoing registers on their own sheets.

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
