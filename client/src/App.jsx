import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import GuardDesk from './pages/GuardDesk.jsx';
import Admin from './pages/Admin.jsx';
import Approve from './pages/Approve.jsx';

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading
  const navigate = useNavigate();

  useEffect(() => {
    api('/api/auth/me').then(setUser).catch(() => setUser(null));
  }, []);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    navigate('/login');
  };

  if (user === undefined) return <div className="splash"><Spinner size={22} /></div>;

  return (
    <Routes>
      <Route path="/approve/:token" element={<Approve />} />
      <Route path="/login" element={user ? <Navigate to={user.role === 'admin' ? '/admin' : '/guard'} replace /> : <Login onLogin={setUser} />} />
      <Route path="/guard" element={user ? <GuardDesk user={user} onLogout={logout} /> : <Navigate to="/login" replace />} />
      <Route path="/admin" element={user?.role === 'admin' ? <Admin user={user} onLogout={logout} /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to={user ? (user.role === 'admin' ? '/admin' : '/guard') : '/login'} replace />} />
    </Routes>
  );
}
