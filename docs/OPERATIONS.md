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

## Mobile number verification (OTP)
- Admin -> Settings -> **Visitor mobile number**: Off (default), Optional (guard verifies or skips) or Required (only admins can skip).
- The guard taps **Send code** under the mobile field; MSG91 texts a 6-digit code to the visitor, who reads it out. Codes expire in 5 minutes, allow 3 tries, can be resent after 30 seconds, and are limited to 5 per number per hour and `OTP_DAILY_LIMIT` per day (a cap on SMS cost). Only a hash of the code is stored.
- Not asked again: expected visitors (the host gave the number) and numbers verified within `OTP_VERIFIED_DAYS` (90). A "skipped" or failed SMS never blocks a visitor in Optional mode; it is recorded as not verified.
- Set up: in MSG91 open **OTP**, add your DLT-approved OTP template, then in Render set `MSG91_AUTHKEY` and `MSG91_OTP_TEMPLATE_ID`. With no key the server runs in test mode and only writes the code to its log, so keep the setting Off until both are set.
- An OTP proves the visitor holds that phone, not who they are; the face match and the host's approval cover that.
- Privacy: MSG91 sees the visitor's mobile number and the code, nothing else. For a client that allows no outside call at all, keep this Off.

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

## Face match (photo vs Aadhaar card)
- On the guard's device, the live photo is compared with the face on the card (BlazeFace finds and straightens the face, SFace describes it). Models and the WebAssembly runtime are served from `/faces` on our own site (about 27 MB, downloaded once and cached; started while the guard types). Nothing is sent anywhere: the server stores only the score (0-100), never a face descriptor.
- The score is advice, never a decision: 70+ "looks like the same person", 50-69 "compare yourself", under 50 "faces do not look alike". If no face is found on the card or the photo, the guard is told and the visit goes ahead as usual.
- **Calibrate before relying on it.** The bands come from SFace's published threshold (cosine 0.363 = 50) and a small test (same person on a different photo scored cosine 0.45-0.73, different people up to 0.27). Aadhaar photos are small and old, so test about 50 real card/person pairs at your gate and adjust `COSINE` in `client/src/lib/faceMatch.js`.
- Face recognition is less accurate for some groups and in poor light; this is why it never admits or refuses anyone. Treat face data as sensitive personal data under the DPDP Act and mention it in your visitor notice.
- The model (`client/vendor/sface/`) is Apache-2.0 (OpenCV model zoo); the Human library is MIT; onnxruntime-web is MIT.

## Audit and roles
- Every check-in, approval, rejection, checkout, force checkout, print, and ID image view is written to the `audits` collection.
- Restrict MongoDB write access so the audit collection cannot be edited by the application user.
