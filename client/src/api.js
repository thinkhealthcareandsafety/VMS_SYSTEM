// Single fetch wrapper: cookies on every call, readable errors, network failures surfaced as one message.
// A 401 on any signed-in call means the session ended (expiry, password reset, account switched off):
// the app listens for `vms:session-expired` and returns to sign-in instead of showing a wall of errors.
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
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    const err = Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/approvals/')) {
      window.dispatchEvent(new CustomEvent('vms:session-expired'));
    }
    throw err;
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
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
// "Pass 5" is only unique within a day; anything older carries its date.
export const passLabel = (v) => (v.dailyDay && v.dailyDay !== today() ? `${v.dailyNumber} · ${fmtDate(`${v.dailyDay}T12:00:00+05:30`)}` : String(v.dailyNumber));
export const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
export const secondsSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)) : 0);
