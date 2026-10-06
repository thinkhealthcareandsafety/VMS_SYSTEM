# Visitor Desk (MERN)

Guard check-in with live photo and masked Aadhaar, host approval by SMS link, daily pass numbers, sticker printing, checkout and force checkout, admin live view, history, outbox, hosts, and audit log.

- `server/`: Express + Mongoose API, background worker (SMS, print, expiry, ID image purge), end-to-end test.
- `client/`: React + Vite app (guard desk, host approval, admin console).
- `docs/OPERATIONS.md`: setup, HTTPS, SMS DLT, printer, Aadhaar calibration, retention.
- `PRODUCT.md`, `DESIGN.md`: product truth and visual system.

Test: `cd server && npm test` (uses an in-memory MongoDB).
