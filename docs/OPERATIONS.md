# Operations

## Setup
1. Copy `.env.example` to `.env`. Set `JWT_SECRET` (32+ random chars) and `MONGODB_URI`.
2. `cd server && npm install && npm run seed` (creates demo users and hosts; set `SEED_PASSWORD`).
3. `npm run dev` in `server/` (API :4000) and `npm run dev` in `client/` (UI :5173).
4. Production: `cd client && npm run build`, then `cd server && npm start`. The API serves `client/dist`.

## Camera needs HTTPS
Phones block the camera on plain HTTP. Put the app behind HTTPS (Nginx + Let's Encrypt) and set `APP_BASE_URL` and `COOKIE_SECURE=true`.

## SMS (India)
- Set `SMS_DRIVER=http`, `SMS_HTTP_URL`, `SMS_HTTP_AUTH`, `SMS_SENDER_ID`.
- The approval message must match a TRAI DLT-registered template. Register the template text in `server/src/routes/visits.js` (`issueApprovalLink`) before go-live, or messages are blocked.
- Failed SMS retry up to 5 times with backoff; failures show in the admin SMS and print outbox.

## Sticker printer
- Most LAN label printers accept ZPL on TCP 9100. Set `PRINTER_MODE=tcp`, `PRINTER_HOST`, `PRINTER_PORT`.
- Set `PRINTER_MODE=file` for testing; stickers are written to `print-out/`.
- Labels are ASCII only. Names in other scripts must be transliterated before printing.
- A failed print retries and then shows as failed. Reprint from the admin Live view.

## Daily pass number
The pass counter is keyed by the site-local date (`SITE_TIMEZONE`). A new day starts at 1 automatically. No cron job is needed.

## Aadhaar masking
- Everything happens on the guard's device before upload; the server only ever receives and stores the masked image.
- **Automatic:** after the shutter, on-device OCR (Tesseract, served from `/ocr` on our own site, about 7 MB downloaded once and cached) finds every Aadhaar number (4-4-4) and VID (4-4-4-4) on the card, wherever it is, and paints the first 8 digits (first 12 of a VID) solid black. It joins digits by position, so tilted cards work. A card that is already masked by UIDAI (XXXX XXXX 1234) is recognised. QR codes are painted black where the browser can detect them (Android Chrome); older letters carry the full number in the QR.
- **When unsure:** if the read is partial, the box is widened and the guard is asked to check. If nothing can be read, the fixed `MASK_RECT` area is painted and the guard is told. Calibrate `MASK_RECT` in `client/src/lib/aadhaarMask.js` once for your camera and card layout.
- **By hand:** the guard can drag to black out anything else ("Black out more", with Undo).
- The visit records how it was masked (`auto`, `already`, `guide`, plus `+manual`), shown in the admin's visit details.
- Retention is set in Admin → Settings (1 day to 1 year); older masked images are deleted automatically. Admin views are audited. Confirm the period with your legal team under the DPDP Act 2023.

## Audit and roles
- Every check-in, approval, rejection, checkout, force checkout, print, and ID image view is written to the `audits` collection.
- Restrict MongoDB write access so the audit collection cannot be edited by the application user.
