import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
// Each screen loads on its own: a gate tablet never downloads the admin console, and a host's phone opening an
// approval link gets only that page.
const GuardDesk = lazy(() => import('./pages/GuardDesk.jsx'));
const Admin = lazy(() => import('./pages/Admin.jsx'));
const Approve = lazy(() => import('./pages/Approve.jsx'));
const GuestPass = lazy(() => import('./pages/GuestPass.jsx').then((m) => ({ default: m.GuestPass })));
const JoinGroup = lazy(() => import('./pages/GuestPass.jsx').then((m) => ({ default: m.JoinGroup })));
const ApproveMaterial = lazy(() => import('./pages/ApproveMaterial.jsx'));
const ParcelResponse = lazy(() => import('./pages/ParcelResponse.jsx'));

const isAdmin = (user) => user?.role === 'admin' || user?.role === 'superadmin';
const home = (user) => (isAdmin(user) ? '/admin' : '/guard');

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading
  const navigate = useNavigate();
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    api('/api/auth/me').then(setUser).catch(() => setUser(null));
  }, []);

  // Session ended mid-shift: back to sign-in with an explanation. The guard's draft form is kept in storage.
  useEffect(() => {
    const onExpired = () => {
      if (!userRef.current) return;
      setUser(null);
      navigate('/login', { replace: true, state: { expired: true } });
    };
    window.addEventListener('vms:session-expired', onExpired);
    return () => window.removeEventListener('vms:session-expired', onExpired);
  }, [navigate]);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    navigate('/login');
  };

  if (user === undefined) return <div className="splash"><Spinner size={22} /></div>;

  return (
    <Suspense fallback={<div className="splash"><Spinner size={22} /></div>}>
    <Routes>
      <Route path="/approve/:token" element={<Approve />} />
      <Route path="/approve" element={<Approve />} />
      <Route path="/g/:code" element={<GuestPass />} />
      <Route path="/approve-material/:token" element={<ApproveMaterial />} />
      <Route path="/parcel/:token" element={<ParcelResponse />} />
      <Route path="/join/:code" element={<JoinGroup />} />
      <Route path="/login" element={user ? <Navigate to={home(user)} replace /> : <Login onLogin={setUser} />} />
      <Route path="/guard" element={user ? <GuardDesk user={user} onLogout={logout} /> : <Navigate to="/login" replace />} />
      <Route path="/admin" element={isAdmin(user) ? <Admin user={user} onLogout={logout} /> : <Navigate to={user ? '/guard' : '/login'} replace />} />
      <Route path="*" element={<Navigate to={user ? home(user) : '/login'} replace />} />
    </Routes>
    </Suspense>
  );
}
