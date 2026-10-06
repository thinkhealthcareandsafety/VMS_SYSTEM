// Single fetch wrapper: cookies on every call, readable errors, network failures surfaced as one message.
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('No connection. Your entries are kept; try again.'), { network: true });
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

const TZ = 'Asia/Kolkata';
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '—');
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: TZ }) : '—');
export const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)}, ${fmtTime(iso)}` : '—');
export const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
export const fmtDuration = (mins) => (mins < 1 ? 'just now' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`);
export const fmtMobile = (m = '') => m.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');
