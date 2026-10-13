import { useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import GuardDesk from './pages/GuardDesk.jsx';
import Admin from './pages/Admin.jsx';
import Approve from './pages/Approve.jsx';
import { GuestPass, JoinGroup } from './pages/GuestPass.jsx';

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
    <Routes>
      <Route path="/approve/:token" element={<Approve />} />
      <Route path="/approve" element={<Approve />} />
      <Route path="/g/:code" element={<GuestPass />} />
      <Route path="/join/:code" element={<JoinGroup />} />
      <Route path="/login" element={user ? <Navigate to={home(user)} replace /> : <Login onLogin={setUser} />} />
      <Route path="/guard" element={user ? <GuardDesk user={user} onLogout={logout} /> : <Navigate to="/login" replace />} />
      <Route path="/admin" element={isAdmin(user) ? <Admin user={user} onLogout={logout} /> : <Navigate to={user ? '/guard' : '/login'} replace />} />
      <Route path="*" element={<Navigate to={user ? home(user) : '/login'} replace />} />
    </Routes>
  );
}
