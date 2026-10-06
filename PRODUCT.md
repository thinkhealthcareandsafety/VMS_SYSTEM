# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated to the user's stated choice: MERN (MongoDB, Express, React with Vite). Server in `server/`, client in `client/`.

## Users
- Security guards at a gate or lobby: fast check-in on a phone or tablet, often on weak 3G/4G. Need speed and clarity under pressure.
- Hosts (residents, employees): approve or reject a visitor from an SMS link on a phone, with no login.
- Site admins: live view of who is inside, history search, force checkout, outbox health, audit trail. Desktop.

## Product Purpose
Replace paper visitor registers with a digital check-in: capture visitor, masked Aadhaar, live photo, host approval by SMS, daily numbered pass sticker, checkout, and admin oversight. Success: no visitor waits unattended, every exit is recorded, and personal data is minimised per the DPDP Act.

## Positioning
Built for Indian residential and corporate sites: Aadhaar masking happens on the device before upload, the daily pass number resets each day, and stickers print on a LAN label printer.

## Operating Context
Gate kiosk or guard tablet with a rear camera, a LAN label printer (ZPL, TCP 9100), SMS via a DLT-registered gateway. Admins work at a desk browser.

## Capabilities and Constraints
- Check-in, host approval link (single-use, 10 min), daily pass number 1..N per site day, checkout, admin force checkout with mandatory reason, history with filters and CSV, SMS and print outbox with reprint, host directory with CSV import, audit log.
- Camera requires HTTPS on mobile.
- Site name is a placeholder: "Visitor Desk" (set via SITE_NAME).
- Undecided: final brand identity, colour, typography.

## Brand Commitments
None confirmed. Visual direction is open.

## Evidence on Hand
No real content, testimonials, or assets yet. Do not invent customers or claims.

## Product Principles
- Guard speed beats visual flourish: every check-in step must be one clear action.
- Privacy by default: nothing unmasked leaves the device; admin views are audited.
- Admin sees truth in real time, and every override leaves a reason on record.
- Failure is visible, never silent: failed SMS and print jobs surface with a retry.

## Accessibility & Inclusion
Usable one-handed on a phone in daylight; high-contrast text; large tap targets (min 44px); works over slow connections (no heavy assets).
