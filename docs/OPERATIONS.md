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
- The first eight digits are blacked out on the device before upload. The server only stores the masked image.
- Calibrate `MASK_RECT` in `client/src/lib/aadhaarMask.js` once per camera and card layout: frame a real card, confirm the number is hidden, then adjust.
- Masked images are deleted after `ID_IMAGE_RETENTION_HOURS` (default 24). Admin views are audited.
- Confirm the retention period with your legal team under the DPDP Act 2023 before go-live.

## Audit and roles
- Every check-in, approval, rejection, checkout, force checkout, print, and ID image view is written to the `audits` collection.
- Restrict MongoDB write access so the audit collection cannot be edited by the application user.
