import { useEffect, useRef, useState } from 'react';

// Subscribes to the server change feed (SSE). Calls onChange for every event.
// Returns whether the stream is connected; EventSource reconnects on its own.
export function useLive(onChange) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let es = null;
    const open = () => {
      if (es) return;
      es = new EventSource('/api/events');
      let opened = false;
      // The server ends each stream every 90 s and the browser reconnects; refetch on every
      // reconnect so nothing that happened in the gap is missed.
      es.onopen = () => {
        setConnected(true);
        if (opened) cb.current({ type: 'resync' });
        opened = true;
      };
      es.onerror = () => setConnected(false);
      es.onmessage = (e) => {
        try { cb.current(JSON.parse(e.data)); } catch { /* malformed event */ }
      };
    };
    const close = () => { es?.close(); es = null; setConnected(false); };
    // A page kept in the back/forward cache would otherwise hold its stream open. Browsers allow
    // only 6 connections per site over HTTP/1.1, so a few cached pages can stall every new request.
    const onShow = (e) => { if (e.persisted) { open(); cb.current({ type: 'resync' }); } };
    open();
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', close);
      window.removeEventListener('pageshow', onShow);
      close();
    };
  }, []);
  return connected;
}

// Re-renders every `ms` so relative times ("12 min") stay current.
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
