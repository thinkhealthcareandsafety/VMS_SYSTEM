// Aadhaar masking, enforced on the device before any image leaves the browser.
// All regions are card-relative (0..1 of the card width/height). The number sits on the front
// in three groups of four; the first two groups (first 8 digits) fall inside MASK_RECT.
// Calibrate MASK_RECT once with a real card on the actual camera and mount (see docs/OPERATIONS.md).
export const CARD_ASPECT = 85.6 / 54; // ISO/IEC 7810 ID-1 card
export const MASK_RECT = { x: 0.16, y: 0.6, w: 0.48, h: 0.2 };
export const GUIDE_WIDTH = 0.84; // guide box as a fraction of the camera frame width

// Maps the on-screen guide (object-fit: cover) back to source-video pixels and crops the card.
export function captureMaskedCard(video, container, maxWidth = 1000) {
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;

  const gw = cw * GUIDE_WIDTH;
  const gh = gw / CARD_ASPECT;
  const gx = (cw - gw) / 2;
  const gy = (ch - gh) / 2;

  const sx = (gx - ox) / scale;
  const sy = (gy - oy) / scale;
  const sw = gw / scale;
  const sh = gh / scale;

  const outW = Math.min(maxWidth, Math.round(sw));
  const outH = Math.round(outW / CARD_ASPECT);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);

  // Burn the mask into the pixels (solid fill, not blur, so the digits are not recoverable)
  ctx.fillStyle = '#000';
  ctx.fillRect(MASK_RECT.x * outW, MASK_RECT.y * outH, MASK_RECT.w * outW, MASK_RECT.h * outH);
  return canvas.toDataURL('image/jpeg', 0.8);
}
