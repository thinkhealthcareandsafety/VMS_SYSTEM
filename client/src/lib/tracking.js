// A courier label carries several codes: the tracking number, an order number, a routing or PIN code, a QR.
// The tracking number is the long one of letters and digits; a 6-digit PIN or a short code is never it.
// A QR with JSON or a link inside gives its AWB / waybill / tracking field when it has one.
export function pickTracking(values) {
  const clean = values.map((v) => fromQrPayload(String(v || '').trim())).filter(Boolean);
  const score = (v) => {
    const s = v.replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{6,40}$/i.test(s)) return 0;   // free text, a link, JSON without a tracking field
    if (/^\d{6}$/.test(s)) return 0;                // PIN code
    if ((s.match(/\d/g) || []).length < 4) return 0; // every tracking number carries digits; words do not
    let n = 10 + Math.min(s.length, 22);
    if (/^\d{8,20}$/.test(s) || /^[A-Z]{2,4}\d{8,}[A-Z]{0,3}$/i.test(s)) n += 20; // the shapes couriers use
    return n;
  };
  return clean.map((v) => [v, score(v)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
function fromQrPayload(v) {
  if (!/[{=?&:]/.test(v)) return v;
  const m = /(?:awb|waybill|way_bill|tracking(?:_?(?:no|number|id))?|shipment(?:_?id)?|consignment(?:_?no)?)["'\s]*[:=]\s*["']?([A-Z0-9-]{6,40})/i.exec(v);
  return m ? m[1] : v;
}
